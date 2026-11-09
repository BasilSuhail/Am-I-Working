#!/bin/bash
# Double-click to start Am I Working on a Mac. Close this window to stop it.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it free at https://nodejs.org (click the big LTS button), then double-click this file again."
  read -r -p "Press Enter to close."
  exit 1
fi
(sleep 2; open "http://127.0.0.1:8788") &
node app/server.js
