# Security

ghostdev gives a web browser a **real shell** on the host (and, by default, the Claude Code
CLI with whatever permissions that user has). Treat it like SSH: anyone who reaches it and
passes auth can run commands as that user.

## The one rule

**Never expose ghostdev directly to the internet without authentication in front of it.**

The defaults are built to make the unsafe thing hard:

- The Docker container publishes to **`127.0.0.1` only** (`GHOSTDEV_HOST_ADDR=127.0.0.1`).
- The native installer makes nginx listen on **`127.0.0.1`** by default (`--bind`).
- `ttyd` and the stats backend bind to localhost and are only reachable through nginx.

To reach it from another machine, choose one of the options below — do not just flip the bind
to `0.0.0.0`.

## Ways to expose it safely

1. **VPN / overlay network (simplest).** Put the host on Tailscale / WireGuard / ZeroTier and
   reach `http://<vpn-ip>:7680`. No public surface at all.

2. **Reverse proxy + SSO (recommended for real use).** Front it with nginx / Caddy / Nginx
   Proxy Manager terminating TLS, plus an identity provider (Authentik, Authelia, Cloudflare
   Access, oauth2-proxy). The proxy enforces login before any request reaches ghostdev. See
   [`reverse-proxy.md`](reverse-proxy.md).

3. **Built-in basic auth (minimum bar).** Set `GHOSTDEV_BASIC_AUTH=user:strongpassword`. This
   adds an HTTP basic-auth prompt at the `ttyd` layer. Always pair it with TLS (a reverse proxy)
   so the password isn't sent in clear text. Prefer option 2 over this.

## Other notes

- **No secrets in the image or repo.** Configuration is via environment variables. The optional
  Proxmox stats module uses a **read-only API token**, never a root password — see
  [`proxmox-stats.md`](proxmox-stats.md).
- **Runs as a non-root user.** The container runs as `ghost` (uid 1000); the native install runs
  as the `--user` you choose. Don't run the sessions as root.
- **The terminal can do anything that user can.** If you preinstall Claude Code, an authenticated
  visitor can run it (and approve its permission prompts). Scope the user account accordingly.
- **Reporting:** open a private security advisory on the GitHub repo rather than a public issue.
