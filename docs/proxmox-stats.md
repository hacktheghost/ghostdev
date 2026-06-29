# Optional: Proxmox host stats

By default the top bar shows stats for the machine ghostdev runs on (CPU / memory / disk from
cgroups, `/proc`, and `df`). If that machine is a Proxmox **guest** (LXC/VM), you can also show
the **Proxmox host's** CPU/memory/disk next to it.

This module is **off by default** and uses a **read-only API token** — never a root password.

## 1. Mint a read-only API token

On the Proxmox host:

```bash
# a dedicated user limited to auditing
pveum user add ghostdev@pve
pveum acl modify / --users ghostdev@pve --roles PVEAuditor   # read-only
# a token for that user (copy the printed secret — shown once)
pveum user token add ghostdev@pve stats --privsep 0
```

`PVEAuditor` grants read-only access to node status; it cannot change anything. The token id is
`ghostdev@pve!stats` and you get a secret value back.

## 2. Configure ghostdev

In your `.env`:

```ini
GHOSTDEV_PROXMOX_ENABLED=true
GHOSTDEV_PROXMOX_HOST=192.0.2.10            # the Proxmox host IP/FQDN (port 8006)
GHOSTDEV_PROXMOX_TOKEN_ID=ghostdev@pve!stats
GHOSTDEV_PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# GHOSTDEV_PROXMOX_NODE=pve                  # optional; auto-detected from /nodes if omitted
```

Restart (`docker compose up -d` or `systemctl restart ghostdev-stats`). A `// host` group and a
`host` IP appear in the top bar. If the token is wrong or the host is unreachable, ghostdev simply
hides the host group — local stats keep working.

> The stats backend talks to the Proxmox API over HTTPS with TLS verification disabled (Proxmox
> ships a self-signed cert by default). The token is read-only, so the blast radius is limited to
> reading node status.
