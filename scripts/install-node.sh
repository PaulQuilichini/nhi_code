#!/usr/bin/env bash
# Installs Node.js if missing. Used by start-nhicode.sh / .command
# macOS: Homebrew, then portable tarball to ~/.local/share/nhicode/nodejs
# Linux: portable tarball (Homebrew on Linux if available)

set -euo pipefail

NODE_VERSION="22.14.0"

find_node_prefix() {
  local candidates=()
  local c

  [[ -n "$(command -v node 2>/dev/null || true)" ]] && candidates+=("$(command -v node)")
  candidates+=(
    "$HOME/.local/share/nhicode/nodejs/bin/node"
    "$HOME/.local/share/suprmodl/nodejs/bin/node"
    "$HOME/.local/share/supermodel/nodejs/bin/node"
    "/usr/local/bin/node"
    "/opt/homebrew/bin/node"
  )
  if [[ -d "$HOME/.fnm" ]]; then
    candidates+=("$HOME/.fnm/current/bin/node")
  fi
  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    local ver
    ver="$(ls "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1 || true)"
    [[ -n "$ver" ]] && candidates+=("$HOME/.nvm/versions/node/$ver/bin/node")
  fi

  for c in "${candidates[@]}"; do
    if [[ -n "$c" && -x "$c" ]]; then
      dirname "$(dirname "$c")"
      return 0
    fi
  done
  return 1
}

if dir="$(find_node_prefix)"; then
  echo "  Node.js already installed at $dir" >&2
  echo "$dir"
  exit 0
fi

echo "  Node.js not found — attempting install..." >&2
echo "" >&2

OS="$(uname -s)"
ARCH="$(uname -m)"

if [[ "$OS" == "Darwin" ]] && command -v brew &>/dev/null; then
  echo "  Using Homebrew to install Node.js..." >&2
  brew install node@22 2>/dev/null || brew install node
  if dir="$(find_node_prefix)"; then
    echo "  Node.js installed via Homebrew." >&2
    echo "$dir"
    exit 0
  fi
fi

case "$OS-$ARCH" in
  Darwin-arm64)  PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64" ;;
  Linux-x86_64)  PLATFORM="linux-x64" ;;
  Linux-aarch64) PLATFORM="linux-arm64" ;;
  *)
    echo "  [ERROR] Unsupported platform: $OS $ARCH" >&2
    exit 1
    ;;
esac

NODE_DIR="$HOME/.local/share/nhicode/nodejs"
TARBALL="node-v${NODE_VERSION}-${PLATFORM}.tar.xz"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
TMP="${TMPDIR:-/tmp}/nhicode-node"

echo "  Downloading Node.js v${NODE_VERSION} (${PLATFORM})..." >&2
mkdir -p "$TMP"
curl -fsSL "$URL" -o "$TMP/$TARBALL"

rm -rf "$TMP/extract" "$NODE_DIR"
mkdir -p "$TMP/extract"
tar -xJf "$TMP/$TARBALL" -C "$TMP/extract"

INNER="$(find "$TMP/extract" -maxdepth 1 -type d ! -path "$TMP/extract" | head -1)"
mv "$INNER" "$NODE_DIR"

rm -rf "$TMP"
echo "  Installed portable Node.js to:" >&2
echo "  $NODE_DIR" >&2
echo "$NODE_DIR"
