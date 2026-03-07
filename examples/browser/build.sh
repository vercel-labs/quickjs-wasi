#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WASI_SDK_VERSION="30"
WASI_SDK="${WASI_SDK:-/tmp/wasi-sdk}"

# Skip if WASM is already built
if [ -f "$REPO_ROOT/quickjs.wasm" ]; then
  echo "quickjs.wasm already exists, skipping build"
  exit 0
fi

# Ensure git submodules are initialized (Vercel doesn't do this by default)
echo "Initializing git submodules..."
git -C "$REPO_ROOT" submodule update --init --recursive

echo "Installing wasi-sdk v${WASI_SDK_VERSION}..."

# Detect platform
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  WASI_SDK_PLATFORM="x86_64-linux" ;;
  Linux-aarch64) WASI_SDK_PLATFORM="arm64-linux" ;;
  Darwin-arm64)  WASI_SDK_PLATFORM="arm64-macos" ;;
  Darwin-x86_64) WASI_SDK_PLATFORM="x86_64-macos" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)"; exit 1 ;;
esac

if [ ! -f "$WASI_SDK/bin/clang" ]; then
  curl -sL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_PLATFORM}.tar.gz" \
    | tar xz -C /tmp --strip-components=1 --one-top-level=wasi-sdk
fi

echo "Building quickjs.wasm..."
WASI_SDK="$WASI_SDK" make -C "$REPO_ROOT"

echo "Building TypeScript..."
cd "$REPO_ROOT"
pnpm run build:ts

echo "Done"
