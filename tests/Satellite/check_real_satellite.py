"""Opt-in public/synthetic circles against retained A9 evidence, no ETL or database."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from satellite_city import circle_city, sha256
import rasterio as rio

p=argparse.ArgumentParser(description=__doc__);p.add_argument('--runtime',required=True);p.add_argument('--sha256',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
a.output.mkdir(parents=True,exist_ok=False)
index_path=Path('data/satellite/krasnoyarsk-2024-2026-city-v1.json');index=json.loads(index_path.read_text());references={};cases={}
for release in index['releases']:
    date=release['date'];qa=Path(f'data/satellite/reviews/{date}-city-a9-6-01') if date[:4]!='2026' else Path(f'data/satellite/reviews/{date}-city-a9-5-01')
    reviews=json.loads((qa/'full-review/review.json').read_text());boundary=json.loads((qa/'city-boundary-circles.json').read_text())
    references[date]={(tuple(c['center_utm']),c['radius_m']):c for c in [*reviews['circles'],*boundary]}
    if date=='2026-06-06':
        for c in [*reviews['circles'],*boundary]:cases[c['case']+'-'+str(c['radius_m'])]=(c['center_utm'],c['radius_m'])
    if date in ['2024-05-07','2026-06-06']:
        label='snow' if date=='2024-05-07' else 'cloud'
        win=next(w for w in reviews['visual_windows'] if w[0]==label)
        m=json.loads((index_path.parent/release['manifest']).read_text());t=m['grid']['transform'];row,col=win[1:]
        for radius in [200,1000]:cases[date+'-'+label+'-'+str(radius)]=([t[2]+(col+.5)*10,t[5]-(row+.5)*10],radius)

def measured(path):
    s=path.read_text();wall=re.search(r'Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): (\S+)',s).group(1);seconds=0
    for v in wall.split(':'):seconds=seconds*60+float(v)
    return {'wall_seconds':seconds,'max_RSS_KiB':int(re.search(r'Maximum resident set size \(kbytes\): (\d+)',s).group(1))}

checks=[];keys=['circle_pixels','source_footprint_pixels','prepared_pixels','outside_rectangle_pixels','inside_rectangle_outside_target_pixels','geographic_pixels','usable_pixels','source_pixels']
with rio.Env(GDAL_CACHEMAX=32*1024*1024):
    for name,(center,radius) in cases.items():
        result_path=a.output/(name+'.json');timing=a.output/(name+'-time.txt')
        cmd=['/usr/bin/time','-v','-o',str(timing),'php','scripts/read-satellite-circle.php','--runtime',a.runtime,'--sha256',a.sha256,'--x',str(center[0]),'--y',str(center[1]),'--radius',str(radius)]
        with result_path.open('x') as log:subprocess.run(cmd,stdout=log,check=True)
        result=json.loads(result_path.read_text());assert result['status']=='READY';assert result['metrics']['read_bytes']<=16*1024*1024
        for entry,actual in zip(index['releases'],result['releases']):
            assert entry['date']==actual['date'];date=entry['date'];reference=references[date].get((tuple(center),radius));retained=reference is not None
            if reference is None:reference=circle_city((index_path.parent/entry['manifest']).parent,*center,radius)
            c=actual['coverage'];assert c is not None
            for k in keys:assert c[k]==reference[k],(name,date,k,c[k],reference[k])
            for k,v in reference['reason_counts'].items():assert c['reason_counts'][k]==v,(name,date,k)
            for k in ['source_footprint_fraction','prepared_fraction','geographic_fraction','usable_fraction']:assert abs(c[k]-reference[k])<1e-12,(name,date,k)
            if reference['mean_ndvi'] is None:assert actual['mean_ndvi'] is None and actual['status']=='UNAVAILABLE'
            else:assert abs(actual['mean_ndvi']-reference['mean_ndvi'])<1e-12 and actual['status']=='READY'
            if date=='2024-05-07':assert actual['warnings'][0]['code']=='EARLY_SPRING_SNOW'
            checks.append({'case':name,'date':date,'retained_A9_circle':retained,'passed':True,'usable_fraction':c['usable_fraction'],'reason_counts':c['reason_counts']})
        print(name,'six dates match',flush=True)
        result['external_measurement']=measured(timing)
summary={'runtime':a.runtime,'catalog_sha256':a.sha256,'source_index_sha256':sha256(index_path),'cases':len(cases),'release_circle_checks':len(checks),
         'retained_A9_circle_checks':sum(c['retained_A9_circle'] for c in checks),'checks':checks,
         'measurements':{name:measured(a.output/(name+'-time.txt')) for name in cases},'all_passed':True,
         'comparison':'exact counts, fractions/NDVI mean tolerance 1e-12; full-circle native EPSG:32646 centres'}
(a.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
