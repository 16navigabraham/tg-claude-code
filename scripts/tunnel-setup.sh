#!/bin/bash
# Runs ON the VPS, once. Installs cloudflared (Cloudflare Tunnel) so
# /tunnel can hand you a public https://<random>.trycloudflare.com URL for a
# session's local site. No Cloudflare account or token needed for quick tunnels.
set -e

if command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared already installed: $(cloudflared --version)"
  exit 0
fi

ARCH="$(dpkg --print-architecture)"   # arm64 on the A1.Flex box
URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}"

echo "Downloading cloudflared for $ARCH ..."
sudo curl -fsSL "$URL" -o /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared

cloudflared --version
echo
echo "Done. Restart the bot. Then either:"
echo "  /tunnel   (or /tunnel dev)         — managed, one site per session"
echo "  ask Claude: 'serve ./x and ./y, tunnel both' — for multi-project sessions"
echo "  /servers  — see what Claude has running"
