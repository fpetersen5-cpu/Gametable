import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch


script = Path(__file__).resolve().parents[1] / 'migrate-flatpak-data.py'
spec = importlib.util.spec_from_file_location('migration', script)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.old = root / 'old' / 'config' / 'GameTable'
        self.new = root / 'new' / 'config' / 'GameTable'
        self.old.mkdir(parents=True)
        (self.old / 'matches').mkdir()
        (self.old / 'live').mkdir()
        (self.old / 'config.json').write_text('{"humanName":"Tester"}')
        (self.old / 'results.jsonl').write_text('{"seat":"s1"}\n')
        (self.old / 'matches' / 'm-123.json').write_text('{"gameId":"coup"}')
        (self.old / 'secrets.json').write_text('{"apiKey":"DO-NOT-COPY-SECRET"}')
        (self.old / 'secrets.enc').write_bytes(b'DO-NOT-COPY-ENCRYPTED')
        (self.old / 'live' / 'm-123.json').write_text('{"role":"hidden"}')

    def test_dry_run_never_creates_new_data(self):
        destinations = migration.migrate(self.old, self.new)
        self.assertEqual({path.name for path in destinations}, {'config.json', 'results.jsonl', 'm-123.json'})
        self.assertFalse(self.new.exists())

    def test_apply_copies_only_whitelisted_data_with_private_permissions(self):
        with patch.object(migration, 'ensure_stopped'):
            migration.migrate(self.old, self.new, apply=True)
        self.assertEqual((self.new / 'config.json').read_text(), '{"humanName":"Tester"}')
        self.assertEqual((self.new / 'matches' / 'm-123.json').read_text(), '{"gameId":"coup"}')
        self.assertEqual({path.name for path in self.new.iterdir()}, {'config.json', 'results.jsonl', 'matches'})
        self.assertFalse((self.new / 'secrets.enc').exists())
        self.assertFalse((self.new / 'secrets.json').exists())
        self.assertFalse((self.new / 'live').exists())
        self.assertTrue((self.old / 'secrets.enc').exists())
        for path in (self.new, self.new.parent, self.new / 'matches'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        for path in (self.new / 'config.json', self.new / 'results.jsonl', self.new / 'matches' / 'm-123.json'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_refuses_existing_destination_without_overwriting(self):
        self.new.mkdir(parents=True)
        (self.new / 'config.json').write_text('new data')
        with patch.object(migration, 'ensure_stopped'):
            with self.assertRaisesRegex(ValueError, 'Refusing to overwrite'):
                migration.migrate(self.old, self.new, apply=True)
        self.assertEqual((self.new / 'config.json').read_text(), 'new data')
        self.assertFalse((self.new / 'results.jsonl').exists())

    def test_refuses_source_and_target_symlinks(self):
        (self.old / 'matches' / 'm-evil.json').symlink_to(self.old / 'secrets.json')
        with self.assertRaisesRegex(ValueError, 'Not a regular file'):
            migration.migrate(self.old, self.new)
        (self.old / 'matches' / 'm-evil.json').unlink()
        self.new.parent.mkdir(parents=True)
        self.new.symlink_to(self.old, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Not a real directory'):
            migration.migrate(self.old, self.new)

    def test_refuses_running_apps_or_in_sandbox(self):
        with patch.dict(os.environ, {'FLATPAK_ID': migration.NEW_ID}):
            with self.assertRaisesRegex(ValueError, 'on the host'):
                migration.ensure_stopped()
        with patch.dict(os.environ, {}, clear=True), patch.object(migration.subprocess, 'run') as run:
            run.return_value.stdout = migration.OLD_ID + '\n'
            with self.assertRaisesRegex(ValueError, 'Close both'):
                migration.ensure_stopped()
