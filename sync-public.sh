#!/usr/bin/env bash
# Mirror this monorepo's mcp/ into the public repo AkaciaNL/basicdeploy-mcp so both
# git locations always match. Run after any change to mcp/ (or let the GitHub Action
# do it on an mcp-v* tag). Requires push access to the public repo (gh auth / a token).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
PUB="https://github.com/AkaciaNL/basicdeploy-mcp.git"
TMP="$(mktemp -d)"
git clone --depth 1 "$PUB" "$TMP" 2>/dev/null || { git init -q "$TMP"; (cd "$TMP" && git remote add origin "$PUB"); }
# Replace the public repo's tracked files with the current mcp/ contents (excluding node_modules).
find "$TMP" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
rsync -a --exclude node_modules --exclude '*.log' "$SRC"/ "$TMP"/
cd "$TMP"
git add -A
if git diff --cached --quiet; then echo "public repo already in sync"; exit 0; fi
V="$(node -p "require('./package.json').version" 2>/dev/null || echo dev)"
git -c user.name="Safak Kapci" -c user.email="safakkapci@gmail.com" commit -q -m "sync basicdeploy-mcp v$V from monorepo"
git branch -M main
git push -u origin main
echo "public repo synced (v$V)"
