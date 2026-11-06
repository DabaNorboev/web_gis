"""Synthetic rasters/XML only. These fixtures are not real Sentinel validation."""
import contextlib
import copy
import io
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import rasterio as rio
from rasterio.warp import transform_geom
from shapely.geometry import mapping,box

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import satellite_city as m


def wgs(geom):return transform_geom(m.CRS,'EPSG:4326',mapping(geom))


class CityTest(unittest.TestCase):
    def fixture(self, root, block=3, invalid=None):
        tiles=[]
        geom=box(494090,6213590,494190,6213650).difference(box(494170,6213630,494200,6213660))
        target={'type':'Feature','properties':{'buffer_m':1000,'source':'synthetic'},'geometry':wgs(geom)}
        m.save(root/'target.geojson',target);m.save(root/'boundary.geojson',target)
        for index,(tile_name,x) in enumerate([('46VDH',494080),('46VEH',494120)],1):
            sid=f'S2C_{tile_name}_20260606_0_L2A'
            product=f'S2C_MSIL2A_20260606T050651_N0512_R019_T{tile_name}_20260606T080908.SAFE'
            acquired='2026-06-06T05:12:57.937122Z';take='GS2C_20260606T050651_009141_N05.12'
            affine=rio.Affine(10,0,x,0,-10,6213660)
            red=np.full((8,8),1000,dtype='uint16');nir=np.full((8,8),3000 if index==1 else 5000,dtype='uint16')
            scl=np.full((4,4),4,dtype='uint8')
            if index==1:
                scl[1,2:]=8  # Cloudy preferred tile in the overlap; second tile is clear/high NDVI.
                red[5,2]=1
            jr=np.where(red==1,500,red.astype('int32')+1000).astype('uint16')
            jn=(nir+1000).astype('uint16')
            if invalid=='encoding' and index==2:jr[:]=65000
            arrays={'red':red,'nir':nir,'red_jp2':jr,'nir_jp2':jn,'scl':scl,
                    'visual':np.stack([np.full((8,8),80+index*40,dtype='uint8')]*3)}
            inputs={}
            for key,array in arrays.items():
                p=root/f'{tile_name}-{key}.tif';a=array[None] if array.ndim==2 else array
                with rio.open(p,'w',driver='GTiff',width=a.shape[2],height=a.shape[1],count=len(a),dtype=a.dtype,
                              crs=m.CRS,transform=affine*rio.Affine.scale(2 if key=='scl' else 1),
                              nodata=None if key.endswith('_jp2') else 0) as f:f.write(a)
                inputs[key]={'path':str(p),'bytes':p.stat().st_size,'sha256':m.sha256(p),'source':f'https://example.test/{sid}/{key}'}
            product_path=root/f'{tile_name}-product.xml'
            product_path.write_text(f'<root><PRODUCT_URI>{product}</PRODUCT_URI><PROCESSING_BASELINE>05.12</PROCESSING_BASELINE>'
                '<SPACECRAFT_NAME>Sentinel-2C</SPACECRAFT_NAME><BOA_QUANTIFICATION_VALUE>10000</BOA_QUANTIFICATION_VALUE>'
                '<BOA_ADD_OFFSET band_id="3">-1000</BOA_ADD_OFFSET><BOA_ADD_OFFSET band_id="7">-1000</BOA_ADD_OFFSET>'
                f'<Datatake datatakeIdentifier="{take}"/></root>')
            granule=root/f'{tile_name}-granule.xml';granule.write_text(f'<root><SENSING_TIME>{acquired}</SENSING_TIME><TILE_ID>S2C_TEST_T{tile_name}_TEST</TILE_ID></root>')
            for key,p in [('product_xml',product_path),('granule_xml',granule)]:
                inputs[key]={'path':str(p),'bytes':p.stat().st_size,'sha256':m.sha256(p),'source':'synthetic XML'}
            item={'id':sid,'geometry':wgs(box(x,6213580,x+80,6213660)),
                  'properties':{'s2:product_uri':product,'s2:processing_baseline':'05.12','datetime':'2026-06-06T05:12:57.937Z','s2:datatake_id':take},
                  'assets':{k:{'href':inputs[k]['source']} for k in ['red','nir','visual','scl']}}
            tiles.append({'scene_id':sid,'product_uri':product,'tile':'MGRS-'+tile_name,'platform':'sentinel-2c','baseline':'05.12',
                          'acquired_at_catalog':item['properties']['datetime'],'acquired_at_granule':acquired,'datatake':take,
                          'date':'2026-06-06','stac_item':item,'inputs':inputs})
        if invalid=='observation':tiles[1]['datatake']='different-pass'
        record={'observation_date':'2026-06-06','tiles':tiles,
                'target':{'path':str(root/'target.geojson'),'bytes':(root/'target.geojson').stat().st_size,'sha256':m.sha256(root/'target.geojson')},
                'boundary':{'path':str(root/'boundary.geojson'),'bytes':(root/'boundary.geojson').stat().st_size,'sha256':m.sha256(root/'boundary.geojson')},
                'acquisition':{'synthetic':True}}
        m.save(root/'inputs.json',record)
        cfg={'schema_version':3,'inputs_manifest':str(root/'inputs.json'),'inputs_sha256':m.sha256(root/'inputs.json'),'block_size':block}
        m.save(root/'recipe.json',cfg)
        return cfg

    def prepare(self, root, name='release'):
        with contextlib.redirect_stdout(io.StringIO()),rio.Env(GDAL_CACHEMAX=32*1024*1024,GDAL_NUM_THREADS='1'):
            return m.prepare(root/'recipe.json',root/name)

    def test_bounded_blocks_full_target_and_geometric_overlap(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);self.fixture(root);manifest=self.prepare(root);out=root/'release'
            self.assertEqual(manifest['schema_version'],3)
            self.assertLess(manifest['coverage']['target_pixels'],manifest['coverage']['rectangle_pixels'])
            self.assertEqual(manifest['coverage']['target_pixels'],56)
            self.assertEqual(sum(manifest['coverage']['source_assignment_pixels'].values()),56)
            self.assertGreater(manifest['coverage']['overlap_target_pixels'],0)
            with rio.open(out/'source-tile.tif') as src,rio.open(out/'exclusion-reason.tif') as reasons,rio.open(out/'true-color.tif') as rgb,rio.open(out/'ndvi.tif') as ndvi:
                assignment=src.read(1);reason=reasons.read(1);color=rgb.read(1)
                self.assertTrue(np.all(color[assignment==1]==120))
                self.assertTrue(np.all(color[assignment==2]==160))
                # x=494135 is in both footprints: cloudy tile 1 remains selected.
                row,col=src.index(494135,6213635)
                self.assertEqual(int(assignment[row,col]),1)
                self.assertEqual(int(reason[row,col]),5)
                self.assertEqual(float(ndvi.read(1)[row,col]),-9999)
            with rio.open(out/'target-mask.tif') as a, rio.open(out/'footprint-mask.tif') as f, rio.open(out/'geographic-mask.tif') as g, rio.open(out/'tci-valid-mask.tif') as t:
                outside=a.read(1)==0
                self.assertTrue(outside.any())
                self.assertTrue(np.all(f.read(1)==1))  # Source covers the bbox, even outside the prepared AOI.
                self.assertTrue(np.all(g.read(1)[outside]==0))
                self.assertTrue(np.all(t.read(1)[outside]==0))
            m.validate_city_release(out/'manifest.json')
            before=(out/'manifest.json').read_bytes()
            with self.assertRaisesRegex(ValueError,'already exists'):self.prepare(root)
            self.assertEqual(before,(out/'manifest.json').read_bytes())

    def test_block_size_does_not_change_pixel_values(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);cfg=self.fixture(root,block=3);self.prepare(root,'a')
            cfg['block_size']=5;(root/'recipe.json').write_text(json.dumps(cfg));self.prepare(root,'b')
            for name in m.LAYER_SPECS:
                with rio.open(root/'a'/name) as a,rio.open(root/'b'/name) as b:
                    np.testing.assert_array_equal(a.read(),b.read())

    def test_reject_unknown_encoding_mixed_observation_and_modified_input(self):
        for invalid in ['encoding','observation','checksum']:
            with self.subTest(invalid=invalid),tempfile.TemporaryDirectory() as td:
                root=Path(td);self.fixture(root,invalid=invalid)
                if invalid=='checksum':
                    with (root/'46VDH-red.tif').open('ab') as f:f.write(b'changed')
                with self.assertRaises(ValueError):self.prepare(root)
                self.assertFalse((root/'release/manifest.json').exists())

    def test_circle_denominator_inside_edge_outside_and_seam(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);self.fixture(root);self.prepare(root);out=root/'release'
            inside=m.circle_city(out,494115,6213605,10)
            self.assertEqual(inside['prepared_fraction'],1)
            outside=m.circle_city(out,493000,6213600,200)
            self.assertEqual(outside['prepared_pixels'],0);self.assertIsNone(outside['mean_ndvi'])
            edge=m.circle_city(out,494090,6213605,20)
            self.assertGreater(edge['prepared_fraction'],0);self.assertLess(edge['prepared_fraction'],1)
            seam=m.circle_city(out,494160,6213605,20)
            self.assertEqual(set(seam['source_pixels']),{'1','2'})
            self.assertEqual(sum(seam['source_pixels'].values()),seam['prepared_pixels'])

    def test_acquisition_rejects_outside_seasons_and_unselected_dates(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);selection=root/'selection.json'
            m.save(selection,{'proposals':[]})
            m.save(root/'config.json',{'selection_manifest':str(selection),
                   'selection_sha256':m.sha256(selection),'date':'2025-07-09'})
            with self.assertRaisesRegex(ValueError,'Only selected seasonal'):
                m.acquire(root)
            cfg=json.loads((root/'config.json').read_text());cfg['date']='2025-09-09'
            (root/'config.json').write_text(json.dumps(cfg))
            with self.assertRaisesRegex(ValueError,'Date missing from pinned selection'):
                m.acquire(root)

    def test_reused_full_input_requires_selected_source_size_and_hash(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'selection-v2').mkdir();p=root/'reference.jp2';p.write_bytes(b'abc')
            tile={'scene_id':'synthetic','native_JP2_availability':{'B04':{'source':'https://example.test/reference','bytes':3}}}
            selection=root/'selection-v2/selection-manifest.json'
            m.save(selection,{'proposals':[{'date':'2024-08-15','tiles':[tile]}]})
            m.save(root/'selection-v2/shortlist.json',[{'date':'2024-08-15','items':[]}])
            ref={'path':str(p),'source':'https://example.test/reference','bytes':3,'sha256':m.sha256(p)}
            for bad in [{**ref,'source':'https://example.test/other'},{**ref,'bytes':4},{**ref,'sha256':'0'*64}]:
                cfg={'selection_manifest':str(selection),'selection_sha256':m.sha256(selection),
                     'date':'2024-08-15','tiles':[tile],'reuse_inputs':{'synthetic':{'red_jp2':bad}}}
                (root/'config.json').write_text(json.dumps(cfg))
                with self.assertRaisesRegex(ValueError,'Reused source/size|Input checksum'):m.acquire(root)

    def test_block_limit_and_clipped_read(self):
        with self.assertRaisesRegex(ValueError,'512'):list(m.blocks(100,100,513))
        wins=list(m.blocks(1300,900,512))
        self.assertEqual(sum(int(w.width*w.height) for w in wins),1300*900)
        self.assertTrue(all(w.width*w.height<=512**2 for w in wins))

    def test_six_city_releases_index_and_limit(self):
        spec=importlib.util.spec_from_file_location('city_index',Path(__file__).resolve().parents[2]/'scripts/index-satellite.py')
        index=importlib.util.module_from_spec(spec);spec.loader.exec_module(index)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);manifests=[]
            for date in ['2024-06-06','2024-09-09','2025-06-06','2025-09-09','2026-06-06','2026-09-09']:
                run=root/date;run.mkdir();self.fixture(run)
                # Change the complete synthetic identity, not just the final manifest date.
                for p in run.iterdir():
                    if p.suffix in ['.xml','.json']:
                        p.write_text(p.read_text().replace('2026-06-06',date).replace('20260606',date.replace('-','')))
                record=json.loads((run/'inputs.json').read_text())
                for tile in record['tiles']:
                    for a in tile['inputs'].values():a['sha256']=m.sha256(Path(a['path']));a['bytes']=Path(a['path']).stat().st_size
                m_path=run/'inputs.json';m_path.write_text(json.dumps(record))
                cfg=json.loads((run/'recipe.json').read_text());cfg['inputs_sha256']=m.sha256(m_path)
                (run/'recipe.json').write_text(json.dumps(cfg));self.prepare(run)
                manifests.append(run/'release/manifest.json')
            with contextlib.redirect_stdout(io.StringIO()):result=index.build_index(manifests,root/'six.json')
            self.assertEqual(len(result['releases']),6)
            self.assertEqual(result['schema_version'],2)
            with self.assertRaisesRegex(ValueError,'at most six'):index.build_index(manifests+[manifests[0]],root/'seven.json')

    def test_city_index_accepts_schema3_and_rejects_incomplete(self):
        spec=importlib.util.spec_from_file_location('city_index',Path(__file__).resolve().parents[2]/'scripts/index-satellite.py')
        index=importlib.util.module_from_spec(spec);spec.loader.exec_module(index)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);self.fixture(root);self.prepare(root);manifest=root/'release/manifest.json'
            with contextlib.redirect_stdout(io.StringIO()):result=index.build_index([manifest],root/'index.json')
            self.assertEqual(result['schema_version'],2)
            self.assertEqual(result['scope'],'target_polygon_pixel_centers')
            self.assertEqual(len(result['releases'][0]['scene_ids']),2)
            data=json.loads(manifest.read_text());del data['assets']['source-tile.tif'];manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError,'Incomplete'):index.build_index([manifest],root/'bad-index.json')
            self.assertFalse((root/'bad-index.json').exists())


if __name__=='__main__':unittest.main()
