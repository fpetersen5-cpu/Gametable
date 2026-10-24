#!/usr/bin/env bash
# Build a signed bundle and a .flatpakref for a self-hosted repository.
#
#   export GAMETABLE_GPG_KEY=<key id or fingerprint>
#   export GAMETABLE_GPG_HOME=$HOME/.gnupg        # optional
#   export GAMETABLE_REPO_URL=https://example.com/gametable/repo/
#   ./flatpak/release.sh
#
# Produces:
#   GameTable.flatpak      signed single-file bundle
#   gametable.gpg          public key
#   GameTable.flatpakref   one-click install reference for the hosted repo
#   flatpak/repo/          the signed OSTree repository to upload
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GAMETABLE_GPG_KEY:?set GAMETABLE_GPG_KEY to the signing key id}"
: "${GAMETABLE_REPO_URL:?set GAMETABLE_REPO_URL to the public repo URL}"
export GAMETABLE_GPG_HOME="${GAMETABLE_GPG_HOME:-$HOME/.gnupg}"
python3 flatpak/release-preflight.py

APP_ID=io.github.takmikill.GameTable
BRANCH=master

./flatpak/build.sh

# build.sh installs the new commit into the OSTree repo; its summary must be
# signed again or clients with GPG verification refuse the repository.
echo "Signing the repository summary…"
flatpak build-update-repo \
  --gpg-sign="$GAMETABLE_GPG_KEY" \
  --gpg-homedir="$GAMETABLE_GPG_HOME" \
  --prune \
  flatpak/repo

gpg --homedir "$GAMETABLE_GPG_HOME" --armor --export "$GAMETABLE_GPG_KEY" > gametable.gpg
gpg --homedir "$GAMETABLE_GPG_HOME" --export "$GAMETABLE_GPG_KEY" > gametable.gpg.bin
KEY_B64="$(base64 -w0 gametable.gpg.bin)"
rm -f gametable.gpg.bin

cat > GameTable.flatpakref <<EOF
[Flatpak Ref]
Title=GameTable
Name=$APP_ID
Branch=$BRANCH
Url=$GAMETABLE_REPO_URL
GPGKey=$KEY_B64
IsRuntime=false
SuggestRemoteName=gametable
EOF

echo
echo "Signed bundle:  $(pwd)/GameTable.flatpak"
echo "Repository:     $(pwd)/flatpak/repo   → upload to $GAMETABLE_REPO_URL"
echo "One-click ref:  $(pwd)/GameTable.flatpakref"
echo "Public key:     $(pwd)/gametable.gpg"
