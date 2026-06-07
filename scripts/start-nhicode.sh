#!/usr/bin/env bash
# NHI Code launcher — macOS / Linux

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo ""
echo "  NHI Code"
echo "  ========"
echo "  Non-Human Intelligence coding agent"
echo ""

find_node_bin() {
  local candidates=(
    "$(command -v node 2>/dev/null || true)"
    "$HOME/.local/share/nhicode/nodejs/bin/node"
    "$HOME/.local/share/suprmodl/nodejs/bin/node"
    "$HOME/.local/share/supermodel/nodejs/bin/node"
    "/usr/local/bin/node"
    "/opt/homebrew/bin/node"
  )
  for c in "${candidates[@]}"; do
    if [[ -n "$c" && -x "$c" ]]; then
      export PATH="$(dirname "$c"):$PATH"
      return 0
    fi
  done
  return 1
}

if ! find_node_bin; then
  echo "  Node.js is not installed."
  echo ""
  read -r -p "  Install Node.js now? [Y/n] " reply
  reply="${reply:-Y}"
  if [[ "$reply" =~ ^[Nn] ]]; then
    echo ""
    echo "  Install Node.js 20+ from https://nodejs.org then run this script again."
    exit 1
  fi
  echo ""
  NODE_DIR="$(bash "$ROOT/scripts/install-node.sh" | tail -1)"
  export PATH="$NODE_DIR/bin:$PATH"
fi

if ! command -v node &>/dev/null; then
  echo "  [ERROR] Node.js still not available after install."
  exit 1
fi

echo "  Node.js $(node -v)"

NODE_MAJOR="$(node -p "process.version.slice(1).split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "  [WARNING] Node.js 20+ is recommended. You have v${NODE_MAJOR}."
  echo ""
fi

if ! command -v pnpm &>/dev/null; then
  echo "  pnpm not found - installing globally..."
  npm install -g pnpm
fi

echo "  pnpm $(pnpm -v)"
echo ""

if [[ ! -d node_modules ]]; then
  echo "  Installing dependencies (first run)..."
else
  echo "  Checking dependencies..."
fi
if ! pnpm install; then
  echo "  Retrying after approving esbuild build scripts..."
  pnpm approve-builds esbuild --all 2>/dev/null || true
  pnpm install
fi
echo ""

if ! command -v cargo &>/dev/null; then
  echo "  [WARNING] Rust not found. Install from https://rustup.rs"
  echo ""
fi

if [[ ! -f apps/desktop/src-tauri/icons/icon.icns && ! -f apps/desktop/src-tauri/icons/icon.ico ]]; then
  echo "  Generating app icons (first run)..."
  pnpm --filter @nhicode/desktop icons 2>/dev/null || true
fi

echo "  Starting NHI Code desktop app..."
echo ""
echo "  Press Ctrl+C to stop."
echo ""

pnpm dev
