#!/usr/bin/env python3
"""Offline PNG XYZ delivery from immutable prepared RGBA; no acquisition/NDVI calculation."""
import argparse, hashlib, json, math, time, resource
from pathlib import Path
import numpy as np
import rasterio as rio
from rasterio.warp import transform_bounds, Resampling
from rasterio.vrt import WarpedVRT
from rasterio.transform import from_bounds
from PIL import Image


def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def build(runtime, pin, index, output):
    start=time.perf_counter()
    if output.exists(): raise ValueError('New output required')
    if digest(runtime/'catalog.json')!=pin: raise ValueError('Runtime pin')
    c=json.loads((runtime/'catalog.json').read_text()); idx=json.loads(index.read_text())
    if c['legend_version']!='ndvi-fixed-v2': raise ValueError('Legend version')
    if digest(index)!=c['source_index']['sha256']: raise ValueError('Index mismatch')
    out={'schema_version':1,'reader_sha256':pin,'legend_version':c['legend_version'],'legend':None,'releases':{},'tiles':{}}
    output.mkdir(parents=True)
    extent=20037508.342789244
    for r in c['releases']:
        entry=next(e for e in idx['releases'] if e['date']==r['date'])
        manifest=index.parent/entry['manifest']
        if digest(manifest)!=r['manifest_sha256']: raise ValueError('Manifest mismatch')
        m=json.loads(manifest.read_text()); root=manifest.parent
        legend=json.loads((root/'legend.json').read_text())
        if out['legend'] is not None and out['legend']!=legend: raise ValueError('Legend mismatch')
        out['legend']=legend
        out['releases'][r['date']]={'manifest_sha256':r['manifest_sha256']}
        for layer,name in [('true-color','true-color.tif'),('ndvi','ndvi-rgba.tif')]:
            asset=next(a for a in m['assets'].values() if a.get('path')==name) if isinstance(m['assets'],dict) else next(a for a in m['assets'] if a['path']==name)
            if digest(root/name)!=asset['sha256']: raise ValueError('Asset hash')
            with rio.open(root/name) as src:
                assert src.count in (3,4)
                mask=None
                if src.count==3:
                    if digest(root/'tci-valid-mask.tif')!=m['assets']['tci-valid-mask.tif']['sha256']: raise ValueError('Mask hash')
                    mask=rio.open(root/'tci-valid-mask.tif')
                out['bounds']=list(transform_bounds(src.crs,'EPSG:4326',*src.bounds,densify_pts=21))
                bounds=transform_bounds(src.crs,'EPSG:3857',*src.bounds,densify_pts=21)
                for z in range(10,14):
                    span=extent*2/(2**z)
                    x0=max(0,math.floor((bounds[0]+extent)/span));x1=min(2**z-1,math.floor((bounds[2]+extent)/span))
                    y0=max(0,math.floor((extent-bounds[3])/span));y1=min(2**z-1,math.floor((extent-bounds[1])/span))
                    for x in range(x0,x1+1):
                        for y in range(y0,y1+1):
                            a=np.zeros((4,256,256),dtype='uint8')
                            transform=from_bounds(-extent+x*span,extent-(y+1)*span,-extent+(x+1)*span,extent-y*span,256,256)
                            options=dict(crs='EPSG:3857',transform=transform,width=256,height=256,tolerance=1e-9,resampling=Resampling.nearest)
                            with WarpedVRT(src,**options) as vrt: a[:src.count]=vrt.read()
                            if mask is not None:
                                with WarpedVRT(mask,**options) as vrt: a[3]=vrt.read(1)*255
                            a[:3,a[3]==0]=0
                            key=f'{r["date"]}/{layer}/{z}/{x}/{y}'
                            p=output/(key+'.png');p.parent.mkdir(parents=True,exist_ok=True)
                            Image.fromarray(a.transpose(1,2,0),'RGBA').save(p)
                            assert np.array_equal(np.asarray(Image.open(p)),a.transpose(1,2,0))
                            if p.stat().st_size>300000: raise ValueError('PNG budget')
                            out['tiles'][key]={'bytes':p.stat().st_size,'sha256':digest(p)}
            if mask is not None: mask.close()
    if len(json.dumps(out).encode())>2*1024*1024: raise ValueError('Catalog budget')
    (output/'catalog.json').write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')))
    result={'pin':digest(output/'catalog.json'),'seconds':time.perf_counter()-start,'peak_RSS_KiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'bytes':sum(p.stat().st_size for p in output.rglob('*') if p.is_file()),'tiles':len(out['tiles'])}
    (output/'build-evidence.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--runtime',type=Path,required=True);p.add_argument('--sha256',required=True);p.add_argument('--index',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();build(a.runtime,a.sha256,a.index,a.output)
