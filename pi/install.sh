#!/usr/bin/env bash
# Sonor Remotes: set up a Raspberry Pi (Raspberry Pi OS Bookworm / any Debian with systemd) as a Remotes bridge.
# Usage, from the unzipped remotes folder on the Pi:
#   sudo bash pi/install.sh "Test rig Pi"
# Afterwards the bridge starts on every boot:
#   - on site Wi-Fi/LAN:   http://<pi-ip>:8049   (or http://<hostname>.local:8049)
#   - anywhere:            the hosted page on apps.sonor.co.uk (pick this Pi in the bridge list)
set -euo pipefail

NAME="${1:-$(hostname)}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/sonor-remotes
OLD=/opt/sonor-sky-remote   # pre-2.1.0 install (Sky Remote): migrated below
USER_NAME=skyremote   # kept: owns relay.json / boxes.json from earlier installs

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash pi/install.sh \"$NAME\""; exit 1; fi

need_node() { ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]; }
if need_node; then
  echo "Installing Node.js…"
  apt-get update -qq && apt-get install -y -qq nodejs
fi
if need_node; then echo "Node.js 18 or newer is needed and could not be installed. Install it from https://nodejs.org and run this again."; exit 1; fi

id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
# Migrate a Sky Remote install (≤ 2.0.0): stop the old service, carry its saved devices + bridge key across.
if systemctl list-unit-files sonor-sky-remote.service >/dev/null 2>&1 && systemctl cat sonor-sky-remote.service >/dev/null 2>&1; then
  systemctl disable --now sonor-sky-remote.service 2>/dev/null || true
  rm -f /etc/systemd/system/sonor-sky-remote.service
fi
mkdir -p "$DEST"
if [ -d "$OLD" ]; then for f in boxes.json devices.json relay.json remote.json; do [ -f "$OLD/$f" ] && [ ! -f "$DEST/$f" ] && cp "$OLD/$f" "$DEST/$f" || true; done; fi
# keep boxes.json / relay.json from a previous install
cp -r "$SRC/lib" "$SRC/public" "$SRC/server.js" "$SRC/package.json" "$DEST/"
chown -R "$USER_NAME":"$USER_NAME" "$DEST"

cat > /etc/systemd/system/sonor-remotes.service <<EOF
[Unit]
Description=Sonor Remotes bridge
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
systemctl enable --now sonor-remotes.service
sleep 2
systemctl --no-pager --lines=8 status sonor-remotes.service || true

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Done. Bridge \"$NAME\" starts on every boot."
echo "  On site:   http://${IP:-<pi-ip>}:8049   or   http://$(hostname).local:8049"
echo "  Anywhere:  the Remotes app on apps.sonor.co.uk (pick \"$NAME\")"
echo "  Logs:      journalctl -u sonor-remotes -f"
