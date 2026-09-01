#!/bin/bash
# Run occasionally on the VPS (not from the bot — needs sudo) to reclaim disk:
# system caches, old logs, and orphaned temp files from crashed runs.
# Session cleanup itself (killed sessions' node_modules/clones) is handled from
# Telegram: /disk to see usage, /purge <name> to delete an archived session.
set -e

echo "== disk before =="
df -h / | tail -1

echo "== apt cache =="
sudo apt-get clean
sudo apt-get autoremove -y

echo "== npm cache =="
npm cache clean --force 2>/dev/null || true

echo "== journald logs (keep last 3 days) =="
sudo journalctl --vacuum-time=3d

echo "== orphaned temp files from crashed preview/voice runs (>1 day old) =="
find /tmp -maxdepth 1 \( \
    -name 'preview-*.png' -o \
    -name 'voice-*.wav' -o -name 'voice-*.txt' -o -name 'voice-in-*.oga' -o \
    -name 'authcheck-*' \
  \) -mtime +1 -exec rm -rf {} + 2>/dev/null || true

echo "== disk after =="
df -h / | tail -1

echo
echo "For per-session cleanup (node_modules, git clones in killed sessions),"
echo "use /disk and /purge <name> from Telegram instead of this script."
