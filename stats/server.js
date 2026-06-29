'use strict';
/*
 * ghostdev-stats — tiny JSON backend for the GHOST.dev web terminal.
 *
 * Serves three endpoints on 127.0.0.1:<port> (default 9090), proxied under /api/ by nginx:
 *   GET /stats     -> live machine stats (CPU/MEM/disk) + IPs + node label
 *   GET /sessions  -> list of tmux sessions, each annotated with the Claude state of its pane
 *   GET /kill?s=   -> kill a tmux session by name
 *
 * No external dependencies (Node stdlib only). No secrets: everything is configured through
 * environment variables — see .env.example. The optional Proxmox host-stats module uses a
 * READ-ONLY API token (never a root password). It is OFF by default.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config (all via env, with safe defaults)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.GHOSTDEV_STATS_PORT || '9090', 10);
const BIND = process.env.GHOSTDEV_STATS_BIND || '127.0.0.1';
const NODE_LABEL = process.env.GHOSTDEV_NODE_LABEL || os.hostname();
const SHOW_PUBLIC_IP = (process.env.GHOSTDEV_SHOW_PUBLIC_IP || 'true') !== 'false';

// tmux ownership: by default we talk to tmux as the user running this process.
// If GHOSTDEV_TMUX_USER is set (and we are root), we drop to it via runuser. This is only
// needed when the stats server and the terminal run as different users (uncommon).
const TMUX_USER = process.env.GHOSTDEV_TMUX_USER || '';

// Optional Proxmox host-stats module (OFF by default). READ-ONLY API token only.
const PVE_ENABLED = (process.env.GHOSTDEV_PROXMOX_ENABLED || 'false') === 'true';
const PVE_HOST = process.env.GHOSTDEV_PROXMOX_HOST || '';
const PVE_TOKEN_ID = process.env.GHOSTDEV_PROXMOX_TOKEN_ID || '';      // e.g. ghostdev@pve!stats
const PVE_TOKEN_SECRET = process.env.GHOSTDEV_PROXMOX_TOKEN_SECRET || '';
const PVE_NODE = process.env.GHOSTDEV_PROXMOX_NODE || '';             // optional; auto-detected if empty

// ---------------------------------------------------------------------------
// Claude state detection (the headline feature).
// Heuristic over the visible tmux pane. Claude's spinner verbs change between releases, so
// these regexes are intentionally easy to find and edit. See docs/claude-status.md.
//   perms -> Claude is blocked asking for permission (needs your approval)
//   busy  -> Claude is working (generating / running tools)
//   input -> Claude is idle at an empty prompt, waiting for your message
//   ended -> Claude is no longer running in the session (back at the shell)
// ---------------------------------------------------------------------------
const RE_PERMS = /Do you want to (?:proceed|make|create|run|allow|apply|edit|overwrite|delete)|Yes, and don'?t ask again|No, and tell Claude|❯\s*\d+\.\s*(?:Yes|Allow)\b/i;
const RE_BUSY = /esc to interrupt|[↓↑]\s*[\d.,]+\s*k?\s*tokens|[✽✻✶✳✺✢✷✸✹]\s*\w+…|\b(?:Calculating|Thinking|Compacting|Forging|Pondering|Working|Running|Herding|Cooking|Brewing|Synthesizing|Channelling|Crafting)…/;
const RE_READY = /^\s*❯\s*$/m; // empty prompt ready = Claude finished and waits for your message

function readFirst(path) { try { return fs.readFileSync(path, 'utf8'); } catch (e) { return ''; } }

// ---- local IPv4 (first non-internal) ----
function localIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

// ---- local CPU% (delta of /proc/stat) ----
let prevCpu = null;
function localCpu() {
  const line = readFirst('/proc/stat').split('\n')[0];
  const p = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (p[3] || 0) + (p[4] || 0);
  const total = p.reduce((a, b) => a + b, 0);
  let pct = 0;
  if (prevCpu) {
    const dt = total - prevCpu.total, di = idle - prevCpu.idle;
    if (dt > 0) pct = Math.max(0, Math.min(100, (1 - di / dt) * 100));
  }
  prevCpu = { total, idle };
  return Math.round(pct);
}
// ---- local MEM (cgroup v2 if limited, else /proc/meminfo) ----
function localMem() {
  const cur = parseInt(readFirst('/sys/fs/cgroup/memory.current'), 10);
  const max = parseInt(readFirst('/sys/fs/cgroup/memory.max'), 10);
  if (!max || isNaN(max) || isNaN(cur)) { // no limit -> host memory
    const mi = readFirst('/proc/meminfo');
    const tot = (mi.match(/MemTotal:\s+(\d+)/) || [])[1] * 1024;
    const av = (mi.match(/MemAvailable:\s+(\d+)/) || [])[1] * 1024;
    return { used: tot - av, total: tot };
  }
  return { used: cur, total: max };
}
// ---- local STORAGE (df /) ----
function localDisk() {
  try {
    const out = execSync('df -kP /', { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/);
    return { used: parseInt(out[2], 10) * 1024, total: parseInt(out[1], 10) * 1024 };
  } catch (e) { return { used: 0, total: 0 }; }
}

// ---------------------------------------------------------------------------
// Optional Proxmox host stats (READ-ONLY API token; OFF unless GHOSTDEV_PROXMOX_ENABLED=true)
// ---------------------------------------------------------------------------
function pveReq(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: PVE_HOST, port: 8006, method, path: '/api2/json' + path,
      rejectUnauthorized: false, timeout: 6000,
      headers: { Authorization: `PVEAPIToken=${PVE_TOKEN_ID}=${PVE_TOKEN_SECRET}` }
    }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b).data); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}
let pveNode = PVE_NODE || null;
async function hostStats() {
  if (!pveNode) { const nodes = await pveReq('GET', '/nodes'); pveNode = (nodes && nodes[0] && nodes[0].node) || 'pve'; }
  const s = await pveReq('GET', `/nodes/${pveNode}/status`);
  return {
    cpu: Math.round((s.cpu || 0) * 100),
    mem: { used: s.memory.used, total: s.memory.total },
    disk: { used: s.rootfs.used, total: s.rootfs.total },
    node: pveNode
  };
}

// ---- public IP (cached 5 min; opt-out with GHOSTDEV_SHOW_PUBLIC_IP=false) ----
let pubIp = null, pubAt = 0;
function refreshPubIp() {
  if (!SHOW_PUBLIC_IP) return;
  if (pubAt && Date.now() - pubAt < 5 * 60 * 1000) return;
  pubAt = Date.now();
  https.get('https://api.ipify.org', { timeout: 5000 }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { if (/^[0-9.]+$/.test(b.trim())) pubIp = b.trim(); }); }).on('error', () => {});
}

// ---------------------------------------------------------------------------
// tmux session management (as this process's user, or runuser if configured)
// ---------------------------------------------------------------------------
const SESS_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;
function tmux(args) {
  if (TMUX_USER && process.getuid && process.getuid() === 0) {
    return execFileSync('/usr/sbin/runuser', ['-u', TMUX_USER, '--', 'tmux'].concat(args),
      { encoding: 'utf8', maxBuffer: 1 << 20 });
  }
  return execFileSync('tmux', args, { encoding: 'utf8', maxBuffer: 1 << 20 });
}

function claudeState(sess) {
  let cmds = [];
  try { cmds = tmux(['list-panes', '-t', sess, '-F', '#{pane_current_command}']).split('\n').filter(Boolean); }
  catch (e) { return 'ended'; }
  const alive = cmds.some((c) => c === 'claude' || c === 'node');
  if (!alive) return 'ended';
  let txt = '';
  try { txt = tmux(['capture-pane', '-p', '-t', sess]); } catch (e) { return 'busy'; }
  txt = txt.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  if (RE_PERMS.test(txt)) return 'perms';
  if (RE_BUSY.test(txt)) return 'busy';
  if (RE_READY.test(txt)) return 'input';
  return 'busy';
}

function listSessions() {
  try {
    const out = tmux(['ls', '-F', '#{session_name}\t#{session_windows}\t#{?session_attached,1,0}']);
    return out.trim().split('\n').filter(Boolean).map((l) => {
      const p = l.split('\t');
      return { name: p[0], windows: parseInt(p[1], 10) || 1, attached: p[2] === '1', claude: claudeState(p[0]) };
    });
  } catch (e) { return []; } // "no server running" -> no sessions
}
function killSession(s) {
  if (!SESS_RE.test(s)) return { ok: false, error: 'invalid session name' };
  try {
    tmux(['kill-session', '-t', s]);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.stderr || e.message || 'error').trim() }; }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];

  if (path === '/sessions') return sendJson(res, 200, listSessions());

  if (path === '/kill') {
    const m = (req.url.split('?')[1] || '').match(/(?:^|&)s=([^&]*)/);
    const s = m ? decodeURIComponent(m[1]) : '';
    const r = killSession(s);
    return sendJson(res, r.ok ? 200 : (SESS_RE.test(s) ? 500 : 400), r);
  }

  if (path === '/stats') {
    refreshPubIp();
    const ips = { ct: localIp() };
    if (SHOW_PUBLIC_IP) ips.public = pubIp || '–';
    const out = { label: NODE_LABEL, ct: { cpu: localCpu(), mem: localMem(), disk: localDisk() }, ips, ts: Date.now() };
    if (PVE_ENABLED && PVE_HOST && PVE_TOKEN_ID && PVE_TOKEN_SECRET) {
      try { out.host = await hostStats(); ips.host = PVE_HOST; }
      catch (e) { out.host = { error: true }; }
    }
    return sendJson(res, 200, out);
  }

  res.writeHead(404); res.end('nf');
});
server.listen(PORT, BIND, () => console.log(`ghostdev-stats on ${BIND}:${PORT} (label=${NODE_LABEL}, proxmox=${PVE_ENABLED})`));
