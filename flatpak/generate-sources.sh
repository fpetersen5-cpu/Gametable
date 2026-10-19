#!/usr/bin/env bash
# Regenerate the offline npm sources for the Flatpak build.
#
# Requires flatpak-node-generator:
#   pipx install flatpak-node-generator
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v flatpak-node-generator >/dev/null; then
  echo "flatpak-node-generator not found: pipx install flatpak-node-generator" >&2
  exit 1
fi

# package-lock.json must be current: npm install
flatpak-node-generator npm package-lock.json -o flatpak/node-sources.json
echo "Wrote flatpak/node-sources.json"
