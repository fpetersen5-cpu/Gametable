import importlib.util
import json
import tempfile
import unittest
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReleaseChecks(unittest.TestCase):
    def test_public_github_urls_and_local_build_rewrite_match(self):
        source = 'https://github.com/fpetersen5-cpu/Gametable.git'
        homepage = 'https://github.com/fpetersen5-cpu/Gametable'
        manifest = (ROOT / 'io.github.takmikill.GameTable.yml').read_text()
        metadata = (ROOT / 'io.github.takmikill.GameTable.metainfo.xml').read_text()
        builder = (ROOT / 'build.sh').read_text()
        self.assertIn(f'url: {source}', manifest)
        self.assertIn(f'<url type="homepage">{homepage}</url>', metadata)
        self.assertIn(f'<url type="bugtracker">{homepage}/issues</url>', metadata)
        self.assertIn(source, builder)
        self.assertNotIn('github.com/takmikill/gametable', manifest + metadata + builder)

    def test_public_url(self):
        load('release-preflight').validate_repo_url('https://downloads.gametable.app/repo/')

    def test_reject_placeholder_and_malformed_urls(self):
        validate = load('release-preflight').validate_repo_url
        for url in ['', 'https://example.invalid/repo/', 'https://example.com/repo/',
                    'https://localhost/repo/', 'http://host.org/repo/',
                    'https://192.168.0.1/repo/', 'https://127.0.0.2/repo/',
                    'https://host.org:bad/repo/', 'https://host.org:0/repo/',
                    'https://user:secret@host.org/repo/', 'https://host.org/repo',
                    'https://host.org/repo/?token=secret', 'https://host.org/repo/#x',
                    'https://host.org/repo/\nGPGKey=bad']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate(url)

    def test_explicit_test_override_does_not_allow_injection(self):
        validate = load('release-preflight').validate_repo_url
        validate('https://example.invalid/repo/', allow_test=True)
        with self.assertRaises(ValueError):
            validate('https://example.invalid/repo/\nGPGKey=bad', allow_test=True)

    def test_release_script_rejects_placeholder_before_building(self):
        env = dict(os.environ, GAMETABLE_GPG_KEY='test-placeholder-key',
                   GAMETABLE_REPO_URL='https://example.invalid/repo/')
        env.pop('GAMETABLE_ALLOW_TEST_RELEASE', None)
        result = subprocess.run(['bash', str(ROOT / 'release.sh')], env=env,
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Placeholder/local repository URL', result.stderr)
        self.assertNotIn('Building module', result.stdout)

    def test_source_order_is_ignored_but_changed_contents_and_duplicates_are_not(self):
        check = load('check-node-sources').check
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / 'a.json', Path(directory) / 'b.json'
            original = [{'url': 'one', 'sha256': 'aaa'}, {'url': 'two', 'sha256': 'bbb'}]
            a.write_text(json.dumps(original))
            b.write_text(json.dumps(original[::-1]))
            check(a, b)
            b.write_text(json.dumps([{'url': 'one', 'sha256': 'changed'}, original[1]]))
            with self.assertRaises(ValueError):
                check(a, b)
            b.write_text(json.dumps([original[0], original[0], original[1]]))
            with self.assertRaises(ValueError):
                check(a, b)

    def test_empty_source_list_is_not_accepted(self):
        check = load('check-node-sources').check
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'empty.json'
            path.write_text('[]')
            with self.assertRaises(ValueError):
                check(path, path)
