"""Failure-path tests for the isolated experiment; never invokes Docker."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import run as runner


class RunnerCleanup(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.out = self.root / 'evidence'
        self.out.mkdir()
        self.pbf = self.root / 'input.pbf'
        self.pbf.write_bytes(b'frozen synthetic PBF placeholder, never parsed')
        (self.out / 'freeze.json').write_text(json.dumps({'inputs': {
            'input.pbf': {'sha256': hashlib.sha256(self.pbf.read_bytes()).hexdigest()}}}))
        self.calls = []
        self.attach_failure = None
        self.final_diagnostics_fail = False
        self.start_failure = False
        self.cleanup_failure = False
        self.exec_count = 0

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        if args[:2] == ('image', 'inspect'):
            return 'sha256:helper-immutable\n'
        if args[0] == 'create':
            if '--entrypoint' in args:
                return 'cid-main\n'
            self.assertIn('sha256:helper-immutable', args)
            return 'cid-ready\n' if '-c' in args else 'cid-probe\n'
        if args[0] == 'start':
            if args[1:] == ('cid-main',) and self.start_failure:
                raise subprocess.CalledProcessError(1, ['docker', *args])
            if '--attach' in args:
                if args[-1] == self.attach_failure:
                    raise subprocess.TimeoutExpired(['docker', *args], 1, output=b'partial')
                return json.dumps({'ready': True} if args[-1] == 'cid-ready' else {'rows': []})
            return ''
        if args[0] == 'exec':
            self.exec_count += 1
            if self.final_diagnostics_fail and self.exec_count > 1:
                raise subprocess.CalledProcessError(1, ['docker', *args])
            return '123\nusage_usec 42\n'
        if args[0] == 'inspect':
            if self.final_diagnostics_fail:
                raise ValueError('synthetic diagnostic failure')
            return '[{"HostConfig":{"NetworkMode":"none"}}]'
        if args[0] == 'rm':
            if self.cleanup_failure and args[-1] == 'cid-main':
                raise subprocess.CalledProcessError(1, ['docker', *args])
            return ''
        raise AssertionError(('Unexpected Docker command', args, kwargs))

    def invoke(self):
        with patch.object(runner, 'ROOT', self.root), patch.object(runner, 'PBF', self.pbf), \
                patch.object(runner, 'docker', side_effect=self.docker), \
                patch.object(runner.subprocess, 'run', return_value=SimpleNamespace(stdout='', stderr='')), \
                patch.object(sys, 'argv', ['run.py', 'walking', '--output', str(self.out)]), \
                contextlib.redirect_stdout(io.StringIO()):
            runner.main()

    def result(self):
        return json.loads((self.out / 'walking/runtime.json').read_text())

    def removed(self):
        return [args[-1] for args in self.calls if args[0] == 'rm']

    def test_optional_diagnostics_failure_still_cleans_and_records(self):
        self.final_diagnostics_fail = True
        self.invoke()
        self.assertEqual(self.removed(), ['cid-ready', 'cid-probe', 'cid-main'])
        self.assertEqual(self.result()['outcome'], 'PROBED')
        self.assertEqual({row['step'] for row in self.result()['collection_errors']}, {'cgroup', 'inspect'})

    def test_helper_timeouts_clean_helpers_and_main_and_preserve_failure(self):
        for container_id in ('cid-ready', 'cid-probe'):
            with self.subTest(container_id=container_id):
                # Each attempted run requires its own fresh evidence directory.
                if (self.out / 'walking').exists():
                    self.out = self.root / 'second-evidence'
                    self.out.mkdir()
                    (self.out / 'freeze.json').write_text((self.root / 'evidence/freeze.json').read_text())
                self.calls.clear()
                self.attach_failure = container_id
                with self.assertRaises(subprocess.TimeoutExpired):
                    self.invoke()
                self.assertIn(container_id, self.removed())
                self.assertEqual(self.removed()[-1], 'cid-main')
                self.assertEqual(self.result()['outcome'], 'FAILED')
                self.assertEqual(self.result()['error_stdout'], 'partial')

    def test_main_start_failure_removes_created_container(self):
        self.start_failure = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke()
        self.assertEqual(self.removed(), ['cid-main'])
        self.assertEqual(self.result()['outcome'], 'FAILED')

    def test_changed_frozen_input_never_invokes_docker(self):
        self.pbf.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'Frozen input hash mismatch'):
            self.invoke()
        self.assertEqual(self.calls, [])

    def test_existing_output_is_not_overwritten(self):
        (self.out / 'walking').mkdir()
        sentinel = self.out / 'walking/runtime.json'
        sentinel.write_text('existing historical evidence')
        with self.assertRaises(FileExistsError):
            self.invoke()
        self.assertEqual(self.calls, [])
        self.assertEqual(sentinel.read_text(), 'existing historical evidence')

    def test_cleanup_failure_is_recorded_and_not_success(self):
        self.cleanup_failure = True
        with self.assertRaisesRegex(RuntimeError, 'cleanup failed'):
            self.invoke()
        self.assertEqual(self.result()['outcome'], 'CLEANUP_FAILED')
        self.assertEqual(self.result()['cleanup_errors'][0]['container_id'], 'cid-main')


if __name__ == '__main__':
    unittest.main()
