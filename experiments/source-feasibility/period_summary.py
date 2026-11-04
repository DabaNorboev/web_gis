"""Export the concise place/date table from saved one-period results."""
import argparse
import csv
import json
from pathlib import Path


def summarise(run,attempt,output_name):
    output=run/'derived'/output_name;output.mkdir(exist_ok=False)
    rows=[r for r in json.loads((run/'derived'/attempt/'statistics.json').read_text()) if r['mask']=='base']
    reasons=json.loads((run/'derived'/attempt/'exclusions.json').read_text())
    compact=[]
    for r in rows:
        row={k:r[k] for k in ['site','split','date','radius_m','total_grid_m2','circle_geometric_m2','valid_m2','valid_fraction','unknown_m2','clip_dn1_pixels','clip_dn1_fraction','clip_dn1_marginal_pixels','ndvi_p10','ndvi_p50','ndvi_p90']}
        row.update(candidate_m2=r['candidate_m2_ge_0.3'],candidate_fraction_of_valid=r['candidate_fraction_of_valid_ge_0.3'])
        for e in reasons:
            if (e['site'],e['date'],e['radius_m'])==(r['site'],r['date'],r['radius_m']) and e['reason'] not in ['valid','COG_DN1']:
                row[e['reason']+'_excluded_pixels']=e['pixels']
        compact.append(row)
    with (output/'circles.csv').open('x',newline='') as target:
        w=csv.DictWriter(target,fieldnames=list(compact[0]));w.writeheader();w.writerows(compact)
    (output/'circles.json').write_text(json.dumps(compact,indent=2)+'\n')
    table=['| Участок | Дата 2024 | 200 м: пригодно га / % | NDVI p50 | Кандидат % | 1000 м: пригодно га / % | NDVI p50 | Кандидат % | DN=1: 200 / 1000 м |',
           '|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for site in sorted(set(r['site'] for r in rows)):
        for date in sorted(set(r['date'] for r in rows)):
            small=next(r for r in rows if r['site']==site and r['date']==date and r['radius_m']==200)
            large=next(r for r in rows if r['site']==site and r['date']==date and r['radius_m']==1000)
            cells=[site,date[5:]]
            for r in [small,large]:cells += [f"{r['valid_m2']/10000:.2f} / {r['valid_fraction']*100:.2f}",f"{r['ndvi_p50']:.3f}",f"{r['candidate_fraction_of_valid_ge_0.3']*100:.1f}"]
            cells += [f"{small['clip_dn1_pixels']} / {large['clip_dn1_pixels']}"]
            table.append('| '+' | '.join(cells)+' |')
    (output/'compact-table.md').write_text('\n'.join(table)+'\n')
    print('Exported',len(compact),'circle rows and 24 compact rows')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',required=True,type=Path)
    p.add_argument('--attempt',required=True);p.add_argument('--output-name',required=True)
    a=p.parse_args();summarise(a.run,a.attempt,a.output_name)
