"""Small synthetic release files; no real data, network or database."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

import test_prepare_satellite as fixtures

SPEC = importlib.util.spec_from_file_location('index', Path(__file__).resolve().parents[2]/'scripts/index-satellite.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class IndexTest(unittest.TestCase):
    def release(self, root):
        helper = fixtures.SatelliteTest()
        helper.fixture(root)
        helper.run_prepare(root)
        return root/'release/manifest.json'

    def build(self, manifests, output):
        with contextlib.redirect_stdout(io.StringIO()):
            return m.build_index(manifests, output)

    def test_local_index_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manifest = self.release(root)
            output = root/'index.json'
            result = self.build([manifest], output)
            self.assertEqual(result['releases'][0]['manifest'], 'release/manifest.json')
            self.assertEqual(result['releases'][0]['manifest_sha256'], m.sha256(manifest))
            before = output.read_bytes()
            with self.assertRaisesRegex(ValueError, 'already exists'):
                self.build([manifest], output)
            self.assertEqual(before, output.read_bytes())

    def test_reject_incomplete_damaged_and_incompatible(self):
        for failure in ['missing_manifest', 'missing_asset', 'checksum', 'version', 'grid', 'coverage', 'duplicate']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                manifest = self.release(root)
                data = json.loads(manifest.read_text())
                if failure == 'missing_manifest':
                    manifest = root/'not-prepared/manifest.json'
                elif failure == 'missing_asset':
                    del data['assets']['ndvi.tif']
                elif failure == 'checksum':
                    with (manifest.parent/'ndvi.tif').open('ab') as f:
                        f.write(b'damaged')
                elif failure == 'version':
                    data['legend_version'] = 'ndvi-fixed-v1'
                elif failure == 'grid':
                    data['grid']['transform'][2] += 10
                elif failure == 'coverage':
                    data['coverage']['scope'] = 'source_scene'
                if manifest.is_file():
                    manifest.write_text(json.dumps(data))
                with self.assertRaises((ValueError, FileNotFoundError)):
                    self.build([manifest] * (2 if failure == 'duplicate' else 1), root/'index.json')
                self.assertFalse((root/'index.json').exists())

    def test_reject_different_common_extent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            first = root/'first'; first.mkdir()
            second = root/'second'; second.mkdir()
            one = self.release(first)
            helper = fixtures.SatelliteTest(); config, *_ = helper.fixture(second)
            config['window']['col_off'] += 1
            (second/'config.json').write_text(json.dumps(config))
            helper.run_prepare(second)
            with self.assertRaisesRegex(ValueError, 'geometry or rules'):
                self.build([one, second/'release/manifest.json'], root/'index.json')
            self.assertFalse((root/'index.json').exists())


if __name__ == '__main__':
    # Importing fixture support must not run its test class a second time.
    unittest.main(defaultTest='IndexTest')
