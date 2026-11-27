"""Filesystem integrity and activation failures, using only temporary synthetic data."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deploy_runtime', Path(__file__).resolve().parents[1] / 'ops/deploy-runtime.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kuvi-deploy-test-')
        self.root = Path(self.temp.name) / 'runtime'
        (self.root / 'dist/app').mkdir(parents=True)
        (self.root / 'node_modules/.bin').mkdir(parents=True)
        (self.root / 'dist/app/server.js').write_text('synthetic')
        (self.root / 'package.json').write_text('{}')
        (self.root / 'node_modules/cli.js').write_text('synthetic cli')
        (self.root / 'node_modules/.bin/cli').symlink_to('../cli.js')

    def tearDown(self):
        self.temp.cleanup()

    def test_identical_copy_with_internal_links(self):
        import shutil
        clone = Path(self.temp.name) / 'clone'
        shutil.copytree(self.root, clone, symlinks=True)
        self.assertEqual(deploy.fingerprint(self.root), deploy.fingerprint(clone))

    def test_content_change_is_detected(self):
        original = deploy.fingerprint(self.root)
        (self.root / 'dist/app/server.js').write_text('changed')
        self.assertNotEqual(original, deploy.fingerprint(self.root))

    def test_external_symlink_is_rejected(self):
        link = self.root / 'node_modules/.bin/cli'
        link.unlink()
        link.symlink_to('/etc/passwd')
        with self.assertRaisesRegex(deploy.DeploymentError, 'EXTERNAL_RUNTIME_SYMLINK'):
            deploy.fingerprint(self.root)

    def test_unexpected_files_and_environment_are_rejected(self):
        (self.root / '.env').write_text('synthetic')
        with self.assertRaises(deploy.DeploymentError):
            deploy.fingerprint(self.root)
        (self.root / '.env').unlink()
        (self.root / 'node_modules/.env').write_text('synthetic')
        with self.assertRaisesRegex(deploy.DeploymentError, 'ENVIRONMENT_IN_RUNTIME'):
            deploy.fingerprint(self.root)

    def test_rollback_refuses_modified_artifacts(self):
        original = deploy.fingerprint(self.root)
        link = self.root / 'node_modules/.bin/cli'
        link.unlink()
        link.symlink_to('../../dist/app/server.js')
        self.assertNotEqual(original, deploy.fingerprint(self.root))


class ActivationTests(unittest.TestCase):
    def exercise(self, probes, restart_failures=()):
        pointers = ['old']
        restarts = []
        results = iter(probes)
        def switch(target):
            pointers.append(target)
        def restart():
            restarts.append(pointers[-1])
            if len(restarts) in restart_failures:
                raise RuntimeError('synthetic restart failure')
        def activate():
            deploy.transition('new', 'old', switch, restart, lambda: next(results))
        return pointers, restarts, activate

    def test_success_activates_only_new_release(self):
        pointers, restarts, activate = self.exercise([True])
        activate()
        self.assertEqual(pointers, ['old', 'new'])
        self.assertEqual(restarts, ['new'])

    def test_unhealthy_release_restores_and_checks_previous(self):
        pointers, restarts, activate = self.exercise([False, True])
        with self.assertRaisesRegex(deploy.DeploymentError, 'PREVIOUS_RELEASE_RESTORED'):
            activate()
        self.assertEqual(pointers[-1], 'old')
        self.assertEqual(restarts, ['new', 'old'])

    def test_restart_failure_restores_previous(self):
        pointers, restarts, activate = self.exercise([True], restart_failures=(1,))
        with self.assertRaisesRegex(deploy.DeploymentError, 'PREVIOUS_RELEASE_RESTORED'):
            activate()
        self.assertEqual(pointers[-1], 'old')
        self.assertEqual(restarts, ['new', 'old'])

    def test_failed_rollback_is_reported(self):
        _, _, activate = self.exercise([False, False])
        with self.assertRaisesRegex(deploy.DeploymentError, 'ROLLBACK_REQUIRES_ADMINISTRATOR'):
            activate()

    def test_pointer_failure_restores_previous_before_restart(self):
        calls = []
        def switch(target):
            calls.append(target)
            if target == 'new':
                raise OSError('synthetic pointer failure after replacement')
        with self.assertRaisesRegex(deploy.DeploymentError, 'PREVIOUS_RELEASE_RESTORED'):
            deploy.transition('new', 'old', switch, lambda: calls.append('restart'), lambda: True)
        self.assertEqual(calls, ['new', 'old', 'restart'])


if __name__ == '__main__':
    unittest.main()
