"""Synthetic filesystem regression; PHP only, no Laravel, DB or router calls."""
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

PHP = shutil.which('php')
HELPER = pathlib.Path(__file__).resolve().parents[2] / 'experiments/routing-clicks/audit-filesystem.php'
SOURCE = '''<?php
namespace App\\Services\\Routing;
class RoutingGeometryGuard {
    public function reference(): string {
        return file_get_contents(__DIR__.'/geometry.sql').file_get_contents(__DIR__.'/connector-issues.sql');
    }
    public function source(): string { return __FILE__; }
    public function literal(): string { return '__DIR__'; }
}
'''
RUN = r'''
require $argv[1];
try {
    $result = \PlaceLens\RoutingClicks\withOriginalGuard($argv[2], static function ($path) use ($argv) {
        require $path;
        $guard = new \App\Services\Routing\OriginalRoutingGeometryGuard;
        $result = ['reference' => $guard->reference(), 'source' => $guard->source(),
                   'literal' => $guard->literal(), 'temporary' => $path];
        if ($argv[3] === 'error') { throw new RuntimeException('synthetic audit failure'); }
        if ($argv[3] === 'exit') { exit(7); }
        return $result;
    });
    \PlaceLens\RoutingClicks\writeAuditResults($argv[4], $result);
} catch (Throwable $error) {
    fwrite(STDERR, get_class($error).': '.$error->getMessage());
    exit(3);
}
'''


@unittest.skipUnless(PHP, 'PHP CLI is required')
class AuditAdmissionsFilesystemTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='admissions-fixture-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.original = self.root / 'historical'
        self.original.mkdir()
        self.source = self.original / 'RoutingGeometryGuard.php'
        self.source.write_text(SOURCE)
        (self.original / 'geometry.sql').write_bytes(b'geometry reference\n')
        (self.original / 'connector-issues.sql').write_bytes(b'connector reference\n')
        (self.original / 'OriginalRoutingGeometryGuard.php').write_bytes(b'historical sentinel\x00\n')
        self.scratch = self.root / 'temporary'
        self.scratch.mkdir()
        (self.scratch / 'unrelated').write_bytes(b'not owned by loader\n')
        self.output = self.root / 'result.json'

    def snapshot(self):
        return {str(p.relative_to(self.original)): p.read_bytes() if p.is_file() else None
                for p in self.original.rglob('*')}

    def run_case(self, mode='success'):
        before = self.snapshot()
        result = subprocess.run([PHP, '-d', f'sys_temp_dir={self.scratch}', '-r', RUN,
                                 '--', str(HELPER), str(self.source), mode, str(self.output)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual({p.name for p in self.scratch.iterdir()}, {'unrelated'})
        self.assertEqual((self.scratch / 'unrelated').read_bytes(), b'not owned by loader\n')
        return result

    def test_loading_preserves_relative_sql_and_source_identity(self):
        result = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        output = json.loads(self.output.read_text())
        self.assertEqual(output['reference'], 'geometry reference\nconnector reference\n')
        self.assertEqual(output['source'], str(self.source))
        self.assertEqual(output['literal'], '__DIR__')
        temporary = pathlib.Path(output['temporary'])
        self.assertEqual(temporary.parent.parent, self.scratch)
        self.assertFalse(temporary.parent.exists())

    def test_callback_error_cleans_only_its_temporary_files(self):
        result = self.run_case('error')
        self.assertEqual(result.returncode, 3)
        self.assertIn('synthetic audit failure', result.stderr)
        self.assertFalse(self.output.exists())

    def test_loading_error_cleans_temporary_files(self):
        self.source.write_text(SOURCE.replace('public function reference()', 'invalid syntax function reference()'))
        result = self.run_case()
        self.assertEqual(result.returncode, 3)
        self.assertIn('ParseError', result.stderr)
        self.assertFalse(self.output.exists())

    def test_exit_also_cleans_temporary_files(self):
        result = self.run_case('exit')
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stderr, '')
        self.assertFalse(self.output.exists())

    def test_existing_results_and_symlinks_are_not_overwritten(self):
        sentinel = self.root / 'saved.json'
        sentinel.write_bytes(b'previous result\x00\n')
        for kind in ['file', 'link', 'dangling-link']:
            with self.subTest(kind=kind):
                if kind == 'file':
                    self.output.write_bytes(b'previous result\x00\n')
                else:
                    self.output.symlink_to(sentinel if kind == 'link' else self.root / 'absent')
                try:
                    result = self.run_case()
                    self.assertEqual(result.returncode, 3)
                    self.assertIn('Cannot create a new audit output file', result.stderr)
                    self.assertEqual(sentinel.read_bytes(), b'previous result\x00\n')
                    if kind == 'file':
                        self.assertEqual(self.output.read_bytes(), b'previous result\x00\n')
                    else:
                        self.assertTrue(self.output.is_symlink())
                        self.assertFalse((self.root / 'absent').exists())
                finally:
                    self.output.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
