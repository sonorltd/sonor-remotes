#!/bin/bash
# Double-click on a Mac to start the Sky Remote, then it opens in your browser.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is needed. Install it from https://nodejs.org (LTS), then double-click this again."
  read -n 1 -s -r -p "Press any key to close."; exit 1
fi
(sleep 1; open "http://localhost:${PORT:-8049}") &
node server.js
