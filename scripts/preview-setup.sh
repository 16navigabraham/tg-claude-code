#!/bin/bash
# Runs ON the VPS, once. Installs the headless Chromium that /preview uses.
set -e
cd "$(dirname "$0")/.."

echo "==== npm install (picks up playwright) ===="
npm install

echo "==== download Chromium + system deps (~400 MB) ===="
npx playwright install --with-deps chromium

echo
echo "Done. Restart the bot, then in a session with an index.html:  /preview"
echo "For a Vite/Next project:  /preview dev   (or /preview dev 3000)"
