"""Acquire only a common city window; original JP2 remain native references."""
import argparse
import json
from pathlib import Path
import sys

LIBS = Path('data/reports/source-feasibility/2026-11-03-radiometry-01/python-libs')
sys.path.insert(0, str(LIBS))
import numpy as np
import rasterio as rio
from rasterio.windows import Window
from rasterio.warp import transform
from PIL import Image, ImageDraw, ImageFont
from period_fetch import Source, RangeBridge

OLD = Path('data/reports/source-feasibility/2026-11-03-a2-01')


def layout(run):
    site_file = next(p for p in [run/'sampling-frozen-v2.json', run/'sampling-final.json', run/'sites-reviewed.json', run/'sites.json'] if p.exists())
    sites = json.loads(site_file.read_text())['sites']
    xs, ys = transform('EPSG:4326', 'EPSG:32646', [s['lon'] for s in sites], [s['lat'] for s in sites])
    with rio.open(OLD/'raw/satellite-2024-red.tif') as src:
        cols, rows = [], []
        for s, x, y in zip(sites, xs, ys):
            s.update(x=x, y=y)
            row, col = src.index(x, y)
            rows.append(row); cols.append(col)
        if (run/'window.json').exists():
            win = Window(**json.loads((run/'window.json').read_text())['window'])
        else:
            win = Window(min(cols)-112, min(rows)-112, max(cols)-min(cols)+225, max(rows)-min(rows)+225)
        affine = src.window_transform(win)
    return sites, win, affine


def write_crop(path, data, affine):
    if path.exists():
        raise ValueError('Never overwrite input evidence')
    if data.ndim == 2:
        data = data[None, :, :]
    with rio.open(path, 'w', driver='GTiff', width=data.shape[2], height=data.shape[1], count=data.shape[0],
                  dtype=data.dtype, crs='EPSG:32646', transform=affine, compress='deflate') as dst:
        dst.write(data)


def rgb_montage(run, date):
    sites, _, _ = layout(run)
    with rio.open(run/'raw'/f'{date}-visual-window.tif') as src:
        canvas = Image.new('RGB', (1120, 650), 'white'); draw = ImageDraw.Draw(canvas)
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
        for i, site in enumerate(sites):
            row, col = src.index(site['x'], site['y'])
            data = src.read(window=Window(col-105, row-105, 210, 210))
            image = Image.fromarray(np.moveaxis(data, 0, 2)).resize((270,270))
            x, y = (i%4)*280, (i//4)*315+22
            canvas.paste(image, (x,y));draw.text((x+2,y-20),site['id']+' '+site['expected'],font=font,fill='black')
            # Display extent 2100 m. The centre is explicit, surroundings unlabelled.
            for radius in [200,1000]:
                p=radius/2100*270;draw.ellipse((x+135-p,y+135-p,x+135+p,y+135+p),outline='cyan',width=1)
        draw.text((5,632),date+' — source TCI; cyan circles 200 / 1000 m; labels are sampling hypotheses',font=font,fill='black')
        canvas.save(run/'figures'/f'{date}-rgb-sites.png')


def acquire(run, stage):
    sites, win, affine = layout(run)
    meta={'window':dict(col_off=int(win.col_off),row_off=int(win.row_off),width=int(win.width),height=int(win.height)),
          'transform':list(affine)[:6], 'crs':'EPSG:32646','sites':sites}
    if not (run/'window.json').exists():
        (run/'window.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
    scenes=json.loads((run/'selected-scenes.json').read_text())
    if stage=='retained':
        for key in ['red','nir','visual','scl']:
            with rio.open(OLD/'raw'/f'satellite-2024-{key}.tif') as src:
                if key=='scl':
                    # Categorical 20 m -> 10 m nearest; direct aligned half-grid.
                    sw=Window(win.col_off//2,win.row_off//2,(win.width+win.col_off%2+1)//2,(win.height+win.row_off%2+1)//2)
                    a=np.repeat(np.repeat(src.read(1,window=sw),2,axis=0),2,axis=1)
                    a=a[int(win.row_off%2):int(win.row_off%2+win.height),int(win.col_off%2):int(win.col_off%2+win.width)]
                else: a=src.read(window=win)
                write_crop(run/'raw'/f'2024-08-15-{key}-window.tif',a,affine)
        rgb_montage(run,'2024-08-15')
        return
    if stage=='scl':
        for scene in scenes:
            date=scene['properties']['datetime'][:10]
            if date=='2024-08-15':continue
            with rio.open(run/'raw'/f'{date}-scl.tif') as src:
                sw=Window(win.col_off//2,win.row_off//2,(win.width+win.col_off%2+1)//2,(win.height+win.row_off%2+1)//2)
                a=np.repeat(np.repeat(src.read(1,window=sw),2,axis=0),2,axis=1)
                a=a[int(win.row_off%2):int(win.row_off%2+win.height),int(win.col_off%2):int(win.col_off%2+win.width)]
            write_crop(run/'raw'/f'{date}-scl-window.tif',a,affine)
            with rio.open(run/'raw'/f'{date}-scl-window.tif') as src:
                for site in sites:
                    row,col=src.index(site['x'],site['y']);part=a[row-100:row+101,col-100:col+101]
                    print(date,site['id'],'SCL4/5/6',round(float(np.isin(part,[4,5,6]).mean()),3))
        return
    source=Source(run)
    assets={f"{s['properties']['datetime'][:10]}-{key}.tif":s['assets'][key]['href']
            for s in scenes if s['properties']['datetime'][:10]!='2024-08-15' for key in ['red','nir','visual']}
    with RangeBridge(source,assets) as bridge:
        with rio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
                     CPL_VSIL_CURL_CHUNK_SIZE=1048576, GDAL_HTTP_MULTIRANGE='SERIAL',
                     GDAL_HTTP_MERGE_CONSECUTIVE_RANGES='YES', GDAL_HTTP_MAX_RETRY=0):
            for name,url in assets.items():
                date=name[:10];key=name[11:-4]
                with rio.open(f'/vsicurl/{bridge}/{name}') as src:
                    assert src.crs.to_epsg()==32646 and src.shape==(10980,10980)
                    assert src.transform==rio.Affine(10,0,399960,0,-10,6300000)
                    a=src.read(window=win)
                    info={'asset_href':url,'shape':src.shape,'transform':list(src.transform)[:6],
                          'scales':src.scales,'offsets':src.offsets,'dtype':src.dtypes}
                write_crop(run/'raw'/f'{date}-{key}-window.tif',a,affine)
                (run/'evidence'/f'{date}-{key}-reader.json').write_text(json.dumps(info,indent=2)+'\n')
                print(date,key,a.shape,flush=True)
        for date in ['2024-07-26','2024-06-28']:rgb_montage(run,date)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',type=Path,required=True)
    p.add_argument('--stage',choices=['retained','scl','windows'],required=True);a=p.parse_args();acquire(a.run,a.stage)
