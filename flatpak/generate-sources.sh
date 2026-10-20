#!/usr/bin/env bash
# Regenerate the offline npm sources for the Flatpak build.
#
# Thin wrapper around generate-sources.py, which works around two
# flatpak-node-generator bugs (see that file for details).
set -euo pipefail
exec python3 "$(dirname "$0")/generate-sources.py" "$@"
