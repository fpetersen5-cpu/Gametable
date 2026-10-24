import json
import unittest
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


class SpeechSources(unittest.TestCase):
    def test_speech_components_are_built_not_copied_from_release_binaries(self):
        piper = json.loads((ROOT / 'modules/piper.json').read_text())
        ort = json.loads((ROOT / 'modules/onnxruntime.json').read_text())
        espeak = next(module for module in piper['modules'] if isinstance(module, dict))
        for module in (piper, ort, espeak):
            self.assertEqual(module['buildsystem'], 'cmake-ninja')
            self.assertTrue(module['builddir'])
        self.assertTrue(ort['build-options']['strip'])
        self.assertIn('-g0', ort['build-options']['cxxflags'])
        self.assertTrue(any(source.get('path') == 'espeak-no-sonic-download.patch' for source in espeak['sources']))
        manifest = (ROOT / 'io.github.takmikill.GameTable.yml').read_text()
        self.assertIn('modules/piper.json', manifest)
        self.assertNotIn('piper_linux_x86_64.tar.gz', manifest)
        for source in json.loads((ROOT / 'modules/onnxruntime-sources.json').read_text()):
            self.assertRegex(source['sha256'], r'^[a-f0-9]{64}$')
            self.assertNotRegex(source['url'], r'onnxruntime-linux|protoc-.*linux|\.so$|\.whl$')
            if source['type'] == 'file':
                expected = 'mirror/' + urlsplit(source['url']).netloc + str(Path(urlsplit(source['url']).path).parent)
                self.assertEqual(source['dest'], expected)

    def test_cpu_only_no_telemetry_build(self):
        opts = json.loads((ROOT / 'modules/onnxruntime.json').read_text())['config-opts']
        for flag in ['onnxruntime_USE_TELEMETRY', 'onnxruntime_USE_CUDA', 'onnxruntime_USE_WEBGPU', 'onnxruntime_ENABLE_PYTHON']:
            self.assertIn(f'-D{flag}=OFF', opts)

    def test_electron_lock_and_flatpak_binary_stay_in_sync(self):
        repo = ROOT.parent
        version = json.loads((repo / 'apps/desktop/package.json').read_text())['devDependencies']['electron']
        self.assertRegex(version, r'^\d+\.\d+\.\d+$')
        manifest = (ROOT / 'io.github.takmikill.GameTable.yml').read_text()
        self.assertIn(f'/v{version}/electron-v{version}-linux-x64.zip', manifest)
        lock = json.loads((repo / 'package-lock.json').read_text())
        self.assertEqual(lock['packages']['node_modules/electron']['version'], version)
        self.assertEqual(json.loads((ROOT / 'flathub.json').read_text())['only-arches'], ['x86_64'])
        self.assertIn('only-arches: [x86_64]', manifest)
