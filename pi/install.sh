#!/usr/bin/env bash
# Sonor Sky Remote: set up a Raspberry Pi (Raspberry Pi OS Bookworm / any Debian with systemd) as a Sky bridge.
# Usage, from the unzipped sky-remote folder on the Pi:
#   sudo bash pi/install.sh "Test rig Pi"
# Afterwards the bridge starts on every boot:
#   - on site Wi-Fi/LAN:   http://<pi-ip>:8049   (or http://<hostname>.local:8049)
#   - anywhere:            the hosted page on apps.sonor.co.uk (pick this Pi in the bridge list)
set -euo pipefail

NAME="${1:-$(hostname)}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/sonor-sky-remote
USER_NAME=skyremote

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash pi/install.sh \"$NAME\""; exit 1; fi

need_node() { ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]; }
if need_node; then
  echo "Installing Node.js…"
  apt-get update -qq && apt-get install -y -qq nodejs
fi
if need_node; then echo "Node.js 18 or newer is needed and could not be installed. Install it from https://nodejs.org and run this again."; exit 1; fi

id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$DEST"
# keep boxes.json / relay.json from a previous install
cp -r "$SRC/lib" "$SRC/public" "$SRC/server.js" "$SRC/package.json" "$DEST/"
chown -R "$USER_NAME":"$USER_NAME" "$DEST"

cat > /etc/systemd/system/sonor-sky-remote.service <<EOF
[Unit]
Description=Sonor Sky Remote bridge
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$DEST
Environment=PORT=8049
Environment=SKY_RELAY=1
Environment=SKY_RELAY_NAME=$NAME
ExecStart=$(command -v node) $DEST/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now sonor-sky-remote.service
sleep 2
systemctl --no-pager --lines=8 status sonor-sky-remote.service || true

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Done. Bridge \"$NAME\" starts on every boot."
echo "  On site:   http://${IP:-<pi-ip>}:8049   or   http://$(hostname).local:8049"
echo "  Anywhere:  the Sky Remote app on apps.sonor.co.uk (pick \"$NAME\")"
echo "  Logs:      journalctl -u sonor-sky-remote -f"
