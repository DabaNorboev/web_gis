"""Independent numeric aggregation from original DN, and artifact/source checks."""
import argparse
import csv
import json
import math
from pathlib import Path
import sqlite3
import statistics
import sys

sys.path.insert(0,'data/reports/source-feasibility/2026-11-03-radiometry-01/python-libs')
import numpy as np
from PIL import Image
from check_radiometry import sha256


def verify(run,attempt,proof_attempt,output_name,presentation=None):
    data=run/'derived'/attempt
    records=json.loads((data/'statistics.json').read_text())
    exclusions=json.loads((data/'exclusions.json').read_text())
    original=np.load(run/'derived'/proof_attempt/'original-windows.npz')
    metadata=json.loads((run/'window.json').read_text());a,b,c,d,e,f=metadata['transform']
    # Independent coordinates from frozen lon/lat, not the aggregation implementation.
    import rasterio
    from rasterio.warp import transform
    sites=json.loads((run/'sampling-frozen-v2.json').read_text())['sites']
    coords={s['id']:transform('EPSG:4326','EPSG:32646',[s['lon']],[s['lat']]) for s in sites}
    connection=sqlite3.connect(':memory:');connection.execute('CREATE TABLE p(ndvi REAL, candidate INTEGER)')
    checked=0;errors={}
    for date in sorted(set(r['date'] for r in records)):
        arrays=np.load(data/f'{date}-arrays.npz')
        red=original[f'{date}_red_jp2'].astype(np.int64);nir=original[f'{date}_nir_jp2'].astype(np.int64)
        direct=np.divide(nir-red,nir+red-2000,out=np.full(red.shape,np.nan),where=(nir+red)!=2000)
        valid=arrays['base'];err=float(abs(direct[valid]-arrays['ndvi'][valid]).max());assert err<1e-12
        errors[date]=err
        rr,cc=np.indices(red.shape);xx=c+(cc+.5)*a;yy=f+(rr+.5)*e
        for record in [r for r in records if r['date']==date]:
            x,y=coords[record['site']];radius=record['radius_m']
            region=np.hypot(xx-x[0],yy-y[0])<=radius
            observed=region&arrays[record['mask']];values=direct[observed]
            assert int(region.sum())==record['total_pixels']
            assert int(observed.sum())==record['valid_pixels']
            assert record['unknown_m2']+record['valid_m2']==record['total_grid_m2']
            assert int((region&(arrays['reasons']==2)).sum())==record['clip_dn1_pixels']
            connection.execute('DELETE FROM p')
            connection.executemany('INSERT INTO p VALUES(?,?)',((float(v),int(v>=.3)) for v in values))
            n,candidates=connection.execute('SELECT COUNT(*),SUM(candidate) FROM p').fetchone()
            assert n==record['valid_pixels'] and candidates==record['candidate_pixels_ge_0.3']
            assert math.isclose(statistics.median(map(float,values)),record['ndvi_p50'],abs_tol=1e-14)
            if record['mask']=='base':
                parts=[r for r in exclusions if r['site']==record['site'] and r['date']==date and r['radius_m']==radius]
                assert sum(r['pixels'] for r in parts)==record['total_pixels']
            checked+=1
    connection.close()
    requests=[json.loads(x) for x in (run/'requests.jsonl').read_text().splitlines()]
    failures=[]
    for r in requests:
        if r.get('error'):
            assert r['bytes']==0 and not (run/'raw'/r['name']).exists()
            failures.append({'name':r['name'],'error_type':r['error_type']})
            continue
        path=run/'raw'/r['name'];assert path.stat().st_size==r['bytes'] and sha256(path)==r['sha256']
    images=list((run/'figures'/(presentation or attempt)).glob('*.png'))
    for p in images:
        with Image.open(p) as im:im.verify()
    result={'statistics_rows_checked_sqlite':checked,'max_ndvi_error_vs_original_DN':errors,
            'source_responses_hash_checked':len(requests)-len(failures),'failed_source_requests':failures,'images_decoded':len(images),
            'limits':'checks arithmetic/missingness only, not vegetation truth or user utility'}
    (run/'evidence'/output_name).open('x').write(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',required=True,type=Path)
    p.add_argument('--attempt',required=True);p.add_argument('--proof-attempt',required=True);p.add_argument('--output-name',required=True)
    p.add_argument('--presentation')
    a=p.parse_args();verify(a.run,a.attempt,a.proof_attempt,a.output_name,a.presentation)
