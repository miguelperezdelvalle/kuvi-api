import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('nas_credentials', Path(__file__).resolve().parents[1] / 'ops/update-nas-credentials.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CredentialTests(unittest.TestCase):
    def test_changes_only_password_preserves_account_domain_and_equals(self):
        result = module.credentials_with_password('username=kuvi_backup\npassword=old\ndomain=WORKGROUP\n', 'new=synthetic')
        self.assertEqual(result, 'username=kuvi_backup\npassword=new=synthetic\ndomain=WORKGROUP\n')

    def test_rejects_empty_and_multiline_passwords(self):
        for value in ('', 'test\nusername=other', 'test\r', 'test\0'):
            with self.assertRaises(module.RotationError):
                module.credentials_with_password('username=kuvi_backup\npassword=synthetic\n', value)

    def test_rejects_unexpected_or_duplicate_account_fields(self):
        for value in ('username=admin\npassword=synthetic\n', 'username=kuvi_backup\nusername=other\npassword=synthetic\n', 'username=kuvi_backup\nunknown=value\n'):
            with self.assertRaises(module.RotationError):
                module.credentials_with_password(value, 'synthetic')

    def test_atomic_replacement_is_private_and_leaves_no_temporary_files(self):
        with tempfile.TemporaryDirectory(prefix='kuvi-credential-test-') as folder:
            path = Path(folder) / 'credentials'
            path.write_text('old synthetic credential')
            module.atomic_write(path, b'new synthetic credential')
            self.assertEqual(path.read_bytes(), b'new synthetic credential')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(folder).iterdir()), [path])

    def test_symlink_is_rejected_without_modifying_its_target(self):
        with tempfile.TemporaryDirectory(prefix='kuvi-credential-test-') as folder:
            target = Path(folder) / 'target'
            target.write_text('preserve synthetic bytes')
            link = Path(folder) / 'credentials'
            link.symlink_to(target)
            with self.assertRaises(module.RotationError):
                module.atomic_write(link, b'replacement')
            self.assertEqual(target.read_text(), 'preserve synthetic bytes')


if __name__ == '__main__':
    unittest.main()
