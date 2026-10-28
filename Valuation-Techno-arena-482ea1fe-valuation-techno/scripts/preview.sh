#!/usr/bin/env bash
# One-command portal start for fresh/ephemeral environments (sandbox restarts,
# new clone, CI preview). Idempotent: only installs/builds when actually missing.
#
#   ./scripts/preview.sh            # install if needed, build if needed, start on :4000
#   PORT=8080 ./scripts/preview.sh  # custom port
#   FORCE_BUILD=1 ./scripts/preview.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-4000}"

if [ ! -d node_modules ] || [ ! -d apps/web/node_modules ]; then
  echo "→ installing dependencies"
  npm install --no-audit --no-fund
else
  echo "→ dependencies present, skipping install"
fi

if [ ! -f apps/web/dist/index.html ] || [ "${FORCE_BUILD:-0}" = "1" ]; then
  echo "→ building frontend"
  npm run build
else
  echo "→ frontend build present, skipping build"
fi

echo "→ starting portal on 0.0.0.0:${PORT}"
exec env PORT="$PORT" node apps/api/src/index.js
