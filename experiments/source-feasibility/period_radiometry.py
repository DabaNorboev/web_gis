"""Validate new scene encodings only inside the acquired window; reuse old proof."""
import argparse
import datetime as dt
import json
import re
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, 'data/reports/source-feasibility/2026-11-03-radiometry-01/python-libs')
import numpy as np
import rasterio as rio
from rasterio.windows import Window
from check_radiometry import text, sha256
from radiometry import verified_recipes, dn_to_reflectance


def utc_time(value):
    # Python 3.10 accepts 3/6 fractional digits; XML can legally contain five.
    value=re.sub(r'\.(\d+)(?=Z|[+-]\d\d:)',lambda m:'.'+m[1].ljust(6,'0'),value)
    return dt.datetime.fromisoformat(value.replace('Z','+00:00'))


def check(run, attempt):
    output=run/'derived'/attempt;output.mkdir(exist_ok=False)
    old=Path('data/reports/source-feasibility/2026-11-03-a2-01')
    previous=Path('data/reports/source-feasibility/2026-11-03-radiometry-01')
    win=Window(**json.loads((run/'window.json').read_text())['window'])
    scenes=json.loads((run/'selected-scenes.json').read_text())
    retained=next(s for s in scenes if s['properties']['datetime'].startswith('2024-08-15'))
    verified_recipes(previous/'derived/native-comparison-v2/evidence.json',[retained],old/'raw')
    records=[];arrays={}
    for scene in scenes:
        date=scene['properties']['datetime'][:10];p=scene['properties']
        if date=='2024-08-15':
            product=previous/'raw/2024-original-product.xml';granule=previous/'raw/2024-granule_metadata.xml'
        else:
            product=run/'raw'/f'{date}-product.xml';granule=run/'raw'/f'{date}-granule_metadata.xml'
        xml=ET.parse(product).getroot();gx=ET.parse(granule).getroot()
        assert text(xml,'PRODUCT_URI')==p['s2:product_uri']
        assert text(xml,'PROCESSING_BASELINE')==p['s2:processing_baseline']
        assert text(xml,'SPACECRAFT_NAME').replace('Sentinel-','S')==scene['id'][:3]
        assert '_T46VDH_' in p['s2:product_uri'] and '_T46VDH_' in text(gx,'TILE_ID')
        delta=abs((utc_time(text(gx,'SENSING_TIME'))-utc_time(p['datetime'])).total_seconds())
        assert delta < .001
        q=int(text(xml,'BOA_QUANTIFICATION_VALUE'))
        offsets={e.attrib['band_id']:int(e.text) for e in xml.iter() if e.tag.split('}')[-1]=='BOA_ADD_OFFSET'}
        for key,band,band_id in [('red','B04','3'),('nir','B08','7')]:
            original=previous/'raw'/f'2024-original-{band}.jp2' if date=='2024-08-15' else run/'raw'/f'{date}-original-{band}.jp2'
            crop=run/'raw'/f'{date}-{key}-window.tif'
            with rio.open(original) as src, rio.open(crop) as cog:
                assert src.crs==cog.crs and src.window_transform(win)==cog.transform
                assert src.scales==cog.scales==(1.0,) and src.offsets==cog.offsets==(0.0,)
                a=src.read(1,window=win);b=cog.read(1)
                assert a.shape==b.shape and a.dtype==b.dtype==np.uint16
            offset=offsets[band_id]
            assert q==10000 and offset==-1000
            good=(a>1000)&(a!=65535);low=(a>0)&(a<=1000);nodata=a==0
            mismatch=int((good&(b.astype(np.int32)!=a.astype(np.int32)+offset)).sum())
            assert mismatch==0 and np.all(b[nodata]==0) and np.all(b[low]==1)
            assert not np.any(a==65535), 'Unestablished saturation encoding; stop'
            for rr,cc in [(a.shape[0]//2,a.shape[1]//2),(0,0)]:
                if b[rr,cc]>1:
                    assert dn_to_reflectance(int(b[rr,cc]),quantification=q,product_offset_dn=offset,provider_shift_dn=1000)==dn_to_reflectance(int(a[rr,cc]),quantification=q,product_offset_dn=offset,provider_shift_dn=0)
            record={'date':date,'scene_id':scene['id'],'product_uri':p['s2:product_uri'],
                    'baseline':p['s2:processing_baseline'],'satellite':p['platform'],'sensing_time':text(gx,'SENSING_TIME'),
                    'band':key,'asset_href':scene['assets'][key]['href'],'crop_sha256':sha256(crop),
                    'original_sha256':sha256(original),'product_xml_sha256':sha256(product),
                    'quantification':q,'product_offset_dn':offset,'provider_shift_dn':1000,
                    'scope':'acquired native window only; old full-tile proof reused for 2024-08-15',
                    'pixels':a.size,'positive_mismatches':mismatch,'original_low_1_1000':int(low.sum()),
                    'cog_dn1':int((b==1).sum()),'nodata':int(nodata.sum()),'library_scale':1,'library_offset':0}
            records.append(record);arrays[f'{date}_{key}_jp2']=a
    (output/'proof.json').write_text(json.dumps({'status':'window_reference_checked','records':records},indent=2)+'\n')
    np.savez_compressed(output/'original-windows.npz',**arrays)
    print(json.dumps(records,indent=2))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',type=Path,required=True)
    p.add_argument('--attempt',required=True);a=p.parse_args();check(a.run,a.attempt)
