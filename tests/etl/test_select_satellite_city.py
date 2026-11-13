"""A9.4 synthetic geometry/SCL tests only; never contacts Earth Search."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import numpy as np
import rasterio as rio
from rasterio.warp import transform_geom
from shapely.geometry import box, mapping

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))

SPEC=importlib.util.spec_from_file_location('selection',Path(__file__).resolve().parents[2]/'scripts/select-satellite-city.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)


def wgs(geom):
    return transform_geom(m.CRS,'EPSG:4326',mapping(geom))


class SelectionTest(unittest.TestCase):
    def quiet(self, fn, *args):
        with contextlib.redirect_stdout(io.StringIO()):
            return fn(*args)

    def test_search_uses_explicit_year_and_fixed_seasons(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'raw').mkdir()
            m.save(root/'target.geojson',{'geometry':wgs(box(490000,6200000,491000,6201000))})
            m.save(root/'config.json',{'year':2024});urls=[]
            class Source:
                def __init__(self, run):pass
                def get(self, name, url):
                    urls.append(url);m.save(root/'raw'/name,{'features':[],'links':[]})
                    return {'status':200}
            with patch.object(m,'Source',Source):self.quiet(m.search,root)
            self.assertEqual([parse_qs(urlsplit(u).query)['datetime'][0] for u in urls],
                ['2024-05-01T00:00:00Z/2024-06-30T23:59:59Z','2024-08-01T00:00:00Z/2024-09-30T23:59:59Z'])

    def test_older_item_native_tileinfo_identity(self):
        item={'properties':{'s2:product_uri':'product.SAFE','grid:code':'MGRS-46VDH','datetime':'2024-05-07T05:13:00Z'},'assets':{}}
        info={'productName':'product','path':'tiles/46/V/DH/2024/5/7/0'}
        self.assertEqual(m.native_tile_url(item,info),'https://sentinel-s2-l2a.s3.amazonaws.com/'+info['path'])
        for bad in [{'productName':'other','path':info['path']},{**info,'path':'tiles/46/V/EH/2024/5/7/0'},
                    {**info,'path':'tiles/46/V/DH/2024/5/8/0'},{**info,'path':'tiles/46/V/DH/2024/5/7/../0'}]:
            with self.assertRaises(AssertionError):m.native_tile_url(item,bad)

    def test_http_journal_zero_body_failure_and_no_partial_bypass(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'raw').mkdir();p=root/'raw/data.bin';p.write_bytes(b'abc')
            good={'name':'data.bin','status':200,'bytes':3,'sha256':m.digest(p)}
            failed={'name':'data.bin','error':'TLS handshake failed','bytes':0,'sha256':hashlib.sha256(b'').hexdigest()}
            m.verify_http_records(root,[failed,good])
            with self.assertRaises(AssertionError):m.verify_http_records(root,[{**failed,'bytes':1}])
            p.write_bytes(b'bad')
            with self.assertRaises(AssertionError):m.verify_http_records(root,[good])

    def test_metric_buffer_and_boundary_pin(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            source=root/'boundary.geojson'
            m.save(source,{'type':'Feature','properties':{'source':'synthetic'},'geometry':wgs(box(490000,6200000,491000,6201000))})
            m.save(root/'config.json',{'boundary':str(source),'boundary_sha256':m.digest(source),'buffer_m':1000})
            self.quiet(m.init,root)
            meta=json.loads((root/'target-metrics.json').read_text())
            self.assertAlmostEqual(meta['boundary_area_m2'],1e6,places=1)
            self.assertAlmostEqual(meta['target_area_m2'],1e6+4e6+np.pi*1e6,delta=400)
            self.assertEqual(m.target(root)['properties']['buffer_crs'],'EPSG:32646')
            self.assertGreater(meta['bounding_pixels_10m'],0)
            with self.assertRaises(FileExistsError):
                self.quiet(m.init,root)

    def item(self, sid, geom, date='2026-05-02', take='pass1', cloud=0):
        return {'id':sid,'geometry':wgs(geom),'properties':{'datetime':date+'T05:00:00Z','platform':'sentinel-2b',
                's2:datatake_id':take,'eo:cloud_cover':cloud,'s2:product_uri':sid+'.SAFE','s2:processing_baseline':'05.12'},
                'assets':{'scl':{'href':'https://example.test/'+sid+'.tif'}}}

    def test_full_coverage_requires_same_observation_and_minimal_tiles(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);area=box(490000,6200000,490080,6200040)
            m.save(root/'target.geojson',{'geometry':wgs(area)})
            left=box(489990,6199990,490040.1,6200050);right=box(490039.9,6199990,490090,6200050)
            items=[self.item('a',left),self.item('b',right),self.item('c',left),
                   self.item('other_day_left',left,date='2026-05-03'),
                   self.item('other_day_right',right,date='2026-05-04'),
                   self.item('other_pass_left',left,take='pass2'),self.item('other_pass_right',right,take='pass3')]
            for season in ['early','late']:
                m.save(root/f'{season}-items.json',items)
            self.quiet(m.rank,root)
            groups=json.loads((root/'selection-v2/catalog-groups.json').read_text())
            complete=[r for r in groups if r['full_footprint_coverage']]
            self.assertEqual(len(complete),2)  # Same single complete pass, once per synthetic period.
            self.assertTrue(all([i['id'] for i in r['items']]==['a','b'] for r in complete))
            self.assertTrue(all(r['uncovered_m2']>0 for r in groups if r['datatake']!='pass1' or r['date']!='2026-05-02'))

    def test_entire_polygon_scl_denominator_and_no_quality_cherry_picking(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'raw').mkdir();(root/'selection-v2').mkdir()
            # An L-shape covering five cell centers, not all nine bbox cells.
            area=box(490000,6200000,490020,6200060).union(box(490000,6200000,490060,6200020))
            m.save(root/'target.geojson',{'geometry':wgs(area)});m.save(root/'config.json',{})
            items=[self.item('a',box(489990,6199990,490070,6200070)),self.item('b',box(489990,6199990,490070,6200070))]
            a=np.array([[4,4,4],[3,4,4],[0,11,5]],dtype='uint8')
            for item,data in [(items[0],a),(items[1],np.full((3,3),4,dtype='uint8'))]:
                with rio.open(root/'raw'/f'{item["id"]}-scl.tif','w',driver='GTiff',count=1,height=3,width=3,dtype='uint8',
                              crs=m.CRS,transform=rio.Affine(20,0,490000,0,-20,6200060),nodata=0) as f:
                    f.write(data,1)
            m.save(root/'selection-v2/shortlist.json',[{'season':'early','date':'2026-05-02','items':items}])
            self.quiet(m.assess,root)
            r=json.loads((root/'selection-v2/scl-assessment.json').read_text())['results'][0]
            self.assertEqual(r['total_target_pixels_20m'],5)
            self.assertEqual(r['reasons']['usable_SCL456'],2)
            self.assertEqual(r['reasons']['cloud_shadow_SCL3'],1)
            self.assertEqual(r['reasons']['snow_SCL11'],1)
            self.assertEqual(r['reasons']['nodata_SCL0'],1)
            self.assertEqual(r['fractions']['usable_SCL456'],.4)
            self.assertEqual(r['uncovered_target_pixels'],0)


if __name__=='__main__':
    unittest.main()
