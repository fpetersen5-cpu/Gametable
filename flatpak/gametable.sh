#!/bin/sh
# Launcher. zypak-wrapper ships with org.electronjs.Electron2.BaseApp and
# redirects Chromium's own sandbox onto the Flatpak sandbox.
set -eu

APP_ROOT=/app/gametable

export TMPDIR="${XDG_RUNTIME_DIR:-/tmp}/app/${FLATPAK_ID:-io.github.takmikill.GameTable}"
mkdir -p "$TMPDIR"
export CHROME_WRAPPER=/app/bin/gametable

cd "$APP_ROOT"
exec zypak-wrapper "$APP_ROOT/electron/electron" "$APP_ROOT" "$@"
