#!/usr/bin/env python3
"""Offline derived fixed-record tiles for bounded PHP circle reads. No source acquisition."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import resource
import time

import numpy as np
import rasterio as rio
from rasterio.windows import Window
from rasterio.warp import transform_geom

from satellite_city import validate_city_release, sha256, save, REASONS

DTYPE=np.dtype([('ndvi','<f4'),('reason','u1'),('source','u1'),('target','u1'),('geographic','u1')])
VERSIONS={'method_version':'placelens-s2-date-v1','mask_version':'scl456-dn-city-v1','legend_version':'ndvi-fixed-v2'}


def build(index_path,metadata_path,output):
    started=time.perf_counter()
    if output.exists():raise ValueError('Runtime output already exists')
    spec=importlib.util.spec_from_file_location('satellite_index',Path(__file__).with_name('index-satellite.py'))
    indexer=importlib.util.module_from_spec(spec);spec.loader.exec_module(indexer)
    index=json.loads(index_path.read_text());metadata=json.loads(metadata_path.read_text())
    if index.get('schema_version')!=2 or not 1<=len(index['releases'])<=6:raise ValueError('City index required')
    if metadata.get('schema_version')!=1:raise ValueError('Metadata schema')
    # Validate immutable sources once, offline. No ETL/radiometry rerun.
    releases=[];signature=None
    for entry in index['releases']:
        path=index_path.parent/entry['manifest']
        if sha256(path)!=entry['manifest_sha256']:raise ValueError('Index/manifest hash')
        m,sig=validate_city_release(path)
        if signature is not None and signature!=sig:raise ValueError('Incompatible city releases')
        signature=sig
        if m['observation_date']!=entry['date'] or [s['scene_id'] for s in m['scenes']]!=entry['scene_ids']:raise ValueError('Index identity')
        if any(m[k]!=index[k] for k in VERSIONS) or sig['grid']!=index['grid']:raise ValueError('Index rules/grid')
        annotation=metadata['releases'].get(path.parent.name)
        if annotation is None or annotation['manifest_sha256']!=entry['manifest_sha256']:raise ValueError('Unpinned date annotations')
        releases.append((path,m,annotation))
    output.mkdir(parents=True,exist_ok=False)
    result={'schema_version':1,'format':'placelens-satellite-cells-v1','status':'verified_offline_runtime',
            'source_index':{'path':str(index_path),'sha256':sha256(index_path)},
            'annotations':{'path':str(metadata_path),'sha256':sha256(metadata_path)},'grid':index['grid'],
            **VERSIONS,'target_sha256':signature['target_sha256'],'record_bytes':8,'tile_side':256,
            'record_layout':'little-endian float32 NDVI, uint8 reason/source/target/geographic',
            'reason_codes':REASONS,'releases':[]}
    totals={}
    for path,m,annotation in releases:
        date=m['observation_date'];directory=output/'cells'/date;directory.mkdir(parents=True)
        record={'date':date,'release_id':path.parent.name,'manifest_sha256':sha256(path),
                'scenes':m['scenes'],'limitations':m['limitations'],'warnings':annotation['warnings'],
                'source_assignment':m['source_assignment'],'source_footprints':[], 'tiles':{}}
        footprints=json.loads((path.parent/'source-footprints.geojson').read_text())
        for feature in footprints['features']:
            record['source_footprints'].append(transform_geom('EPSG:4326','EPSG:32646',feature['geometry']))
        counts={k:0 for k in REASONS};valid_count=0
        with rio.open(path.parent/'ndvi.tif') as ndvi,rio.open(path.parent/'exclusion-reason.tif') as reason, \
             rio.open(path.parent/'source-tile.tif') as source,rio.open(path.parent/'target-mask.tif') as target, \
             rio.open(path.parent/'geographic-mask.tif') as geo,rio.open(path.parent/'usable-mask.tif') as usable:
            for row in range(0,ndvi.height,256):
                for col in range(0,ndvi.width,256):
                    height,width=min(256,ndvi.height-row),min(256,ndvi.width-col);win=Window(col,row,width,height)
                    a=np.empty((height,width),dtype=DTYPE)
                    for key,src in [('ndvi',ndvi),('reason',reason),('source',source),('target',target),('geographic',geo)]:a[key]=src.read(1,window=win)
                    valid=usable.read(1,window=win)>0
                    assert np.array_equal(valid,a['reason']==0) and np.array_equal(a['ndvi']==-9999,~valid)
                    assert np.isfinite(a['ndvi']).all() and np.all(np.abs(a['ndvi'][valid])<=1)
                    assert np.isin(a['target'],[0,1]).all() and np.isin(a['geographic'],[0,1]).all()
                    assert np.all(a['reason'][a['target']==0]==12)
                    assert np.all(a['geographic'][valid]==1) and np.all(a['target'][valid]==1)
                    assert np.isin(a['source'],range(len(m['scenes'])+1)).all()
                    for k in counts:counts[k]+=int(((a['target']==1)&(a['reason']==k)).sum())
                    valid_count+=int(valid.sum());raw=a.tobytes();name=f'{row//256}-{col//256}.bin';p=directory/name
                    with p.open('xb') as f:f.write(raw)
                    # Reopen all derived bytes now; runtime only verifies tiles it touches.
                    assert p.read_bytes()==raw
                    key=f'{row//256}-{col//256}'
                    record['tiles'][key]={'path':str(p.relative_to(output)),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        assert valid_count==m['coverage']['usable_pixels']
        assert all(counts[k]==m['coverage']['exclusive_reason_counts'][REASONS[k]] for k in counts if k!=12)
        result['releases'].append(record);totals[date]=valid_count
    (output/'source-index.json').write_bytes(index_path.read_bytes())
    (output/'annotations.json').write_bytes(metadata_path.read_bytes())
    save(output/'catalog.json',result)
    save(output/'build-evidence.json',{'seconds':time.perf_counter()-started,'peak_RSS_KiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
         'catalog_sha256':sha256(output/'catalog.json'),'source_hashes_verified':True,'derived_bytes_reopened':True,
         'valid_pixels':totals,'output_bytes_before_evidence':sum(p.stat().st_size for p in output.rglob('*') if p.is_file()),
         'builder_sha256':sha256(Path(__file__))})
    print(json.dumps({'catalog':str(output/'catalog.json'),'trusted_sha256':sha256(output/'catalog.json'),'seconds':time.perf_counter()-started}))


def verify(directory,expected):
    path=directory/'catalog.json'
    if sha256(path)!=expected:raise ValueError('Untrusted runtime catalog')
    catalog=json.loads(path.read_text())
    if sha256(directory/'source-index.json')!=catalog['source_index']['sha256'] or sha256(directory/'annotations.json')!=catalog['annotations']['sha256']:raise ValueError('Corrupt provenance snapshot')
    for release in catalog['releases']:
        for tile in release['tiles'].values():
            p=directory/tile['path']
            if not p.resolve().is_relative_to(directory.resolve()) or p.stat().st_size!=tile['bytes'] or sha256(p)!=tile['sha256']:raise ValueError('Corrupt runtime tile')
    print('All runtime tile hashes verified')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--index',type=Path);p.add_argument('--metadata',type=Path)
    p.add_argument('--output',type=Path);p.add_argument('--verify',type=Path);p.add_argument('--sha256');a=p.parse_args()
    with rio.Env(GDAL_CACHEMAX=32*1024*1024,GDAL_NUM_THREADS='1'):
        if a.verify:verify(a.verify,a.sha256)
        else:build(a.index,a.metadata,a.output)
