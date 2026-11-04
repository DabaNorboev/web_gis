"""Small regressions for actual A2 failure modes; fully offline."""
import json
from pathlib import Path
import tempfile
import unittest

from air import load_api
from analyze import utm46
from fetch import fetch
from radiometry import dn_to_reflectance, verified_recipes


class PrototypeTests(unittest.TestCase):
    def test_wgs84_equator_reference(self):
        x, y = utm46(93, 0)
        self.assertEqual((x, y), (500000, 0))
        x, y = utm46(90, 0)
        self.assertAlmostEqual(x, 166021.4430805406, places=3)
        self.assertEqual(y, 0)

    def test_http_200_error_envelope_is_not_access_to_measurements(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'error.json'
            path.write_text(json.dumps({'status': {'code': -1, 'message': 'Invalid interval'}}))
            with self.assertRaises(ValueError):
                load_api(path)

    def test_existing_raw_file_refused_before_network(self):
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp)
            (run/'config.json').write_text('{}')
            (run/'raw').mkdir()
            target = run/'raw/input.json'
            target.write_text('synthetic preserved input')
            with self.assertRaises(ValueError):
                fetch(run, 'input.json', 'https://example.invalid')
            self.assertEqual(target.read_text(), 'synthetic preserved input')

    def test_provider_shift_and_product_offset_are_applied_once(self):
        jp2 = {'quantification': 10000, 'product_offset_dn': -1000, 'provider_shift_dn': 0}
        cog = jp2 | {'provider_shift_dn': 1000}
        # The same verified pixel in two integer encodings, not two different baselines.
        self.assertAlmostEqual(dn_to_reflectance(2534, **jp2), .1534)
        self.assertEqual(dn_to_reflectance(2534, **jp2), dn_to_reflectance(1534, **cog))
        self.assertNotAlmostEqual(dn_to_reflectance(1534, **cog), .0534)
        red, nir = dn_to_reflectance(1534, **cog), dn_to_reflectance(1706, **cog)
        self.assertAlmostEqual((nir-red)/(nir+red), 172/3240)

    def test_reflectance_cannot_be_passed_as_raw_dn_again(self):
        recipe = {'quantification': 10000, 'product_offset_dn': -1000, 'provider_shift_dn': 1000}
        value = dn_to_reflectance(1534, **recipe)
        with self.assertRaises(TypeError):
            dn_to_reflectance(value, **recipe)

    def test_nodata_saturation_and_clipped_low_values_remain_unknown(self):
        jp2 = {'quantification': 10000, 'product_offset_dn': -1000, 'provider_shift_dn': 0}
        cog = jp2 | {'provider_shift_dn': 1000}
        self.assertIsNone(dn_to_reflectance(0, **jp2))
        self.assertIsNone(dn_to_reflectance(65535, **jp2))
        self.assertIsNone(dn_to_reflectance(1, **cog))
        self.assertAlmostEqual(dn_to_reflectance(990, **jp2), -.001)

    def test_metadata_flags_alone_do_not_authorize_a_transform(self):
        with self.assertRaises(ValueError):
            verified_recipes(None, [], Path('/not-read'))


if __name__ == '__main__':
    unittest.main()
