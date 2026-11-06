"""Synthetic runtime preparation only; no new Sentinel ETL or network."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import rasterio as rio

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import test_satellite_city as fixture_module

def module(name,file):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).resolve().parents[2]/'scripts'/file)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=module('runtime','prepare-satellite-runtime.py');indexer=module('indexer','index-satellite.py')

class RuntimeTest(unittest.TestCase):
    def fixture(self,root):
        f=fixture_module.CityTest();f.fixture(root);f.prepare(root)
        indexer.build_index([root/'release/manifest.json'],root/'index.json')
        manifest=root/'release/manifest.json'
        (root/'metadata.json').write_text(json.dumps({'schema_version':1,'releases':{'release':{'manifest_sha256':m.sha256(manifest),'warnings':[{'code':'FIXTURE','message':'Synthetic only'}]}}}))

    def test_cells_exactly_preserve_values_masks_and_provenance(self):
        with tempfile.TemporaryDirectory() as td,contextlib.redirect_stdout(io.StringIO()):
            root=Path(td);self.fixture(root);m.build(root/'index.json',root/'metadata.json',root/'runtime')
            c=json.loads((root/'runtime/catalog.json').read_text());self.assertEqual(c['releases'][0]['warnings'][0]['code'],'FIXTURE')
            a=np.fromfile(root/'runtime/cells/2026-06-06/0-0.bin',dtype=m.DTYPE)
            for key,name in [('ndvi','ndvi'),('reason','exclusion-reason'),('source','source-tile'),('target','target-mask'),('geographic','geographic-mask')]:
                with rio.open(root/'release'/(name+'.tif')) as src:self.assertTrue(np.array_equal(a[key],src.read(1).ravel()))
            m.verify(root/'runtime',m.sha256(root/'runtime/catalog.json'))
            p=root/'runtime/cells/2026-06-06/0-0.bin';raw=p.read_bytes();p.write_bytes(b'X'+raw[1:])
            with self.assertRaisesRegex(ValueError,'Corrupt runtime tile'):m.verify(root/'runtime',m.sha256(root/'runtime/catalog.json'))
            with self.assertRaisesRegex(ValueError,'already exists'):m.build(root/'index.json',root/'metadata.json',root/'runtime')

    def test_unpinned_annotations_and_changed_source_block_build(self):
        with tempfile.TemporaryDirectory() as td,contextlib.redirect_stdout(io.StringIO()):
            root=Path(td);self.fixture(root);metadata=root/'metadata.json';d=json.loads(metadata.read_text());d['releases']['release']['manifest_sha256']='0'*64;metadata.write_text(json.dumps(d))
            with self.assertRaisesRegex(ValueError,'Unpinned date annotations'):m.build(root/'index.json',metadata,root/'runtime')
            self.assertFalse((root/'runtime').exists())
            p=root/'release/ndvi.tif';raw=p.read_bytes();p.write_bytes(raw[:-1]+b'X')
            with self.assertRaisesRegex(ValueError,'Input checksum'):m.build(root/'index.json',metadata,root/'runtime')

if __name__=='__main__':unittest.main()
