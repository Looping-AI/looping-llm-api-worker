#!/usr/bin/env bash
set -euo pipefail

echo "=== looping-llm-api-worker devcontainer setup ==="

# 1. Install Bun (match CI's oven-sh/setup-bun by using the official installer)
curl -fsSL https://bun.sh/install | bash

# Persist PATH update for future shells
PATH_EXPORT='export PATH="$HOME/.bun/bin:$PATH"'
if ! grep -qs '.bun/bin' "$HOME/.profile" 2>/dev/null; then
  echo "$PATH_EXPORT" >> "$HOME/.profile"
fi
if ! grep -qs '.bun/bin' "$HOME/.bashrc" 2>/dev/null; then
  echo "$PATH_EXPORT" >> "$HOME/.bashrc"
fi
# Apply to current session
eval "$PATH_EXPORT"

# 2. Install project dependencies
bun install

echo "=== Setup complete ==="
