#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "publish-mac.sh must be run on macOS."
  exit 1
fi

echo "Building release artifacts..."
# Build only the unpacked mac app bundle (skip dmg/zip artifacts).
npm run build
# Force a consistent ad-hoc signature for local installs and disable hardened
# runtime, which otherwise enables library validation and blocks Electron's
# framework in a non-notarized local app bundle.
npx --no-install electron-builder --mac dir --config.mac.identity=- --config.mac.hardenedRuntime=false

APP_PATH="$(find dist -maxdepth 4 -type d -name '*.app' 2>/dev/null | sort | tail -n 1 || true)"
if [[ -z "$APP_PATH" ]]; then
  APP_PATH="$(find release -maxdepth 5 -type d -name '*.app' 2>/dev/null | sort | tail -n 1 || true)"
fi

if [[ -z "$APP_PATH" ]]; then
  echo "No .app bundle found under dist/ or release/."
  exit 1
fi

APP_NAME="$(basename "$APP_PATH")"
TARGET_APP="/Applications/${APP_NAME}"

echo "Installing ${APP_NAME} to /Applications..."
if [[ -e "$TARGET_APP" ]]; then
  rm -rf "$TARGET_APP"
fi

# Use ditto to preserve app bundle metadata while copying.
ditto "$APP_PATH" "$TARGET_APP"

echo "Published successfully: $TARGET_APP"
