#!/usr/bin/env bash
# ghostdev native installer (no Docker). Installs ttyd + nginx + the stats backend as
# systemd services. Run as root:  sudo ./install/install.sh [options]
#
#   --user USER          user that owns the terminal sessions   (default: $SUDO_USER or "ghost")
#   --port PORT          nginx listen port                       (default: 7680)
#   --bind ADDR          nginx listen address                    (default: 127.0.0.1)
#   --label LABEL        node label shown in the top bar         (default: hostname)
#   --basic-auth U:P     optional ttyd basic auth (prefer a reverse proxy instead)
#   --ttyd-version VER   ttyd release to download                (default: 1.7.7)
set -euo pipefail

GHOSTDEV_USER="${SUDO_USER:-ghost}"
GHOSTDEV_PORT=7680
GHOSTDEV_BIND=127.0.0.1
GHOSTDEV_LABEL="$(hostname)"
BASIC_AUTH=""
TTYD_VERSION=1.7.7
REPO="$(cd "$(dirname "$0")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --user)         GHOSTDEV_USER="$2"; shift 2;;
    --port)         GHOSTDEV_PORT="$2"; shift 2;;
    --bind)         GHOSTDEV_BIND="$2"; shift 2;;
    --label)        GHOSTDEV_LABEL="$2"; shift 2;;
    --basic-auth)   BASIC_AUTH="$2"; shift 2;;
    --ttyd-version) TTYD_VERSION="$2"; shift 2;;
    -h|--help)      sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)." >&2; exit 1; }
id "$GHOSTDEV_USER" >/dev/null 2>&1 || { echo "User '$GHOSTDEV_USER' does not exist. Create it or pass --user." >&2; exit 1; }
GHOSTDEV_HOME="$(getent passwd "$GHOSTDEV_USER" | cut -d: -f6)"

echo "==> Installing dependencies"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends nginx-light nodejs tmux curl ca-certificates gettext-base
elif command -v dnf >/dev/null; then
  dnf install -y nginx nodejs tmux curl gettext
elif command -v pacman >/dev/null; then
  pacman -Sy --noconfirm nginx nodejs tmux curl gettext
else
  echo "No supported package manager (apt/dnf/pacman). Install nginx, nodejs, tmux, curl, gettext manually." >&2
  exit 1
fi

echo "==> Installing ttyd ${TTYD_VERSION}"
case "$(uname -m)" in
  x86_64|amd64) T=x86_64;;
  aarch64|arm64) T=aarch64;;
  armv7l|armhf|arm) T=arm;;
  *) T=x86_64;;
esac
curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${T}" -o /usr/local/bin/ttyd
chmod +x /usr/local/bin/ttyd
/usr/local/bin/ttyd --version

echo "==> Installing app files"
install -d -o "$GHOSTDEV_USER" -g "$GHOSTDEV_USER" /opt/ghostdev-stats /var/www/ghostdev
install -o "$GHOSTDEV_USER" -g "$GHOSTDEV_USER" -m 0644 "$REPO/stats/server.js" /opt/ghostdev-stats/server.js
cp -r "$REPO/web/." /var/www/ghostdev/
chown -R "$GHOSTDEV_USER":"$GHOSTDEV_USER" /var/www/ghostdev

echo "==> Installing tmux config + shell tweaks for $GHOSTDEV_USER"
install -o "$GHOSTDEV_USER" -g "$GHOSTDEV_USER" -m 0644 "$REPO/config/tmux.conf" "$GHOSTDEV_HOME/.tmux.conf"
if ! grep -q 'ghostdev shell tweaks' "$GHOSTDEV_HOME/.bashrc" 2>/dev/null; then
  cat "$REPO/config/bashrc.snippet" >> "$GHOSTDEV_HOME/.bashrc"
  chown "$GHOSTDEV_USER":"$GHOSTDEV_USER" "$GHOSTDEV_HOME/.bashrc"
fi

echo "==> Rendering systemd units + nginx site"
TTYD_CRED=""
[ -n "$BASIC_AUTH" ] && TTYD_CRED="-c $BASIC_AUTH"
export GHOSTDEV_USER GHOSTDEV_HOME GHOSTDEV_LABEL GHOSTDEV_PORT GHOSTDEV_BIND
export GHOSTDEV_TTYD_CRED="$TTYD_CRED"

backup(){ [ -e "$1" ] && cp -a "$1" "$1.bak-$(date +%Y%m%d-%H%M%S)" || true; }

backup /etc/systemd/system/ttyd.service
envsubst '${GHOSTDEV_USER} ${GHOSTDEV_HOME} ${GHOSTDEV_TTYD_CRED}' \
  < "$REPO/install/ttyd.service.tmpl" > /etc/systemd/system/ttyd.service

backup /etc/systemd/system/ghostdev-stats.service
envsubst '${GHOSTDEV_USER} ${GHOSTDEV_LABEL}' \
  < "$REPO/install/ghostdev-stats.service.tmpl" > /etc/systemd/system/ghostdev-stats.service

install -d /etc/nginx/sites-available /etc/nginx/sites-enabled
backup /etc/nginx/sites-available/ghostdev.conf
envsubst '${GHOSTDEV_BIND} ${GHOSTDEV_PORT}' \
  < "$REPO/install/nginx-ghostdev.conf.tmpl" > /etc/nginx/sites-available/ghostdev.conf
ln -sf /etc/nginx/sites-available/ghostdev.conf /etc/nginx/sites-enabled/ghostdev.conf

echo "==> Enabling services"
systemctl daemon-reload
systemctl enable --now ghostdev-stats.service ttyd.service
nginx -t && systemctl reload nginx

cat <<EOF

✔ ghostdev installed.
  URL (local):  http://${GHOSTDEV_BIND}:${GHOSTDEV_PORT}
  Sessions run as: ${GHOSTDEV_USER}

⚠ SECURITY: this is a remote shell. It is bound to ${GHOSTDEV_BIND} by default.
  Do NOT expose it to the internet without auth — put a reverse proxy + SSO in front.
  See docs/SECURITY.md and docs/reverse-proxy.md.
EOF
