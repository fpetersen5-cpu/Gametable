#!/usr/bin/env bash
# Regenerate the offline npm sources for the Flatpak build.
#
# Thin wrapper around generate-sources.py, which works around two
# flatpak-node-generator bugs (see that file for details).
set -euo pipefail
PYTHON="${GAMETABLE_NODE_GENERATOR_PYTHON:-python3}"
if ! "$PYTHON" -c 'import flatpak_node_generator' 2>/dev/null; then
  if command -v pipx >/dev/null; then
    PYTHON="$(pipx environment --value PIPX_LOCAL_VENVS)/flatpak-node-generator/bin/python"
  fi
fi
if ! "$PYTHON" -c 'import flatpak_node_generator' 2>/dev/null; then
  echo 'Install flatpak-node-generator with pipx, or set GAMETABLE_NODE_GENERATOR_PYTHON to its venv Python.' >&2
  exit 1
fi
exec "$PYTHON" "$(dirname "$0")/generate-sources.py" "$@"
