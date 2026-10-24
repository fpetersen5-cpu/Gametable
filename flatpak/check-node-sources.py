#!/usr/bin/env python3
"""Compare generator output independent of ordering, not of source contents."""
import json
import sys
from collections import Counter
from pathlib import Path


def check(committed: Path, generated: Path) -> None:
    def sources(path: Path) -> Counter:
        value = json.loads(path.read_text())
        if not isinstance(value, list) or not value:
            raise ValueError(f'{path}: expected a non-empty source list')
        return Counter(json.dumps(source, sort_keys=True) for source in value)

    if sources(committed) != sources(generated):
        raise ValueError('Offline npm sources differ. Regenerate and commit flatpak/node-sources.json.')


if __name__ == '__main__':
    check(Path(sys.argv[1]), Path(sys.argv[2]))
    print('Offline npm sources match the committed snapshot.')
