#!/usr/bin/env python3
"""Exercise the actual packaged neural model/CLI, not a fake Piper process."""
import array
import hashlib
import json
import math
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


def validate_wav(path: Path) -> str:
    # Current Piper emits IEEE float WAV; older Piper emits signed PCM WAV.
    # Python's wave module does not support float, so inspect RIFF chunks.
    data = path.read_bytes()
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError('Piper did not produce a WAV file')
    fmt = None
    frames = None
    position = 12
    while position + 8 <= len(data):
        kind, size = struct.unpack_from('<4sI', data, position)
        start = position + 8
        end = start + size
        if end > len(data):
            # Piper's streaming WAV header uses this documented unknown-length
            # sentinel even for file output. Other truncated chunks are errors.
            if kind == b'data' and size == 0x7ffff000:
                end = len(data)
            else:
                raise ValueError('Truncated WAV chunk')
        if kind == b'fmt ' and size >= 16:
            fmt = struct.unpack_from('<HHIIHH', data, start)
        elif kind == b'data':
            frames = data[start:end]
        position = end + size % 2
    if fmt is None or frames is None:
        raise ValueError('Missing WAV format or audio data')
    encoding, channels, rate, _, align, bits = fmt
    expected = {1: (16, 2, 'h', 50), 3: (32, 4, 'f', 0.0015)}.get(encoding)
    if not expected or (bits, align) != expected[:2] or channels != 1 or rate != 22050 or len(frames) % align:
        raise ValueError('Piper produced an unexpected audio format')
    seconds = len(frames) / (align * rate)
    if not 0.2 <= seconds <= 30:
        raise ValueError(f'Unexpected synthesized duration: {seconds}')
    samples = array.array(expected[2], frames)
    if sys.byteorder != 'little':
        samples.byteswap()
    if not all(math.isfinite(sample) for sample in samples):
        raise ValueError('Piper produced non-finite audio samples')
    if not samples or max(abs(sample) for sample in samples) < expected[3]:
        raise ValueError('Piper produced silent audio')
    return hashlib.sha256(frames).hexdigest()


def main() -> None:
    root = Path('/app/piper')
    model = root / 'voices/en_US-libritts_r-medium.onnx'
    metadata = json.loads(Path(str(model) + '.json').read_text())
    if metadata['num_speakers'] != 904:
        raise ValueError('Unexpected bundled speaker count')
    print('Piper version:', subprocess.check_output([str(root / 'piper'), '--version'], text=True).strip())
    hashes = []
    with tempfile.TemporaryDirectory(prefix='gametable-tts-smoke-') as directory:
        for speaker in (21, 318, 903):
            output = Path(directory) / f'{speaker}.wav'
            subprocess.run([
                str(root / 'piper'), '--model', str(model), '--speaker', str(speaker),
                '--length_scale', '1.0', '--espeak_data', str(root / 'espeak-ng-data'),
                '--output_file', str(output),
            ], input='Welcome to the game table. Your turn begins now.\n',
                text=True, check=True, timeout=60)
            hashes.append(validate_wav(output))
            print(f'Speaker {speaker}: valid, non-silent mono 22050 Hz WAV')
    if len(set(hashes)) != 3:
        raise ValueError('Different speakers produced identical audio')


if __name__ == '__main__':
    main()
