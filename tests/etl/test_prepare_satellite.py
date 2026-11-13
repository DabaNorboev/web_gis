"""Synthetic files only; no network, application, or database."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import rasterio as rio
from rasterio.features import rasterize
from rasterio.warp import transform_geom

SPEC = importlib.util.spec_from_file_location('satellite', Path(__file__).resolve().parents[2] / 'scripts/prepare-satellite.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class SatelliteTest(unittest.TestCase):
    def fixture(self, root):
        affine = rio.Affine(10, 0, 494080, 0, -10, 6213660)
        red = np.full((8, 8), 1000, dtype='uint16')
        nir = np.full((8, 8), 3000, dtype='uint16')
        red[1, 1] = 1
        red[2, 2] = 0
        scl = np.array([[4, 5, 6, 8], [2, 3, 7, 9], [10, 11, 1, 4], [6, 4, 5, 0]], dtype='uint8')
        arrays = {'red': red, 'nir': nir, 'red_jp2': np.where(red == 0, 0, red + 1000).astype('uint16'), 'nir_jp2': nir + 1000,
                  'visual': np.full((3, 8, 8), 100, dtype='uint8'), 'scl': scl}
        for key, array in arrays.items():
            a = array[None] if array.ndim == 2 else array
            with rio.open(root / f'{key}.tif', 'w', driver='GTiff', count=a.shape[0], width=a.shape[2],
                          height=a.shape[1], crs='EPSG:32646', transform=affine * rio.Affine.scale(2 if key == 'scl' else 1),
                          dtype=a.dtype, nodata=None if key.endswith('_jp2') else 0) as f:
                f.write(a)
        (root / 'product.xml').write_text('<root><PRODUCT_URI>test.SAFE</PRODUCT_URI><PROCESSING_BASELINE>05.11</PROCESSING_BASELINE>'
            '<BOA_QUANTIFICATION_VALUE>10000</BOA_QUANTIFICATION_VALUE><BOA_ADD_OFFSET band_id="3">-1000</BOA_ADD_OFFSET>'
            '<BOA_ADD_OFFSET band_id="7">-1000</BOA_ADD_OFFSET></root>')
        (root / 'granule.xml').write_text('<root><SENSING_TIME>2024-08-15T05:13:00.252444Z</SENSING_TIME></root>')
        scene = {'id': 'test', 'properties': {'s2:product_uri': 'test.SAFE', 's2:processing_baseline': '05.11',
                                            'datetime': '2024-08-15T05:13:00.252Z'},
                 'assets': {k: {'href': f'https://example.test/{k}'} for k in ['red', 'nir', 'scl', 'visual']}}
        scene['geometry'] = transform_geom('EPSG:32646', 'EPSG:4326',
            {'type': 'Polygon', 'coordinates': [[[494080, 6213580], [494160, 6213580],
                                                 [494160, 6213660], [494080, 6213660], [494080, 6213580]]]})
        m.write_json(root / 'scenes.json', [scene])
        files = {k: root / f'{k}.tif' for k in arrays}
        files.update(product_xml=root / 'product.xml', granule_xml=root / 'granule.xml', scenes=root / 'scenes.json')
        records = []
        for key, band in [('red', 'B04'), ('nir', 'B08')]:
            records.append({'scene_id': 'test', 'band': band, 'validated': True,
                            'full_tile_counts': {k: 0 for k in ['positive_shift_mismatches', 'nodata_to_nonzero', 'low_to_other', 'original_saturated']},
                            'legacy_sha256': m.sha256(files[key]), 'original_sha256': m.sha256(files[key + '_jp2']),
                            'identity': {'product_uri': 'test.SAFE', 'baseline': '05.11',
                                         'granule_sensing_time': '2024-08-15T05:13:00.252444Z', 'product_xml_sha256': m.sha256(files['product_xml'])},
                            'quantification': 10000, 'product_offset_dn': -1000, 'provider_shift_dn': 1000,
                            'asset_href': scene['assets'][key]['href']})
        m.write_json(root / 'proof.json', {'status': 'native_reference_checked', 'bands': records})
        files['proof'] = root / 'proof.json'
        config = {'schema_version': 1, 'method_version': m.METHOD, 'scene_id': 'test', 'date': '2024-08-15',
                  'territory': 'synthetic fixture', 'window': {'col_off': 1, 'row_off': 1, 'width': 5, 'height': 5},
                  'inputs': {k: {'path': p.name, 'bytes': p.stat().st_size, 'sha256': m.sha256(p),
                                 'source': scene['assets'][k]['href'] if k in scene['assets'] else 'fixture'} for k, p in files.items()}}
        m.write_json(root / 'config.json', config)
        return config, red, nir, scl, affine

    def run_prepare(self, root):
        with contextlib.redirect_stdout(io.StringIO()):
            return m.prepare(root / 'config.json', root, root / 'release')

    def test_real_formula_and_exclusion_priority(self):
        red = np.array([[1000, 0, 1, 65535, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]], dtype='uint16')
        nir = np.full(red.shape, 3000, dtype='uint16')
        scl = np.array([[6, 8, 8, 4, 3, 9, 7, 2, 11, 1, 12, 4]], dtype='uint8')
        ndvi, reasons = m.calculate(red, nir, scl)
        self.assertEqual(reasons.tolist(), [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 0]])
        self.assertEqual(float(ndvi[0, 0]), .5)  # Double offset would yield 1.0.
        self.assertTrue((ndvi[reasons != 0] == m.NODATA).all())
        with self.assertRaisesRegex(ValueError, 'integer'):
            m.calculate(red.astype('float32'), nir, scl)

    def test_end_to_end_grid_nearest_coverage_and_hashes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config, red, nir, scl, affine = self.fixture(root)
            manifest = self.run_prepare(root)
            out = root / 'release'
            expected_scl = np.repeat(np.repeat(scl, 2, axis=0), 2, axis=1)[1:6, 1:6]
            expected_ndvi, expected_reasons = m.calculate(red[1:6, 1:6], nir[1:6, 1:6], expected_scl)
            with rio.open(out / 'scl.tif') as f:
                np.testing.assert_array_equal(f.read(1), expected_scl)
                self.assertEqual(f.transform, affine * rio.Affine.translation(1, 1))
            with rio.open(out / 'ndvi.tif') as f:
                np.testing.assert_array_equal(f.read(1), expected_ndvi)
                self.assertEqual(f.nodata, m.NODATA)
            with rio.open(out / 'exclusion-reason.tif') as f:
                self.assertIsNone(f.nodata)  # Code 0 is valid, never nodata.
                np.testing.assert_array_equal(f.read(1), expected_reasons)
            with rio.open(out / 'ndvi-rgba.tif') as f:
                np.testing.assert_array_equal(f.read(4) == 255, expected_reasons == 0)
            for name in ['geographic', 'usable']:
                geo = json.loads((out / f'{name}-coverage.geojson').read_text())
                with rio.open(out / f'{name}-mask.tif') as f:
                    geoms = [(transform_geom('EPSG:4326', f.crs, x['geometry']), 1) for x in geo['features']]
                    burned = rasterize(geoms, out_shape=f.shape, transform=f.transform)
                    np.testing.assert_array_equal(burned, f.read(1))
            c = manifest['coverage']
            self.assertAlmostEqual(c['valid_fraction'] + c['masked_fraction'] + c['nodata_fraction'], 1)
            self.assertEqual(sum(c['exclusive_reason_counts'].values()), 25)
            for name, a in manifest['assets'].items():
                self.assertEqual(m.sha256(out / name), a['sha256'])
            before = (out / 'manifest.json').read_bytes()
            with self.assertRaisesRegex(ValueError, 'already exists'):
                self.run_prepare(root)
            self.assertEqual(before, (out / 'manifest.json').read_bytes())

    def test_reject_modified_bytes_before_creating_release(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            with (root / 'red.tif').open('ab') as f:
                f.write(b'tamper')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                self.run_prepare(root)
            self.assertFalse((root / 'release').exists())

    def test_reject_wrong_identity_and_double_offset_proof(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config, *_ = self.fixture(root)
            paths = m.pinned_inputs(config, root)
            bad = copy.deepcopy(config)
            bad['date'] = '2024-08-16'
            with self.assertRaisesRegex(ValueError, 'date'):
                m.validate_identity(bad, paths)
            proof = json.loads(paths['proof'].read_text())
            proof['bands'][0]['provider_shift_dn'] = 0
            paths['proof'].write_text(json.dumps(proof))
            with self.assertRaisesRegex(ValueError, 'encoding'):
                m.validate_identity(config, paths)

    def test_reject_shifted_scl_grid(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            config, *_ = self.fixture(root)
            with rio.open(root / 'scl.tif', 'r+') as f:
                f.transform = f.transform * rio.Affine.translation(.5, 0)
            config['inputs']['scl'].update(sha256=m.sha256(root / 'scl.tif'), bytes=(root / 'scl.tif').stat().st_size)
            (root / 'config.json').write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, 'grid'):
                self.run_prepare(root)
            self.assertFalse((root / 'release').exists())

    def test_empty_usable_and_palette_endpoints(self):
        ndvi, reason = m.calculate(np.zeros((2, 2), dtype='uint16'), np.zeros((2, 2), dtype='uint16'), np.zeros((2, 2), dtype='uint8'))
        self.assertEqual(m.coverage_geojson(reason == 0, rio.Affine.identity())['features'], [])
        self.assertFalse(m.colorize(ndvi, reason == 0).any())
        values = np.array([[-1, 0, 1]], dtype='float32')
        colors = m.colorize(values, np.ones(values.shape, dtype=bool))
        self.assertEqual(colors[:3, 0, 0].tolist(), [35, 70, 130])
        self.assertEqual(colors[:3, 0, 2].tolist(), [35, 115, 55])

    def test_palette_all_boundaries_in_stored_float32(self):
        edges = np.asarray(m.EDGES, dtype='float32')
        values = edges[None]
        rgba = m.colorize(values, np.ones(values.shape, dtype=bool))
        expected = [[int(c[i:i+2], 16) for i in (1, 3, 5)] for c in m.COLORS]
        self.assertEqual(rgba[:3, 0].T.tolist(), expected + [expected[-1]])
        # Adjacent representable values must remain on the correct side.
        for index, edge in enumerate(edges[1:-1], 1):
            values = np.array([[np.nextafter(edge, np.float32(-np.inf)), edge,
                                np.nextafter(edge, np.float32(np.inf))]], dtype='float32')
            rgba = m.colorize(values, np.ones(values.shape, dtype=bool))
            self.assertEqual(rgba[:3, 0].T.tolist(), [expected[index-1], expected[index], expected[index]])

    def test_coverage_names_do_not_claim_source_scene_footprint(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.fixture(root)
            manifest = self.run_prepare(root)
            self.assertEqual(manifest['schema_version'], 2)
            self.assertEqual(manifest['coverage']['scope'], 'prepared_window')
            self.assertNotIn('scene_fraction', manifest['coverage'])
            self.assertAlmostEqual(manifest['coverage']['geographic_fraction'],
                                   1 - manifest['coverage']['nodata_fraction'])

    def native_fixture(self, root):
        config, *_ = self.fixture(root)
        window = rio.windows.Window(**config['window'])
        config['input_layout'] = 'native_window'
        proof = json.loads((root/'proof.json').read_text())
        records = []
        for key in ['red', 'nir', 'visual']:
            with rio.open(root/f'{key}.tif') as src:
                data, affine = src.read(window=window), src.window_transform(window)
            path = root/f'{key}-window.tif'
            with rio.open(path, 'w', driver='GTiff', width=5, height=5, count=data.shape[0],
                          crs='EPSG:32646', transform=affine, dtype=data.dtype) as dst:
                dst.write(data)
            config['inputs'][key].update(path=path.name, sha256=m.sha256(path), bytes=path.stat().st_size)
            if key != 'visual':
                old = next(r for r in proof['bands'] if r['band'] == ('B04' if key == 'red' else 'B08'))
                records.append({'scene_id': 'test', 'band': key, 'date': config['date'],
                                'product_uri': 'test.SAFE', 'baseline': '05.11',
                                'sensing_time': '2024-08-15T05:13:00.252444Z',
                                'crop_sha256': config['inputs'][key]['sha256'],
                                'original_sha256': old['original_sha256'], 'product_xml_sha256': old['identity']['product_xml_sha256'],
                                'positive_mismatches': 0, 'library_scale': 1, 'library_offset': 0, 'pixels': 25,
                                'quantification': 10000, 'product_offset_dn': -1000, 'provider_shift_dn': 1000,
                                'asset_href': old['asset_href']})
        (root/'proof.json').write_text(json.dumps({'status': 'window_reference_checked', 'records': records}))
        config['inputs']['proof'].update(sha256=m.sha256(root/'proof.json'), bytes=(root/'proof.json').stat().st_size)
        (root/'config.json').write_text(json.dumps(config))
        return config

    def test_native_window_proof_and_full_jp2_alignment(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.native_fixture(root)
            result = self.run_prepare(root)
            self.assertEqual(result['verification']['input_layout'], 'native_window')
            self.assertEqual(result['grid']['width'], 5)
            self.assertEqual(result['verification']['ndvi_max_absolute_error'], 0)

    def test_native_window_rejects_wrong_scope_or_origin(self):
        for change in ['scope', 'origin', 'status']:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                config = self.native_fixture(root)
                if change == 'origin':
                    config['window']['col_off'] += 1
                else:
                    proof = json.loads((root/'proof.json').read_text())
                    if change == 'scope':
                        proof['records'][0]['pixels'] = 24
                    else:
                        proof['status'] = 'unverified'
                    (root/'proof.json').write_text(json.dumps(proof))
                    config['inputs']['proof'].update(sha256=m.sha256(root/'proof.json'), bytes=(root/'proof.json').stat().st_size)
                (root/'config.json').write_text(json.dumps(config))
                with self.assertRaises(ValueError):
                    self.run_prepare(root)
                self.assertFalse((root/'release').exists())

    def test_xml_five_digit_time_is_preserved(self):
        self.assertEqual(m.utc_time('2024-06-28T05:03:04.80263Z').microsecond, 802630)


if __name__ == '__main__':
    unittest.main()
