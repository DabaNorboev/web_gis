"""Circle coverage regression: source footprint != prepared support != usable data."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import rasterio as rio
from rasterio.warp import transform_geom

SPEC = importlib.util.spec_from_file_location('review', Path(__file__).resolve().parents[2] / 'scripts/review-satellite.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class ReviewCircleTest(unittest.TestCase):
    def test_full_circle_denominator_inside_edge_and_outside(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            affine = rio.Affine(10, 0, 0, 0, -10, 0)
            for name in ['usable-mask', 'geographic-mask', 'exclusion-reason', 'ndvi']:
                data = np.full((300, 300), 0 if name in ['exclusion-reason', 'ndvi'] else 1,
                               dtype='float32' if name == 'ndvi' else 'uint8')
                # A nodata hole and a masked pixel, with independent reasons.
                if name == 'ndvi':
                    data[149, 149:151] = -9999
                elif name == 'usable-mask':
                    data[149, 149:151] = 0
                elif name == 'geographic-mask':
                    data[149, 149] = 0
                else:
                    data[149, 149:151] = [1, 5]
                with rio.open(root / (name + '.tif'), 'w', driver='GTiff', count=1, width=300, height=300,
                              crs='EPSG:32646', transform=affine, dtype=data.dtype,
                              nodata=-9999 if name == 'ndvi' else None) as f:
                    f.write(data, 1)
            geometry = {'type': 'Polygon', 'coordinates': [[[-6000, -6000], [9000, -6000], [9000, 6000], [-6000, 6000], [-6000, -6000]]]}
            (root / 'scene.json').write_text(json.dumps({'geometry': transform_geom('EPSG:32646', 'EPSG:4326', geometry)}))
            for radius in [200, 1000]:
                inside = m.circle_coverage(root, 1500, -1500, radius)
                self.assertEqual(inside['source_scene_fraction'], 1)
                self.assertEqual(inside['prepared_fraction'], 1)
                self.assertEqual(inside['nodata_inside_prepared_pixels'], 1)
                self.assertEqual(inside['masked_inside_prepared_pixels'], 1)
                self.assertEqual(inside['usable_pixels'], inside['circle_pixels'] - 2)
                self.assertEqual(inside['mean_ndvi'], 0)  # A real zero is retained.
                edge = m.circle_coverage(root, 0, -1500, radius)
                self.assertEqual(edge['source_scene_fraction'], 1)
                self.assertEqual(edge['prepared_fraction'], .5)
                self.assertEqual(edge['usable_fraction'], .5)
                outside = m.circle_coverage(root, -2000, -1500, radius)
                self.assertEqual(outside['source_scene_fraction'], 1)
                self.assertEqual(outside['prepared_fraction'], 0)
                self.assertIsNone(outside['mean_ndvi'])  # No prepared pixels is unknown, not zero.
                near = m.circle_coverage(root, -300, -1500, radius)
                if radius == 200:
                    self.assertEqual(near['prepared_pixels'], 0)
                else:
                    self.assertGreater(near['prepared_pixels'], 0)
                    self.assertLess(near['prepared_fraction'], .5)


if __name__ == '__main__':
    unittest.main()
