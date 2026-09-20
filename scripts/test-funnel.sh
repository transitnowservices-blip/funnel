#!/usr/bin/env bash
# Thin wrapper for the automated funnel end-to-end test.
#
# 1. Starts the app in the background with `npm start` (default port 3000)
#    so the real boot path is exercised.
# 2. Runs scripts/test-funnel.js, which spawns its OWN isolated server on
#    port 3111 (ADMIN_TOKEN=test-token, EMAIL_PROVIDER=local) and asserts
#    the full funnel: lead -> nurture -> abandon -> 4 cart emails ->
#    purchase -> post-purchase -> weekly nurture -> unsubscribe -> admin.
# 3. Kills the background `npm start` on exit.
#
# Usage: bash scripts/test-funnel.sh   (exit code non-zero on any failure)

set -euo pipefail
cd "$(dirname "$0")/.."

echo "--- starting app in background (node server.js) ---"
# NOTE: run `node server.js` directly (not `npm start`) so $APP_PID is the real
# server process — killing npm's pid would orphan the node child on port 3000.
node server.js >/tmp/funnel-sh-server.log 2>&1 &
APP_PID=$!
cleanup() {
  echo "--- stopping background app (pid $APP_PID) ---"
  kill "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Give the server a moment to boot (the test itself waits on its own port).
sleep 3
if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo "server exited early; see /tmp/funnel-sh-server.log"
  exit 1
fi

echo "--- running automated end-to-end test (own server on :3111) ---"
node scripts/test-funnel.js
