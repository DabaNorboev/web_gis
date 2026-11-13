"""Regressions for missing area, clipping, fixed mask policy and source budgets."""
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from period_analysis import np, masks, circle, rio
from period_radiometry import utc_time
from period_fetch import Source


class PeriodTests(unittest.TestCase):
    def test_clipped_and_nodata_never_become_absence_or_valid_area(self):
        red=np.array([[0,1,1534,2000]],dtype=np.uint16)
        nir=np.array([[1706,1706,1706,5000]],dtype=np.uint16)
        ndvi,reasons,variants=masks(red,nir,np.full(red.shape,4,dtype=np.uint8))
        self.assertEqual(reasons.tolist(),[[1,2,0,0]])
        for valid in variants.values():self.assertFalse(valid[0,:2].any())
        # Two observed pixels, one above threshold: denominator is 2, not 4.
        valid=variants['base'];self.assertEqual(float((ndvi[valid]>=.3).mean()),.5)
        self.assertAlmostEqual(ndvi[0,2],172/3240)

    def test_cloud_buffer_reduces_support_without_inventing_values(self):
        red=np.full((21,21),2000,dtype=np.uint16);nir=red*2;scl=np.full(red.shape,4,dtype=np.uint8)
        scl[10,10]=9;scl[1,1]=2
        _,reasons,variants=masks(red,nir,scl)
        self.assertFalse(variants['base'][10,10]);self.assertFalse(variants['base'][1,1])
        self.assertTrue(variants['include_SCL2'][1,1])
        self.assertEqual(int(variants['buffer60'][4:17,4:17].sum()),0)
        self.assertTrue(variants['buffer60'][0,20])
        self.assertFalse(np.any(variants['buffer60']&~variants['base']))

    def test_native_circle_counts_pixel_centres_and_not_bbox(self):
        affine=rio.Affine(10,0,-25,0,-10,25)
        c=circle(affine,(5,5),0,0,10)
        self.assertEqual(int(c.sum()),5)
        self.assertFalse(c[0,0]);self.assertTrue(c[2,2])

    def test_xml_fractional_precision_is_preserved(self):
        a=utc_time('2024-06-28T05:03:04.80263Z')
        self.assertEqual(a.microsecond,802630)
        self.assertEqual(a,utc_time('2024-06-28T05:03:04.802630Z'))
        self.assertEqual((a-utc_time('2024-06-28T05:03:04.802Z')).total_seconds(),.00063)

    def test_request_budget_stops_before_network(self):
        with tempfile.TemporaryDirectory() as folder:
            run=Path(folder);(run/'raw').mkdir()
            (run/'config.json').write_text(json.dumps({'started_at':dt.datetime.now(dt.timezone.utc).isoformat(),
                'budgets':{'http_requests':1,'network_processing_minutes':1}}))
            (run/'requests.jsonl').write_text('{"bytes": 1}\n')
            with patch('period_fetch.requests.request') as network:
                with self.assertRaisesRegex(RuntimeError,'budget'):Source(run).get('x','https://example.invalid')
                network.assert_not_called()


if __name__=='__main__':unittest.main()
