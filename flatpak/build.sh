#!/usr/bin/env bash
# Build, install and bundle the Flatpak.
#
# One-time setup:
#   flatpak install --user flathub org.flatpak.Builder \
#     org.freedesktop.Sdk//25.08 org.freedesktop.Sdk.Extension.node22//25.08 \
#     org.electronjs.Electron2.BaseApp//25.08
#   pipx install flatpak-node-generator && ./flatpak/generate-sources.sh
#
# Signing (optional, recommended for distribution):
#   export GAMETABLE_GPG_KEY=<key-id>
#   export GAMETABLE_GPG_HOME=$HOME/.gnupg      # defaults to ~/.gnupg
#
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(git rev-parse --show-toplevel)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SOURCE_URL="${GAMETABLE_SOURCE_URL:-file://$ROOT}"
APP_ID=io.github.fpetersen5_cpu.GameTable
BUNDLE=GameTable-fpetersen5_cpu.flatpak
JOBS="${GAMETABLE_BUILD_JOBS:-3}"
if [[ ! "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo 'GAMETABLE_BUILD_JOBS must be a positive integer' >&2
  exit 1
fi

if [[ ! -f flatpak/node-sources.json ]]; then
  echo "flatpak/node-sources.json is missing — run ./flatpak/generate-sources.sh first" >&2
  exit 1
fi

mkdir -p flatpak/.build
cp flatpak/node-sources.json flatpak/.build/node-sources.json
mkdir -p flatpak/.build/modules
cp -r flatpak/modules/. flatpak/.build/modules/
sed -e "s|https://github.com/fpetersen5-cpu/Gametable.git|${SOURCE_URL}|" \
    -e "s|branch: main|branch: ${BRANCH}|" \
    flatpak/${APP_ID}.yml > flatpak/.build/manifest.yml

SIGN_ARGS=()
if [[ -n "${GAMETABLE_GPG_KEY:-}" ]]; then
  SIGN_ARGS=(--gpg-sign="${GAMETABLE_GPG_KEY}"
             --gpg-homedir="${GAMETABLE_GPG_HOME:-$HOME/.gnupg}")
fi

EXTRA_FS=()
if [[ -n "${GAMETABLE_GPG_KEY:-}" ]]; then
  EXTRA_FS+=(--filesystem="${GAMETABLE_GPG_HOME:-$HOME/.gnupg}")
fi

flatpak run --filesystem="$ROOT" --filesystem="$PWD" "${EXTRA_FS[@]}" org.flatpak.Builder \
  --force-clean \
  --jobs="$JOBS" \
  --repo=flatpak/repo \
  --install-deps-from=flathub \
  --user \
  --install \
  "${SIGN_ARGS[@]}" \
  flatpak/build-dir \
  flatpak/.build/manifest.yml

BUNDLE_ARGS=()
if [[ -n "${GAMETABLE_GPG_KEY:-}" ]]; then
  BUNDLE_ARGS=(--gpg-sign="${GAMETABLE_GPG_KEY}"
               --gpg-homedir="${GAMETABLE_GPG_HOME:-$HOME/.gnupg}")
fi

flatpak build-bundle "${BUNDLE_ARGS[@]}" flatpak/repo "$BUNDLE" "$APP_ID"
echo
echo "Installed:   flatpak run $APP_ID"
echo "Bundle:      $(pwd)/$BUNDLE"
echo "Share it:    flatpak install $BUNDLE"
