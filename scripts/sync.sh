#!/bin/sh
# Pull the latest commit and restart the local dev server.
# Run from a normal terminal: npm run sync
set -e
cd "$(dirname "$0")/.."

if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -tiTCP:5173 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
    sleep 0.3
  fi
fi

git pull --ff-only
npm install
exec npm run dev
