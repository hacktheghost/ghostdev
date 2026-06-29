'use strict';
/*
 * ghostdev-stats — tiny JSON backend for the GHOST.dev web terminal.
 *
 * Serves on 127.0.0.1:<port> (default 9090), proxied under /api/ by nginx:
 *   GET  /stats           live machine stats (CPU/MEM/disk) + IPs + node label
 *   GET  /sessions        tmux sessions, each annotated with the Claude state of its pane
 *   GET  /kill?s=         kill a tmux session by name
 *   --- file explorer (confined to GHOSTDEV_FILES_ROOT) ---
 *   GET  /fs/list?path=   directory listing
 *   GET  /fs/read?path=   read/download a file (&dl=1 forces download)
 *   POST /fs/upload       { path, name, b64 }  upload a file (base64)
 *   POST /fs/save         { path, content }    write a text file
 *   POST /fs/mkdir        { path, name }        create a folder
 *   POST /fs/rename       { path, to }          rename within its folder
 *   POST /fs/delete       { path }              delete a file or folder (recursive)
 *   POST /fs/fetch-url    { path, url }          download a remote URL into a folder
 *
 * No external dependencies (Node stdlib only). No secrets: everything is configured through
 * environment variables — see .env.example. The optional Proxmox host-stats module uses a
 * READ-ONLY API token (never a root password) and is OFF by default.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const P = require('path');
const { execSync, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config (all via env, with safe defaults)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.GHOSTDEV_STATS_PORT || '9090', 10);
const BIND = process.env.GHOSTDEV_STATS_BIND || '127.0.0.1';
const NODE_LABEL = process.env.GHOSTDEV_NODE_LABEL || os.hostname();
const SHOW_PUBLIC_IP = (process.env.GHOSTDEV_SHOW_PUBLIC_IP || 'true') !== 'false';
const TMUX_USER = process.env.GHOSTDEV_TMUX_USER || '';

// File explorer
const FILES_ENABLED = (process.env.GHOSTDEV_FILES_ENABLED || 'true') !== 'false';
const FILES_RW = (process.env.GHOSTDEV_FILES_READONLY || 'false') !== 'true';
const FILES_ROOT = (() => {
  const want = process.env.GHOSTDEV_FILES_ROOT || os.homedir();
  try { return fs.realpathSync(want); } catch (e) { return P.resolve(want); }
})();
const MAX_UPLOAD = 256 * 1024 * 1024;          // base64 JSON body cap for uploads/saves
const MAX_URL_FETCH = 4 * 1024 * 1024 * 1024;  // remote URL download cap

// Optional Proxmox host-stats module (OFF by default). READ-ONLY API token only.
const PVE_ENABLED = (process.env.GHOSTDEV_PROXMOX_ENABLED || 'false') === 'true';
const PVE_HOST = process.env.GHOSTDEV_PROXMOX_HOST || '';
const PVE_TOKEN_ID = process.env.GHOSTDEV_PROXMOX_TOKEN_ID || '';
const PVE_TOKEN_SECRET = process.env.GHOSTDEV_PROXMOX_TOKEN_SECRET || '';
const PVE_NODE = process.env.GHOSTDEV_PROXMOX_NODE || '';

// ---------------------------------------------------------------------------
// Claude state detection (the headline feature).
// Heuristic over the visible tmux pane. Claude's spinner verbs change between releases, so
// these regexes are intentionally easy to find and edit. See docs/claude-status.md.
// ---------------------------------------------------------------------------
const RE_PERMS = /Do you want to (?:proceed|make|create|run|allow|apply|edit|overwrite|delete)|Yes, and don'?t ask again|No, and tell Claude|❯\s*\d+\.\s*(?:Yes|Allow)\b/i;
const RE_BUSY = /esc to interrupt|[↓↑]\s*[\d.,]+\s*k?\s*tokens|[✽✻✶✳✺✢✷✸✹]\s*\w+…|\b(?:Calculating|Thinking|Compacting|Forging|Pondering|Working|Running|Herding|Cooking|Brewing|Synthesizing|Channelling|Crafting)…/;
const RE_READY = /^\s*❯\s*$/m;

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
  if (!max || isNaN(max) || isNaN(cur)) {
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
// Optional Proxmox host stats (READ-ONLY API token; OFF unless enabled)
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
  } catch (e) { return []; }
}
function killSession(s) {
  if (!SESS_RE.test(s)) return { ok: false, error: 'invalid session name' };
  try { tmux(['kill-session', '-t', s]); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.stderr || e.message || 'error').trim() }; }
}

// ---------------------------------------------------------------------------
// File explorer — every path confined to FILES_ROOT (defense-in-depth traversal guard)
// ---------------------------------------------------------------------------
function safeResolve(rel) {
  const cleaned = P.normalize('/' + String(rel || '')).replace(/^\/+/, '');
  const abs = P.resolve(FILES_ROOT, cleaned);
  if (abs !== FILES_ROOT && !abs.startsWith(FILES_ROOT + P.sep)) return null;
  return abs;
}
function relOf(abs) { const r = P.relative(FILES_ROOT, abs); return r === '' ? '' : r; }
function safeName(n) {
  n = String(n || '').trim();
  if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\\') || n.includes('\0')) return null;
  return n;
}
const MIME = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.yml': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8',
  '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf'
};
function fsList(rel) {
  const abs = safeResolve(rel); if (!abs) throw new Error('bad path');
  const entries = fs.readdirSync(abs, { withFileTypes: true }).map((d) => {
    let size = 0, mtime = 0;
    try { const st = fs.statSync(P.join(abs, d.name)); size = st.size; mtime = st.mtimeMs; } catch (e) {}
    let type = d.isDirectory() ? 'dir' : 'file';
    if (d.isSymbolicLink()) { try { type = fs.statSync(P.join(abs, d.name)).isDirectory() ? 'dir' : 'file'; } catch (e) { type = 'file'; } }
    return { name: d.name, type, size, mtime };
  });
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
  return { root: FILES_ROOT, path: relOf(abs), atRoot: abs === FILES_ROOT, rw: FILES_RW, entries };
}
function downloadUrl(url, destDir, hops, cb) {
  if (hops > 5) return cb(new Error('too many redirects'));
  let u; try { u = new URL(url); } catch (e) { return cb(new Error('invalid url')); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb(new Error('only http/https'));
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.get(url, { timeout: 20000 }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume(); return downloadUrl(new URL(res.headers.location, url).href, destDir, hops + 1, cb);
    }
    if (res.statusCode !== 200) { res.resume(); return cb(new Error('http ' + res.statusCode)); }
    let name = P.basename(decodeURIComponent(u.pathname)) || 'download';
    const cd = res.headers['content-disposition'];
    const m = cd && cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) name = decodeURIComponent(m[1]);
    name = safeName(P.basename(name)) || 'download';
    let out = P.join(destDir, name), i = 1, ext = P.extname(name), base = name.slice(0, name.length - ext.length);
    while (fs.existsSync(out)) out = P.join(destDir, base + '-' + (i++) + ext);
    const ws = fs.createWriteStream(out); let got = 0, aborted = false;
    res.on('data', (c) => { got += c.length; if (got > MAX_URL_FETCH && !aborted) { aborted = true; req.destroy(); ws.destroy(); try { fs.unlinkSync(out); } catch (e) {} cb(new Error('file too large')); } });
    res.pipe(ws);
    ws.on('finish', () => { if (!aborted) cb(null, { name: P.basename(out), size: got }); });
    ws.on('error', (e) => cb(e));
  });
  req.on('error', cb); req.on('timeout', () => req.destroy(new Error('timeout')));
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let body = '', big = false;
    req.on('data', (c) => { body += c; if (body.length > cap) { big = true; req.destroy(); } });
    req.on('end', () => big ? reject(new Error('body too large')) : resolve(body));
    req.on('error', reject);
  });
}

async function handleFs(req, res, path, query) {
  if (!FILES_ENABLED) return sendJson(res, 403, { error: 'file explorer disabled' });
  const writeOp = req.method === 'POST';
  if (writeOp && !FILES_RW && path !== '/fs/read') return sendJson(res, 403, { error: 'read-only mode' });

  try {
    if (req.method === 'GET' && path === '/fs/list') return sendJson(res, 200, fsList(query.get('path') || ''));

    if (req.method === 'GET' && path === '/fs/read') {
      const abs = safeResolve(query.get('path')); if (!abs) return sendJson(res, 400, { error: 'bad path' });
      const st = fs.statSync(abs);
      if (st.isDirectory()) return sendJson(res, 400, { error: 'is a directory' });
      const ext = P.extname(abs).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' };
      if (query.get('dl')) headers['Content-Disposition'] = 'attachment; filename="' + P.basename(abs).replace(/"/g, '') + '"';
      res.writeHead(200, headers);
      return fs.createReadStream(abs).pipe(res);
    }

    if (req.method === 'POST' && path === '/fs/upload') {
      const j = JSON.parse(await readBody(req, MAX_UPLOAD));
      const dir = safeResolve(j.path); const name = safeName(j.name);
      if (!dir || !name) return sendJson(res, 400, { error: 'bad path/name' });
      fs.writeFileSync(P.join(dir, name), Buffer.from(j.b64 || '', 'base64'));
      return sendJson(res, 200, { ok: true, name });
    }
    if (req.method === 'POST' && path === '/fs/save') {
      const j = JSON.parse(await readBody(req, MAX_UPLOAD));
      const abs = safeResolve(j.path); if (!abs) return sendJson(res, 400, { error: 'bad path' });
      fs.writeFileSync(abs, String(j.content == null ? '' : j.content));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/fs/mkdir') {
      const j = JSON.parse(await readBody(req, 1 << 16));
      const dir = safeResolve(j.path); const name = safeName(j.name);
      if (!dir || !name) return sendJson(res, 400, { error: 'bad path/name' });
      fs.mkdirSync(P.join(dir, name)); return sendJson(res, 200, { ok: true, name });
    }
    if (req.method === 'POST' && path === '/fs/rename') {
      const j = JSON.parse(await readBody(req, 1 << 16));
      const abs = safeResolve(j.path); const name = safeName(j.to);
      if (!abs || !name || abs === FILES_ROOT) return sendJson(res, 400, { error: 'bad path/name' });
      fs.renameSync(abs, P.join(P.dirname(abs), name)); return sendJson(res, 200, { ok: true, name });
    }
    if (req.method === 'POST' && path === '/fs/delete') {
      const j = JSON.parse(await readBody(req, 1 << 16));
      const abs = safeResolve(j.path); if (!abs || abs === FILES_ROOT) return sendJson(res, 400, { error: 'bad path' });
      fs.rmSync(abs, { recursive: true, force: true }); return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/fs/fetch-url') {
      const j = JSON.parse(await readBody(req, 1 << 16));
      const dir = safeResolve(j.path); if (!dir) return sendJson(res, 400, { error: 'bad path' });
      return downloadUrl(String(j.url || ''), dir, 0, (err, info) =>
        err ? sendJson(res, 400, { error: String(err.message) }) : sendJson(res, 200, { ok: true, name: info.name, size: info.size }));
    }
  } catch (e) {
    return sendJson(res, 400, { error: String(e.message || e) });
  }
  res.writeHead(404); res.end('nf');
}

const server = http.createServer(async (req, res) => {
  const u = req.url.split('?');
  const path = u[0];
  const query = new URLSearchParams(u[1] || '');

  if (path === '/sessions') return sendJson(res, 200, listSessions());
  if (path === '/kill') {
    const s = query.get('s') || '';
    const r = killSession(s);
    return sendJson(res, r.ok ? 200 : (SESS_RE.test(s) ? 500 : 400), r);
  }
  if (path === '/stats') {
    refreshPubIp();
    const ips = { ct: localIp() };
    if (SHOW_PUBLIC_IP) ips.public = pubIp || '–';
    const out = { label: NODE_LABEL, files: FILES_ENABLED, ct: { cpu: localCpu(), mem: localMem(), disk: localDisk() }, ips, ts: Date.now() };
    if (PVE_ENABLED && PVE_HOST && PVE_TOKEN_ID && PVE_TOKEN_SECRET) {
      try { out.host = await hostStats(); ips.host = PVE_HOST; } catch (e) { out.host = { error: true }; }
    }
    return sendJson(res, 200, out);
  }
  if (path.startsWith('/fs/')) return handleFs(req, res, path, query);

  res.writeHead(404); res.end('nf');
});
server.listen(PORT, BIND, () => console.log(`ghostdev-stats on ${BIND}:${PORT} (label=${NODE_LABEL}, proxmox=${PVE_ENABLED}, files=${FILES_ENABLED}@${FILES_ROOT})`));
