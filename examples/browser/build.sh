#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Skip if WASM is already built
if [ -f "$REPO_ROOT/quickjs.wasm" ]; then
  echo "quickjs.wasm already exists, skipping build"
  exit 0
fi

# Ensure git submodules are initialized (Vercel doesn't do this by default)
echo "Initializing git submodules..."
git -C "$REPO_ROOT" submodule update --init --recursive

echo "Setting up wasi-sdk..."
make -C "$REPO_ROOT" setup

echo "Building quickjs.wasm..."
make -C "$REPO_ROOT"

echo "Building TypeScript..."
cd "$REPO_ROOT"
pnpm run build:ts

echo "Done"
