#!/usr/bin/env bash
#
# Build AudioTag release installers locally and optionally publish them to a
# GitHub Release.
#
#   - macOS (universal .dmg) is built natively on this Mac.
#   - Windows (NSIS -setup.exe) is cross-compiled inside a Linux container.
#
# macOS installers cannot be built in a container, so this script must run on a
# Mac to produce the macOS build; the Windows build only needs Docker.
#
# Usage:
#   scripts/release.sh [tag]      # build only (artifacts in dist-release/)
#   UPLOAD=1 scripts/release.sh   # build AND publish to a GitHub Release
#
# `tag` defaults to v<version> from package.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
TAG="${1:-v$VERSION}"
OUT="$ROOT/dist-release"

rm -rf "$OUT"
mkdir -p "$OUT"

echo "==> AudioTag $VERSION  (release tag: $TAG)"

# ---------- macOS (native) ----------
if [[ "$(uname)" == "Darwin" ]]; then
  echo "==> Building macOS universal installer (native)…"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  pnpm install --frozen-lockfile
  pnpm exec tauri build --target universal-apple-darwin
  find "src-tauri/target/universal-apple-darwin/release/bundle/dmg" \
    -name '*.dmg' -exec cp {} "$OUT/" \; 2>/dev/null \
    || echo "!! No macOS .dmg found."
else
  echo "!! Not running on macOS — skipping the macOS build."
fi

# ---------- Windows (containerized cross-compile) ----------
if command -v docker >/dev/null 2>&1; then
  echo "==> Building Windows installer (container)…"
  docker build -f build/windows.Dockerfile -t audiotag-winbuild .
  cid="$(docker create audiotag-winbuild)"
  trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
  docker cp \
    "$cid:/app/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/." \
    "$OUT/" 2>/dev/null \
    || echo "!! No Windows NSIS installer found in the image."
else
  echo "!! Docker not found — skipping the Windows build."
fi

echo "==> Artifacts in dist-release/:"
ls -lh "$OUT" || true

# ---------- Publish ----------
if [[ "${UPLOAD:-0}" == "1" ]]; then
  if ! ls "$OUT"/* >/dev/null 2>&1; then
    echo "!! Nothing to upload."
    exit 1
  fi
  echo "==> Publishing to GitHub Release $TAG…"
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "$OUT"/* --clobber
  else
    gh release create "$TAG" "$OUT"/* \
      --title "AudioTag $TAG" \
      --notes "AudioTag $VERSION. Unsigned builds — your OS may warn before opening them."
  fi
  echo "==> Done."
else
  echo "==> Build only. Re-run with UPLOAD=1 to publish to GitHub Releases."
fi
