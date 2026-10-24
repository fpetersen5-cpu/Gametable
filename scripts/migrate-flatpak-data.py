#!/usr/bin/env python3
"""Opt-in host-side record migration between GameTable Flatpak identities.

No secrets, Chromium state, or resumable live matches are copied. This must
run on the host, not inside either Flatpak sandbox. Dry-run is the default.
"""

import argparse
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import uuid


OLD_ID = 'io.github.takmikill.GameTable'
NEW_ID = 'io.github.fpetersen5_cpu.GameTable'
DATA_FILES = ('config.json', 'results.jsonl')


def user_data(app_id: str) -> Path:
    return Path.home() / '.var' / 'app' / app_id / 'config' / 'GameTable'


def directory(path: Path) -> bool:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(mode):
        raise ValueError(f'Not a real directory: {path}')
    return True


def regular_file(path: Path) -> bool:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(mode):
        raise ValueError(f'Not a regular file: {path}')
    return True


def plan(source: Path, destination: Path) -> list[tuple[Path, Path]]:
    if not directory(source):
        raise ValueError(f'No old GameTable data found at {source}')
    if directory(destination) and source.samefile(destination):
        raise ValueError('Old and new data directories are the same')
    files = []
    for name in DATA_FILES:
        path = source / name
        if regular_file(path):
            files.append((path, destination / name))
    matches = source / 'matches'
    if directory(matches):
        for path in sorted(matches.iterdir()):
            if path.name.endswith('.json') and regular_file(path):
                files.append((path, destination / 'matches' / path.name))
    if not files:
        raise ValueError('No config, results or replay records to migrate')
    for _, target in files:
        if target.exists() or target.is_symlink():
            raise ValueError(f'Refusing to overwrite existing data: {target}')
        directory(target.parent)
    return files


def ensure_stopped() -> None:
    if os.getenv('FLATPAK_ID'):
        raise ValueError('Run this migration on the host, not from inside a Flatpak')
    try:
        result = subprocess.run(['flatpak', 'ps', '--columns=application'],
                                capture_output=True, text=True, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        raise ValueError('Cannot confirm both Flatpak apps are stopped') from error
    if any(line.strip() in (OLD_ID, NEW_ID) for line in result.stdout.splitlines()):
        raise ValueError('Close both GameTable Flatpak apps before migrating')


def private_directory(path: Path) -> None:
    if directory(path):
        return
    private_directory(path.parent)
    path.mkdir(mode=0o700)


def copy_atomic(source: Path, target: Path) -> None:
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        # Exclusive creation and no symlinks, even if an attacker changed the
        # source between planning and opening it.
        with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as reader:
            if not stat.S_ISREG(os.fstat(reader.fileno()).st_mode):
                raise ValueError(f'Not a regular file: {source}')
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as writer:
                shutil.copyfileobj(reader, writer)
                writer.flush()
                os.fsync(writer.fileno())
        os.link(temporary, target, follow_symlinks=False)  # fails if target now exists
    finally:
        temporary.unlink(missing_ok=True)


def migrate(source: Path, destination: Path, apply: bool = False) -> list[Path]:
    files = plan(source, destination)
    if not apply:
        return [target for _, target in files]
    ensure_stopped()
    # Recheck before creating files: never merge over an existing match or
    # configuration produced by the new application.
    files = plan(source, destination)
    private_directory(destination.parent)
    private_directory(destination)
    if any(target.parent.name == 'matches' for _, target in files):
        private_directory(destination / 'matches')
    for old, new in files:
        copy_atomic(old, new)
    return [target for _, target in files]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='copy after showing the default dry run')
    parser.add_argument('--source', type=Path, default=user_data(OLD_ID))
    parser.add_argument('--destination', type=Path, default=user_data(NEW_ID))
    args = parser.parse_args()
    try:
        paths = migrate(args.source, args.destination, args.apply)
    except (ValueError, OSError) as error:
        print(f'Migration refused: {error}', file=sys.stderr)
        return 1
    print(('Copied' if args.apply else 'Would copy') + f' {len(paths)} files into {args.destination}')
    for path in paths:
        print(' ', path.relative_to(args.destination))
    print('Originals remain untouched. No API keys, keyring credentials, live games or browser cache are copied.')
    print('Open the new app and enter your OpenRouter key again in Settings.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
