#!/usr/bin/env bash
# Build, install and bundle the Flatpak.
#
# One-time setup:
#   flatpak install flathub org.flatpak.Builder
#   flatpak install flathub org.freedesktop.Sdk//24.08 org.freedesktop.Sdk.Extension.node22//24.08 \
#                    org.electronjs.Electron2.BaseApp//24.08
#   ./flatpak/generate-sources.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f flatpak/node-sources.json ]]; then
  echo "flatpak/node-sources.json is missing — run ./flatpak/generate-sources.sh first" >&2
  exit 1
fi

flatpak run --filesystem="$PWD" org.flatpak.Builder \
  --force-clean \
  --repo=flatpak/repo \
  --install-deps-from=flathub \
  --user \
  --install \
  flatpak/build \
  flatpak/io.github.takmikill.GameTable.yml

flatpak build-bundle flatpak/repo GameTable.flatpak io.github.takmikill.GameTable
echo "Installed and bundled: $(pwd)/GameTable.flatpak"
echo "Share it with:  flatpak install GameTable.flatpak"
