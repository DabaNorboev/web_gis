"""Repeat bounded metadata/reference retrieval into a prepared, separate run."""
import argparse
import datetime as dt
import json
from pathlib import Path

from period_fetch import Source


def initialise(run,previous):
    run.mkdir(exist_ok=False)
    for folder in ['raw','derived','figures','evidence']:(run/folder).mkdir()
    config=json.loads((previous/'config.json').read_text())
    config.update(run_id=run.name,started_at=dt.datetime.now(dt.timezone.utc).isoformat())
    (run/'config.json').write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
    for name in ['selected-scenes.json','sites.json','sampling-frozen-v2.json','window.json']:
        (run/name).write_bytes((previous/name).read_bytes())


def acquire(run,stage):
    source=Source(run)
    for scene in json.loads((run/'selected-scenes.json').read_text()):
        date=scene['properties']['datetime'][:10]
        if date=='2024-08-15':continue
        if stage=='metadata':
            for key in ['scl','tileinfo_metadata','granule_metadata']:
                suffix='.tif' if key=='scl' else '.json' if key=='tileinfo_metadata' else '.xml'
                row=source.get(date+'-'+key+suffix,scene['assets'][key]['href'])
                print(row['name'],row['status'],row['bytes'],flush=True)
        else:
            info=json.loads((run/'raw'/f'{date}-tileinfo_metadata.json').read_text())
            urls=[(date+'-product.xml','https://sentinel-s2-l2a.s3.amazonaws.com/'+info['productPath']+'/metadata.xml')]
            base=scene['assets']['red-jp2']['href'].replace('s3://sentinel-s2-l2a/','https://sentinel-s2-l2a.s3.amazonaws.com/').rsplit('/',1)[0]
            urls += [(date+'-original-'+band+'.jp2',base+'/R10m/'+band+'.jp2') for band in ['B04','B08']]
            for name,url in urls:
                row=source.get(name,url);print(row['name'],row['status'],row['bytes'],flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',required=True,type=Path)
    p.add_argument('--init-from',type=Path);p.add_argument('--stage',choices=['metadata','references'])
    a=p.parse_args()
    if a.init_from:initialise(a.run,a.init_from)
    if a.stage:acquire(a.run,a.stage)
