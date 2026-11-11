"""Compose/config regressions in a clean directory; no daemon or working volumes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ComposeConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copyfile(ROOT / 'docker-compose.yml', self.root / 'docker-compose.yml')
        shutil.copytree(ROOT / 'docker', self.root / 'docker')
        (self.root / '.env').write_text('DB_DATABASE=fixture\nDB_USERNAME=fixture\nDB_PASSWORD=fixture\n')
        self.env = {key: os.environ[key] for key in ('PATH', 'HOME') if key in os.environ}

    def config(self, variables=None):
        return subprocess.run(['docker', 'compose', '--project-name', 'placelens-config-test',
                               '--project-directory', str(self.root), 'config', '--format', 'json'],
                              env=self.env | (variables or {}), capture_output=True, text=True)

    def php_start(self, variables):
        # Stub only the final server exec; run the actual startup validation.
        stub = self.root / 'docker-php-entrypoint'
        stub.write_text('#!/bin/sh\nexit 0\n')
        stub.chmod(0o755)
        return subprocess.run(['sh', str(self.root / 'docker/php/start.sh')],
                              env=self.env | {'PATH': str(self.root) + ':' + self.env['PATH']} | variables,
                              capture_output=True, text=True)

    def variables(self):
        return {'SATELLITE_RUNTIME_DIR': str(self.root / 'runtime'),
                'SATELLITE_DELIVERY_DIR': str(self.root / 'delivery'),
                'SATELLITE_RUNTIME_SHA256': 'a' * 64, 'SATELLITE_DELIVERY_SHA256': 'b' * 64}

    def test_clean_checkout_without_ignored_data(self):
        result = self.config()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        self.assertEqual(set(config['services']), {'nginx', 'php', 'node', 'db'})
        php = config['services']['php']
        self.assertTrue(all(not value for key, value in php['environment'].items() if key.startswith('SATELLITE_')))
        self.assertEqual(self.php_start(php['environment']).returncode, 0)
        for mount in php['volumes'][1:]:
            self.assertEqual(mount['source'], str(self.root / 'docker/satellite-disabled'))
            self.assertTrue(Path(mount['source']).is_dir())
            self.assertTrue(mount['read_only'])
            self.assertFalse(mount['bind']['create_host_path'])
        self.assertEqual(config['services']['nginx']['depends_on']['php']['condition'], 'service_healthy')
        self.assertTrue(config['services']['nginx']['depends_on']['php']['restart'])
        self.assertFalse((self.root / 'data').exists())
        self.assertEqual(config['services']['node']['environment']['FRONTEND_ASSETS_MODE'], 'dev')
        self.assertEqual(config['services']['nginx']['depends_on']['node']['condition'], 'service_healthy')

    def test_partial_activation_rejected_at_start(self):
        variables = self.variables()
        for key in variables:
            with self.subTest(missing=key):
                result = self.config({k: v for k, v in variables.items() if k != key})
                self.assertEqual(result.returncode, 0, result.stderr)
                result = self.php_start(json.loads(result.stdout)['services']['php']['environment'])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Satellite activation requires', result.stderr)

    def test_explicit_read_only_paths_and_pins_without_directory_creation(self):
        variables = self.variables()
        result = self.config(variables)
        self.assertEqual(result.returncode, 0, result.stderr)
        php = json.loads(result.stdout)['services']['php']
        self.assertEqual(self.php_start(php['environment']).returncode, 0)
        for key in ('RUNTIME', 'DELIVERY'):
            target = '/satellite/' + key.lower()
            self.assertEqual(php['environment']['SATELLITE_' + key], target)
            self.assertEqual(php['environment']['SATELLITE_' + key + '_SHA256'], variables['SATELLITE_' + key + '_SHA256'])
            mount = next(v for v in php['volumes'] if v['target'] == target)
            self.assertEqual(mount['source'], variables['SATELLITE_' + key + '_DIR'])
            self.assertTrue(mount['read_only'])
            self.assertFalse(mount['bind']['create_host_path'])
            self.assertFalse(Path(mount['source']).exists())

    def test_invalid_pin_and_mode_rejected(self):
        php = json.loads(self.config(self.variables()).stdout)['services']['php']['environment']
        php['SATELLITE_RUNTIME_SHA256'] = 'untrusted'
        self.assertIn('trusted lowercase SHA-256', self.php_start(php).stderr)
        self.assertNotEqual(self.php_start({'FRONTEND_ASSETS_MODE': 'typo'}).returncode, 0)

    def test_node_rejects_invalid_mode_and_missing_build_without_rebuilding(self):
        for mode, message in [('typo', 'FRONTEND_ASSETS_MODE'), ('build', 'requires public/build/manifest.json')]:
            with self.subTest(mode=mode):
                result = subprocess.run(['sh', str(self.root / 'docker/node/start.sh')],
                                        cwd=self.root, env=self.env | {'FRONTEND_ASSETS_MODE': mode},
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((self.root / 'public/build').exists())

    def test_persisted_modes_survive_ordinary_config(self):
        for mode in ('dev', 'build'):
            with self.subTest(mode=mode):
                with (self.root / '.env').open('a') as f:
                    f.write(f'FRONTEND_ASSETS_MODE={mode}\n')
                for _ in range(2):
                    config = json.loads(self.config().stdout)
                    for service in ('php', 'node'):
                        self.assertEqual(config['services'][service]['environment']['FRONTEND_ASSETS_MODE'], mode)
                self.assertEqual(config['services']['node']['command'], ['sh', 'docker/node/start.sh'])


if __name__ == '__main__':
    unittest.main()
