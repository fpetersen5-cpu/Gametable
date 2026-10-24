#!/usr/bin/env python3
"""Generate the single-manifest Flathub staging tree from the development one.

This is packaging tooling, not a submission. Flathub currently prohibits
AI-generated/AI-assisted manifests; a human maintainer must independently
review, rewrite/own and submit the final manifest and pull request.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
APP_ID = 'io.github.fpetersen5_cpu.GameTable'
SOURCE_URL = 'https://github.com/fpetersen5-cpu/Gametable.git'
DEVELOPMENT_MANIFEST = ROOT / 'flatpak' / f'{APP_ID}.yml'


def current_commit() -> str:
    return subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()


def expanded_manifest() -> dict:
    result = subprocess.run(
        ['flatpak', 'run', 'org.flatpak.Builder', '--show-manifest', str(DEVELOPMENT_MANIFEST)],
        capture_output=True, text=True, check=True,
    )
    # The builder may print flatpak sandbox diagnostics before the JSON.
    return json.loads(result.stdout[result.stdout.index('{'):])


def flatten(modules: list[dict]) -> list[dict]:
    out: list[dict] = []
    for module in modules:
        nested = module.get('modules')
        if nested:
            out.extend(flatten(nested))
            copy = {key: value for key, value in module.items() if key != 'modules'}
            out.append(copy)
        else:
            out.append(module)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', default=None, help='Application source commit (default: HEAD)')
    args = parser.parse_args()
    commit = args.commit or current_commit()
    if len(commit) != 40 or any(char not in '0123456789abcdef' for char in commit):
        raise SystemExit('commit must be a full lowercase SHA-1')

    manifest = expanded_manifest()
    modules = flatten(manifest['modules'])
    for module in modules:
        if module.get('name') != 'gametable':
            continue
        electron = next(
            source for source in module['sources']
            if isinstance(source, dict)
            and str(source.get('url', '')).startswith(
                'https://github.com/electron/electron/releases/download/'
            )
        )
        module['sources'] = [
            {'type': 'git', 'url': SOURCE_URL, 'commit': commit},
            'node-sources.json',
            electron,
        ]

    ordered = {
        key: manifest[key]
        for key in (
            'id', 'runtime', 'runtime-version', 'sdk', 'base', 'base-version',
            'command', 'separate-locales', 'sdk-extensions', 'finish-args', 'modules',
        )
        if key in manifest
    }
    ordered['modules'] = modules
    if ordered['id'] != APP_ID:
        raise SystemExit(f'unexpected app id {ordered["id"]}')
    if ordered.get('runtime-version') != '26.08':
        raise SystemExit('development manifest is not on the 26.08 runtime')

    (HERE / 'modules').mkdir(parents=True, exist_ok=True)
    for name in ('node-sources.json', 'flathub.json'):
        shutil.copy2(ROOT / 'flatpak' / name, HERE / name)
    for name in ('piper.CMakeLists.txt', 'espeak-no-sonic-download.patch'):
        shutil.copy2(ROOT / 'flatpak' / 'modules' / name, HERE / name)
    for name in ('smoke-tts.py', 'SPEECH-NOTICES.md'):
        shutil.copy2(ROOT / 'flatpak' / 'modules' / name, HERE / 'modules' / name)

    output = HERE / f'{APP_ID}.json'
    output.write_text(json.dumps(ordered, indent='\t') + '\n')
    print(f'Wrote {output} pinned to {commit}')
    print(f'Modules: {", ".join(module["name"] for module in modules)}')


if __name__ == '__main__':
    main()
