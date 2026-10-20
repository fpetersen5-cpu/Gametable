#!/usr/bin/env python3
"""
Generate flatpak/node-sources.json with two workarounds for
flatpak-node-generator (as of 1.0.0):

1. It treats a package as a LocalSource whenever `<install_path>/package.json`
   exists, because `'node_modules' not in Path.parents` compares a str against
   Path objects and is always true. On a machine with node_modules present that
   silently drops almost every tarball. We run it against a clean tree with only
   the manifests, which makes every registry package resolve to its tarball.

2. It fetches Electron binaries for every architecture, including armv7l, which
   Electron 44 no longer publishes, and dies on a KeyError. We ship the Electron
   zip ourselves as an explicit manifest source, so its handler is skipped.

Usage:  python3 flatpak/generate-sources.py
Needs:  pipx install flatpak-node-generator   (or a venv with it)
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUTPUT = REPO / 'flatpak' / 'node-sources.json'


def stage_manifests(target: Path) -> Path:
    shutil.copy(REPO / 'package.json', target / 'package.json')
    shutil.copy(REPO / 'package-lock.json', target / 'package-lock.json')
    for pattern in ('packages/*/package.json', 'apps/*/package.json'):
        for manifest in REPO.glob(pattern):
            relative = manifest.relative_to(REPO)
            (target / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(manifest, target / relative)
    return target / 'package-lock.json'


def main() -> int:
    try:
        from flatpak_node_generator.providers.special import SpecialSourceProvider
        from flatpak_node_generator.main import main as generator_main
    except ImportError:
        print(
            'flatpak-node-generator is not installed.\n'
            '  pipx install flatpak-node-generator\n'
            'or run this script with a venv that has it.',
            file=sys.stderr,
        )
        return 1

    async def skip_electron(self, package):  # noqa: ANN001, ARG001
        return None

    SpecialSourceProvider._handle_electron = skip_electron

    with tempfile.TemporaryDirectory(prefix='gametable-sources-') as directory:
        lockfile = stage_manifests(Path(directory))
        sys.argv = ['flatpak-node-generator', 'npm', str(lockfile), '-o', str(OUTPUT)]
        try:
            generator_main()
        except SystemExit as exit_:
            return int(exit_.code or 0)
    print(f'Wrote {OUTPUT}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
