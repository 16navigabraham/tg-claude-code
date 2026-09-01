#!/bin/bash
# Runs ON the VPS. Installs the GitHub CLI and sets your git commit identity.
# Does NOT touch any token - you run `gh auth login` yourself afterwards.
#
# Set these first (or just edit the two `git config` lines below):
#   GIT_USER_NAME="Your Name" GIT_USER_EMAIL="you@example.com" bash scripts/gh-setup.sh
set -e

: "${GIT_USER_NAME:?Set GIT_USER_NAME (or edit this script) before running}"
: "${GIT_USER_EMAIL:?Set GIT_USER_EMAIL (or edit this script) before running}"

echo "==== install gh ===="
if ! command -v gh >/dev/null 2>&1; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  ARCH="$(dpkg --print-architecture)"
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt-get update -y
  sudo apt-get install -y gh
fi
gh --version

echo "==== git identity ===="
git config --global user.name  "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
git config --global init.defaultBranch main
git config --global --list | grep -E '^(user|init)\.'

echo
echo "============================================================"
echo " gh installed. Next, on this box:"
echo "   1. gh auth login       (GitHub.com -> HTTPS -> paste token)"
echo "   2. gh auth setup-git   (wires token into git for all repos)"
echo "   3. gh repo list        (verify)"
echo "============================================================"
