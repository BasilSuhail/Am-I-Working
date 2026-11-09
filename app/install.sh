#!/usr/bin/env bash
# Run Am I Working as a systemd user service. Idempotent.
#   AMIW_DATA   data folder (default ~/.am-i-working), kept outside the repo
#   AMIW_PORT   default 8788
# Binds to 127.0.0.1. Put a tailnet-only proxy (tailscale serve) in front of it.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DATA="${AMIW_DATA:-$HOME/.am-i-working}"
PORT="${AMIW_PORT:-8788}"
NODE="$(command -v node)" || { echo "node is not installed." >&2; exit 1; }

install -d -m 700 "$DATA"
ENVF="$HOME/.am-i-working/env"
install -d -m 700 "$HOME/.am-i-working"
if [ ! -f "$ENVF" ]; then
  umask 077
  {
    echo "HOST=127.0.0.1"
    echo "PORT=$PORT"
    echo "AMIW_DATA=$DATA"
    echo "# Optional, fills the commits row. Read-only token, never commit this file:"
    echo "# GITHUB_LOGIN="
    echo "# GITHUB_TOKEN="
  } > "$ENVF"
fi

UNIT_DIR="$HOME/.config/systemd/user"
install -d "$UNIT_DIR"
cat > "$UNIT_DIR/am-i-working.service" <<UNIT
[Unit]
Description=Am I Working tracker
After=network.target

[Service]
EnvironmentFile=$ENVF
ExecStart=$NODE $APP_DIR/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths="$DATA"

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable am-i-working >/dev/null
systemctl --user restart am-i-working
loginctl enable-linger "$USER" 2>/dev/null || true
sleep 1
curl -fsS "http://127.0.0.1:$(grep ^PORT= "$ENVF" | cut -d= -f2)/healthz" && echo
echo "Data: $DATA/data.json"
