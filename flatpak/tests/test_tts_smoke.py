import array
import importlib.util
import tempfile
import struct
import unittest
import wave
from pathlib import Path

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).resolve().parents[1] / 'modules/smoke-tts.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class WavValidation(unittest.TestCase):
    def test_accepts_real_format_and_rejects_silence_or_wrong_sample_rate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.wav'
            for amplitude, rate, valid in [(1000, 22050, True), (0, 22050, False), (1000, 16000, False)]:
                with wave.open(str(path), 'wb') as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(rate)
                    audio.writeframes(array.array('h', [amplitude, -amplitude] * 11025).tobytes())
                if valid:
                    self.assertEqual(len(smoke.validate_wav(path)), 64)
                else:
                    with self.assertRaises(ValueError):
                        smoke.validate_wav(path)

    def test_validates_current_piper_float_wav_and_rejects_nonfinite_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.wav'
            for level, valid in [(0.05, True), (0.0, False), (float('nan'), False)]:
                samples = struct.pack('<f', level) * 22050
                fmt = struct.pack('<HHIIHH', 3, 1, 22050, 88200, 4, 32)
                chunks = b'fmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', len(samples)) + samples
                path.write_bytes(b'RIFF' + struct.pack('<I', len(chunks) + 4) + b'WAVE' + chunks)
                if valid:
                    self.assertEqual(len(smoke.validate_wav(path)), 64)
                else:
                    with self.assertRaises(ValueError):
                        smoke.validate_wav(path)

    def test_accepts_piper_streaming_length_sentinel_but_not_arbitrary_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.wav'
            samples = struct.pack('<f', 0.05) * 22050
            fmt = struct.pack('<HHIIHH', 3, 1, 22050, 88200, 4, 32)
            for declared in (0x7ffff000, len(samples) + 100):
                chunks = b'fmt ' + struct.pack('<I', len(fmt)) + fmt + b'data' + struct.pack('<I', declared) + samples
                path.write_bytes(b'RIFF' + struct.pack('<I', len(chunks) + 4) + b'WAVE' + chunks)
                if declared == 0x7ffff000:
                    self.assertEqual(len(smoke.validate_wav(path)), 64)
                else:
                    with self.assertRaises(ValueError):
                        smoke.validate_wav(path)
