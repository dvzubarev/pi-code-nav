#!/usr/bin/env bash
# install.sh — deploy code-nav to ~/.pi/agent/extensions/code-nav/
#
# Creates a symlink so the extension dir points at this git checkout.
# Node dependencies live in ./node_modules (run `npm install` first).
# Language servers are NOT managed here — provide them via your project's
# nix shell or PATH.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.pi/agent/extensions/code-nav"

# Ensure parent dir exists
mkdir -p "$(dirname "$TARGET_DIR")"

# If target exists and is not our symlink, back it up
if [ -e "$TARGET_DIR" ] && [ ! -L "$TARGET_DIR" ]; then
  BACKUP="${TARGET_DIR}.bak.$(date +%s)"
  echo "Existing directory found at $TARGET_DIR"
  echo "Backing up to $BACKUP"
  mv "$TARGET_DIR" "$BACKUP"
fi

# Remove stale symlink if present
if [ -L "$TARGET_DIR" ]; then
  rm "$TARGET_DIR"
fi

ln -s "$SCRIPT_DIR" "$TARGET_DIR"
echo "Linked $TARGET_DIR → $SCRIPT_DIR"

# Install node deps if missing
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing node dependencies..."
  (cd "$SCRIPT_DIR" && npm install)
else
  echo "node_modules present — skipping npm install"
fi

echo ""
echo "Done. Restart pi (or /reload) to pick up the extension."
echo "Enable tools in a session with: /code-nav"
