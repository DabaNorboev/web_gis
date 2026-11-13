#!/usr/bin/env python3
"""A9.4 bounded candidate evidence only; never prepares/activates a release."""
import argparse
import hashlib
from itertools import combinations
import json
import math
from pathlib import Path
import sys
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

import numpy as np
import rasterio as rio
from rasterio.features import rasterize
from rasterio.windows import from_bounds, Window
from rasterio.warp import reproject, Resampling, transform_geom
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
import shapely

# Reuse the existing budgeted, byte-preserving research transport.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'experiments/source-feasibility'))
from period_fetch import Source, RangeBridge

CRS = 'EPSG:32646'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def save(path, value):
    with path.open('x') as f:
        json.dump(value, f, ensure_ascii=False, indent=2, allow_nan=False)
        f.write('\n')


def projected(geometry):
    return shape(transform_geom('EPSG:4326', CRS, geometry))


def target(run):
    return json.loads((run/'target.geojson').read_text())


def init(run):
    cfg = json.loads((run/'config.json').read_text())
    source = Path(cfg['boundary'])
    assert digest(source) == cfg['boundary_sha256']
    boundary = json.loads(source.read_text())
    geometry = projected(boundary['geometry'])
    assert geometry.is_valid and not geometry.is_empty
    # GEOS round buffer in documented metre CRS; no runtime DB or working writes.
    buffered = geometry.buffer(cfg['buffer_m'], quad_segs=64)
    assert buffered.is_valid and buffered.covers(geometry)
    geo = transform_geom(CRS, 'EPSG:4326', mapping(buffered))
    feature = {'type': 'Feature', 'properties': {'source': str(source), 'sha256': digest(source),
               'source_properties': boundary['properties'], 'buffer_m': cfg['buffer_m'], 'buffer_crs': CRS,
               'quad_segs': 64, 'max_arc_chord_error_m': cfg['buffer_m']*(1-math.cos(math.pi/256)),
               'shapely': shapely.__version__, 'geos': shapely.geos_version_string}, 'geometry': geo}
    save(run/'target.geojson', feature)
    bounds = buffered.bounds
    width10 = math.ceil(bounds[2]/10)-math.floor(bounds[0]/10)
    height10 = math.ceil(bounds[3]/10)-math.floor(bounds[1]/10)
    save(run/'target-metrics.json', {'boundary_area_m2': geometry.area, 'target_area_m2': buffered.area,
         'bounds_projected': bounds, 'bbox_wgs84': shape(geo).bounds,
         'bounding_width_10m': width10, 'bounding_height_10m': height10,
         'bounding_pixels_10m': width10*height10, 'target_sha256': digest(run/'target.geojson')})
    print((run/'target-metrics.json').read_text())


def search(run):
    t = target(run)
    bbox = shape(t['geometry']).bounds
    transport = Source(run)
    year=json.loads((run/'config.json').read_text()).get('year',2026)
    if year not in (2024,2025,2026):raise ValueError('Only 2024–2026 selection years supported')
    for season, interval in [('early', f'{year}-05-01T00:00:00Z/{year}-06-30T23:59:59Z'),
                             ('late', f'{year}-08-01T00:00:00Z/{year}-09-30T23:59:59Z')]:
        query = {'collections': 'sentinel-2-l2a', 'bbox': ','.join(map(str,bbox)), 'datetime': interval,
                 'limit': 100, 'sortby': '+properties.datetime'}
        url = 'https://earth-search.aws.element84.com/v1/search?' + urlencode(query)
        items = []
        for page in range(12):
            name = f'{season}-search-{page:02d}.json'
            row = transport.get(name, url)
            if row['status'] != 200:
                raise RuntimeError(f'Catalog returned {row["status"]}')
            response = json.loads((run/'raw'/name).read_text())
            items.extend(response['features'])
            links = [l for l in response['links'] if l['rel'] == 'next']
            if not links:
                break
            assert len(links) == 1 and links[0].get('method', 'GET') == 'GET'
            url = links[0]['href']
        else:
            raise RuntimeError('Catalog pagination exceeded explicit limit')
        save(run/f'{season}-items.json', items)
        print(season, len(items), flush=True)


def rank(run, selection='selection-v2'):
    output = run/selection
    output.mkdir(exist_ok=False)
    area = projected(target(run)['geometry'])
    all_groups, chosen = [], []
    for season in ['early','late']:
        groups = {}
        for item in json.loads((run/f'{season}-items.json').read_text()):
            p = item['properties']
            if not projected(item['geometry']).intersects(area):
                continue
            # Same datatake/platform: same observed pass, no mixing dates or orbits.
            key = (p['datetime'][:10], p['platform'], p['s2:datatake_id'])
            groups.setdefault(key, []).append(item)
        rows = []
        for (date, satellite, datatake), items in groups.items():
            all_items = sorted(items, key=lambda i:i['id'])
            # Minimise redundant tiles by geometry only, never by a favourable SCL class.
            for count in range(1,len(all_items)+1):
                subsets = [list(c) for c in combinations(all_items,count)
                           if unary_union([projected(i['geometry']) for i in c]).covers(area)]
                if subsets:
                    items = subsets[0]
                    break
            footprints = [projected(i['geometry']) for i in items]
            union = unary_union(footprints)
            missing = area.difference(union).area
            weights = [area.intersection(g).area for g in footprints]
            score = sum(w*i['properties']['eo:cloud_cover'] for w,i in zip(weights, items))/sum(weights)
            row = {'season': season, 'date': date, 'platform': satellite, 'datatake': datatake,
                   'full_footprint_coverage': union.covers(area), 'uncovered_m2': missing,
                   'catalog_cloud_weighted_percent': score, 'items': items,
                   'all_intersecting_scene_ids': [i['id'] for i in all_items]}
            rows.append(row)
        rows.sort(key=lambda r: (not r['full_footprint_coverage'], r['catalog_cloud_weighted_percent'], r['date']))
        all_groups.extend(rows)
        selected = [r for r in rows if r['full_footprint_coverage']][:3]
        chosen.extend(selected)
        print(season, 'groups', len(rows), 'shortlist', [(r['date'],r['catalog_cloud_weighted_percent'],[i['id'] for i in r['items']]) for r in selected])
    save(output/'catalog-groups.json', all_groups)
    save(output/'shortlist.json', chosen)


def assess(run, selection='selection-v2'):
    output = run/selection
    started = time.perf_counter()
    area = projected(target(run)['geometry'])
    xmin,ymin,xmax,ymax = area.bounds
    left, top = math.floor(xmin/20)*20, math.ceil(ymax/20)*20
    width, height = math.ceil((xmax-left)/20), math.ceil((top-ymin)/20)
    affine = rio.Affine(20,0,left,0,-20,top)
    mask = rasterize([(mapping(area),1)],out_shape=(height,width),transform=affine).astype(bool)
    total = int(mask.sum())
    transport = Source(run)
    results = []
    for group in json.loads((output/'shortlist.json').read_text()):
        date = group['date']
        # Geometric deterministic priority, independent of SCL class or NDVI values.
        mosaic = np.zeros(mask.shape, dtype='uint8')
        assignment = np.zeros(mask.shape, dtype='uint8')
        tile_rows = []
        for index,item in enumerate(sorted(group['items'],key=lambda i:i['id']),1):
            name = f'{item["id"]}-scl.tif'
            url = item['assets']['scl']['href']
            local = run/'raw'/name
            if not local.exists():
                row = transport.get(name,url)
                if row['status'] != 200:
                    raise RuntimeError(f'SCL returned {row["status"]}')
            with rio.open(local) as src:
                assert src.crs.to_epsg() == 32646 and src.res == (20,20) and src.count == 1 and src.dtypes == ('uint8',)
                warped = np.zeros(mask.shape,dtype='uint8')
                reproject(src.read(1),warped,src_transform=src.transform,src_crs=src.crs,
                          dst_transform=affine,dst_crs=CRS,resampling=Resampling.nearest,src_nodata=0,dst_nodata=0)
                footprint = rasterize([(mapping(projected(item['geometry'])),1)],out_shape=mask.shape,transform=affine).astype(bool)
                # Assign by sorted tile footprint, never choose the clearest overlapping class.
                take = footprint & (assignment==0)
                mosaic[take] = warped[take]
                assignment[take] = index
                tile_rows.append({'scene_id':item['id'],'product_uri':item['properties']['s2:product_uri'],
                                  'acquired_at_catalog':item['properties']['datetime'],
                                  'datatake':item['properties']['s2:datatake_id'],'baseline':item['properties']['s2:processing_baseline'],
                                  'scl_path':str(local),'sha256':digest(local),'bytes':local.stat().st_size,
                                  'source':url,'grid':{'crs':str(src.crs),'transform':list(src.transform)[:6],'shape':src.shape}})
        counts = {str(k):int((mask&(mosaic==k)).sum()) for k in range(12)}
        other = int((mask&~np.isin(mosaic,range(12))).sum())
        assert sum(counts.values())+other == total
        reasons = {'usable_SCL456':int((mask&np.isin(mosaic,[4,5,6])).sum()),
                   'cloud_shadow_SCL3':counts['3'], 'cloud_cirrus_SCL8_9_10':sum(counts[str(k)] for k in [8,9,10]),
                   'snow_SCL11':counts['11'],'nodata_SCL0':counts['0'], 'SCL2_dark_shadow':counts['2'],
                   'unclassified_SCL7':counts['7'],'defective_SCL1':counts['1'],'unsupported':other}
        assert sum(reasons.values()) == total
        spatial = []
        for rr in range(0,height,250):
            for cc in range(0,width,250):
                part = mask[rr:rr+250,cc:cc+250]; n=int(part.sum())
                if n:
                    values=mosaic[rr:rr+250,cc:cc+250]
                    spatial.append({'row':rr,'col':cc,'target_pixels':n,'usable_pixels':int((part&np.isin(values,[4,5,6])).sum()),
                                    'cloud_shadow_pixels':int((part&np.isin(values,[3,8,9,10])).sum()),
                                    'nodata_pixels':int((part&(values==0)).sum())})
        path=output/f'{date}-SCL-target.tif'
        with rio.open(path,'w',driver='GTiff',width=width,height=height,count=3,dtype='uint8',crs=CRS,transform=affine,compress='deflate') as dst:
            dst.write(mosaic,1);dst.write(mask.astype('uint8'),2);dst.write(assignment,3)
            dst.set_band_description(1,'SCL, deterministic tile footprint priority')
            dst.set_band_description(2,'AOI pixel-center mask')
            dst.set_band_description(3,'source tile assignment; not quality optimized')
        result = {k:v for k,v in group.items() if k!='items'}
        result.update(total_target_pixels_20m=total,scl_counts=counts,reasons=reasons,
                      fractions={k:n/total for k,n in reasons.items()},tiles=tile_rows,
                      uncovered_target_pixels=int((mask&(assignment==0)).sum()),
                      spatial_blocks_5km=spatial,grid={'transform':list(affine)[:6],'width':width,'height':height,'crs':CRS},
                      mask_path=str(path),mask_sha256=digest(path),
                      limitation='SCL suitability only, not valid NDVI: B04/B08/DN1 not inspected over entire AOI')
        results.append(result)
        print(date,result['fractions'],flush=True)
    save(output/'scl-assessment.json',{'results':results,'seconds_including_SCL_download':time.perf_counter()-started,
                                 'denominator':'all target polygon native 20m pixel centers; not bbox or selected control windows',
                                 'tile_overlap_rule':'first sorted scene footprint, no class-based selection'})


def recommended(run, selection):
    rows=json.loads((run/selection/'scl-assessment.json').read_text())['results']
    return [max((r for r in rows if r['season']==season),key=lambda r:r['fractions']['usable_SCL456'])
            for season in ['early','late']]


def text_xml(path, tag):
    return next(e.text for e in ET.parse(path).iter() if e.tag.split('}')[-1]==tag)


def native_tile_url(item, info=None):
    if 'product_metadata' in item['assets']:
        return item['assets']['product_metadata']['href'].replace('s3://sentinel-s2-l2a/','https://sentinel-s2-l2a.s3.amazonaws.com/').rsplit('/',1)[0]
    p=item['properties'];assert info['productName']==p['s2:product_uri'].removesuffix('.SAFE')
    native=info['path'];assert '..' not in native
    parts=native.split('/');tile=p['grid:code'].removeprefix('MGRS-');year,month,day=map(int,p['datetime'][:10].split('-'))
    assert parts[:4]==['tiles',tile[:2],tile[2],tile[3:]]
    assert len(parts)==8 and list(map(int,parts[4:7]))==[year,month,day] and parts[7].isdigit()
    return 'https://sentinel-s2-l2a.s3.amazonaws.com/'+native


def probe(run, selection='selection-v2'):
    chosen=recommended(run,selection)
    groups=json.loads((run/selection/'shortlist.json').read_text())
    transport=Source(run);records=[]
    def fetch(name,url,method='GET'):
        path=run/'raw'/name
        if path.exists():
            logs=[json.loads(l) for l in (run/'requests.jsonl').read_text().splitlines()]
            row=next(r for r in reversed(logs) if r['name']==name and not r.get('error'))
            assert row['url']==url and row['method']==method and path.stat().st_size==row['bytes'] and digest(path)==row['sha256']
            return row
        return transport.get(name,url,method=method)
    for result in chosen:
        group=next(g for g in groups if g['date']==result['date'])
        for item in group['items']:
            p=item['properties'];sid=item['id'];product=p['s2:product_uri']
            date=p['datetime'][:10];year,month,day=map(int,date.split('-'))
            urls={'granule':item['assets']['granule_metadata']['href'],
                  'product':f'https://sentinel-s2-l2a.s3.amazonaws.com/products/{year}/{month}/{day}/{product.removesuffix(".SAFE")}/metadata.xml'}
            for key,url in urls.items():
                name=f'{sid}-{key}.xml';row=fetch(name,url)
                if row['status']!=200:
                    raise RuntimeError(f'{sid} {key} HTTP {row["status"]}')
            product_xml=run/'raw'/f'{sid}-product.xml';granule_xml=run/'raw'/f'{sid}-granule.xml'
            assert text_xml(product_xml,'PRODUCT_URI')==product
            assert text_xml(product_xml,'PROCESSING_BASELINE')==p['s2:processing_baseline']
            assert text_xml(product_xml,'SPACECRAFT_NAME').replace('Sentinel-','S')==sid[:3]
            sensing=text_xml(granule_xml,'SENSING_TIME')
            from datetime import datetime
            delta=abs((datetime.fromisoformat(sensing.replace('Z','+00:00'))-
                       datetime.fromisoformat(p['datetime'].replace('Z','+00:00'))).total_seconds())
            assert delta<.001
            assert f'_T{p["grid:code"].removeprefix("MGRS-")}_' in text_xml(granule_xml,'TILE_ID')
            q=int(text_xml(product_xml,'BOA_QUANTIFICATION_VALUE'))
            offsets={e.attrib['band_id']:int(e.text) for e in ET.parse(product_xml).iter() if e.tag.split('}')[-1]=='BOA_ADD_OFFSET'}
            assets={}
            for key in ['red','nir','visual','scl']:
                row=fetch(f'{sid}-{key}-head.bin',item['assets'][key]['href'],method='HEAD')
                assert row['status']==200 and int(row['headers'].get('Content-Length',0))>0
                assets[key]={'source':item['assets'][key]['href'],'status':row['status'],
                             'content_length':int(row['headers']['Content-Length']),
                             'catalog_raster_bands':item['assets'][key].get('raster:bands')}
            # Availability of exact native reference products, not their full download or validation.
            info=None
            if 'product_metadata' not in item['assets']:
                # Older Earth Search items expose tileInfo instead of a native metadata link.
                name=f'{sid}-tileinfo.json';row=fetch(name,item['assets']['tileinfo_metadata']['href'])
                assert row['status']==200
                info=json.loads((run/'raw'/name).read_text())
            tile_url=native_tile_url(item,info)
            references={}
            for band in ['B04','B08']:
                url=f'{tile_url}/R10m/{band}.jp2'
                row=fetch(f'{sid}-{band}-jp2-head.bin',url,method='HEAD')
                references[band]={'source':url,'status':row['status'],'bytes':int(row['headers'].get('Content-Length',0))}
            records.append({'scene_id':sid,'date':date,'product_uri':product,'tile':p['grid:code'],
                            'platform':p['platform'],'datatake':p['s2:datatake_id'], 'relative_orbit':p.get('sat:relative_orbit'),
                            'acquired_at_catalog':p['datetime'],'acquired_at_granule':sensing,'baseline':p['s2:processing_baseline'],
                            'quantification':q,'XML_offsets_B04_B08':[offsets['3'],offsets['7']],
                            'product_XML_sha256':digest(product_xml),'granule_XML_sha256':digest(granule_xml),
                            'assets':assets,'native_JP2_availability':references,
                            'radiometry_status':'XML checked; COG encoding still requires same-product JP2 pixel comparison in A9.5'})
    save(run/selection/'metadata-checks.json',records)
    print([(r['scene_id'],r['acquired_at_granule'],r['baseline']) for r in records],flush=True)


def previews(run, selection='selection-v2'):
    groups=json.loads((run/selection/'shortlist.json').read_text())
    dates=[r['date'] for r in recommended(run,selection)]
    assets={i['id']+'.tif':i['assets']['visual']['href'] for g in groups if g['date'] in dates for i in g['items']}
    source=Source(run);area=projected(target(run)['geometry']);xmin,ymin,xmax,ymax=area.bounds
    left,top=math.floor(xmin/100)*100,math.ceil(ymax/100)*100
    width,height=math.ceil((xmax-left)/100),math.ceil((top-ymin)/100)
    affine=rio.Affine(100,0,left,0,-100,top)
    records=[]
    with RangeBridge(source,assets) as bridge:
        with rio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
                     CPL_VSIL_CURL_CHUNK_SIZE=65536,GDAL_HTTP_MULTIRANGE='SERIAL',
                     GDAL_HTTP_MERGE_CONSECUTIVE_RANGES='YES',GDAL_HTTP_MAX_RETRY=0):
            for group in groups:
                if group['date'] not in dates:continue
                mosaic=np.zeros((3,height,width),dtype='uint8');assignment=np.zeros((height,width),dtype=bool)
                for item in sorted(group['items'],key=lambda i:i['id']):
                    with rio.open(f'/vsicurl/{bridge}/{item["id"]}.tif') as src:
                        assert src.crs.to_epsg()==32646 and src.res==(10,10) and src.count==3
                        b=src.bounds
                        win=from_bounds(max(xmin,b.left),max(ymin,b.bottom),min(xmax,b.right),min(ymax,b.top),src.transform).round_offsets().round_lengths()
                        out_h,out_w=math.ceil(win.height/10),math.ceil(win.width/10)
                        data=src.read(window=win,out_shape=(3,out_h,out_w),resampling=Resampling.nearest)
                        at=src.window_transform(win)*rio.Affine.scale(win.width/out_w,win.height/out_h)
                        warped=np.zeros(mosaic.shape,dtype='uint8')
                        reproject(data,warped,src_transform=at,src_crs=src.crs,dst_transform=affine,dst_crs=CRS,resampling=Resampling.nearest)
                        footprint=rasterize([(mapping(projected(item['geometry'])),1)],out_shape=(height,width),transform=affine).astype(bool)
                        take=footprint&~assignment;mosaic[:,take]=warped[:,take];assignment[take]=True
                        records.append({'scene_id':item['id'],'asset':item['assets']['visual']['href'],
                                        'source_window':dict(win.todict()),'out_shape':[3,out_h,out_w],
                                        'resampling':'nearest source overview/window, then nearest to shared 100m display grid',
                                        'source_scales':src.scales,'source_offsets':src.offsets})
                path=run/selection/f'{group["date"]}-TCI-overview-100m.tif'
                with rio.open(path,'w',driver='GTiff',count=3,width=width,height=height,dtype='uint8',crs=CRS,transform=affine,compress='deflate') as dst:
                    dst.write(mosaic)
                print('TCI preview',group['date'],flush=True)
    save(run/selection/'preview-reads.json',records)


def present(run, selection='selection-v2'):
    from PIL import Image,ImageDraw,ImageFont
    from rasterio.warp import transform
    results=json.loads((run/selection/'scl-assessment.json').read_text())['results']
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',16)
    small=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',13)
    colors=np.array([[230,30,30],[100,0,0],[55,65,95],[125,70,170],[175,215,160],[175,215,160],
                     [175,215,160],[150,150,150],[245,185,35],[245,185,35],[245,185,35],[90,200,235]],dtype='uint8')
    rows=math.ceil(len(results)/2)
    canvas=Image.new('RGB',(1500,rows*330+180),'white');draw=ImageDraw.Draw(canvas)
    draw.text((10,8),'A9.4 | Krasnoyarsk OSM boundary + 1000 m | complete AOI SCL 20m; not NDVI validity',font=font,fill='black')
    results = sorted(results,key=lambda r:(r['season'],r['date']))
    city = projected(json.loads(Path(json.loads((run/'config.json').read_text())['boundary']).read_text())['geometry'])
    for idx,r in enumerate(results):
        with rio.open(r['mask_path']) as src:
            scl=src.read(1);mask=src.read(2)>0
            affine, bounds = src.transform, src.bounds
        rgb=colors[scl];rgb[~mask]=[255,255,255]
        x=(idx%2)*750;y=50+(idx//2)*330
        picture=Image.fromarray(rgb).resize((730,298),Image.NEAREST)
        pd=ImageDraw.Draw(picture)
        for polygon in city.geoms if city.geom_type=='MultiPolygon' else [city]:
            points=[((xx-bounds.left)/(bounds.right-bounds.left)*730,(bounds.top-yy)/(bounds.top-bounds.bottom)*298)
                    for xx,yy in polygon.exterior.coords]
            pd.line(points,fill=(55,55,55),width=1)
        pd.line([(25,275),(225,275)],fill=(0,0,0),width=2)
        pd.text((25,255),'20 km approx.',font=small,fill=(0,0,0))
        canvas.paste(picture,(x+5,y+25))
        f=r['fractions']
        label=f'{r["date"]} | SCL456 {f["usable_SCL456"]*100:.3f}% | cloud {f["cloud_cirrus_SCL8_9_10"]*100:.3f}% | snow {f["snow_SCL11"]*100:.3f}%'
        draw.text((x+5,y),label,font=small,fill='black')
    legend=[('SCL 4/5/6 suitable',colors[4]),('Cloud/cirrus',colors[8]),('Cloud shadow',colors[3]),
            ('Snow',colors[11]),('SCL2 dark/shadow',colors[2]),('Unclassified',colors[7]),('Nodata',colors[0])]
    for i,(label,color) in enumerate(legend):
        x=15+(i%4)*365;y=rows*330+65+(i//4)*35
        draw.rectangle((x,y,x+20,y+20),fill=tuple(color));draw.text((x+27,y),label,font=small,fill='black')
    draw.text((10,rows*330+140),'White = outside AOI. Tiny exclusions may vanish in this overview; exact counts and 5 km blocks are in JSON.',font=small,fill='black')
    canvas.save(run/selection/'SCL-candidates-overview.png')
    dates=[r['date'] for r in recommended(run,selection)]
    canvas=Image.new('RGB',(1500,1330),'white');draw=ImageDraw.Draw(canvas)
    for idx,date in enumerate(dates):
        path=run/selection/f'{date}-TCI-overview-100m.tif'
        with rio.open(path) as src:
            rgb=np.moveaxis(src.read(),0,-1);mask=rasterize([(mapping(projected(target(run)['geometry'])),1)],out_shape=src.shape,transform=src.transform).astype(bool)
        rgb[~mask]=[245,245,245]
        canvas.paste(Image.fromarray(rgb).resize((1458,594),Image.NEAREST),(15,idx*660+40))
        draw.text((15,idx*660+10),date+' | TCI overview 100 m, native SCL assessment is 20 m; Contains modified Copernicus Sentinel data',font=small,fill='black')
    canvas.save(run/selection/'recommended-TCI-overviews.png')


def verify_http_records(run,records):
    # Verify retained raw bytes, including HTTP range responses and empty HEAD bodies.
    for r in records:
        if r.get('error'):
            # A failed handshake retained no body. Keep its log; a later explicit retry may succeed.
            # Partial downloads still block finalization and must not be overwritten.
            assert r['bytes']==0 and r['sha256']==hashlib.sha256(b'').hexdigest()
            continue
        path=run/'raw'/r['name']
        assert path.stat().st_size==r['bytes'] and digest(path)==r['sha256']
        assert r['status'] in [200,206]


def finish(run, selection='selection-v2'):
    from datetime import datetime,timezone
    directory=run/selection
    records=[json.loads(l) for l in (run/'requests.jsonl').read_text().splitlines()]
    verify_http_records(run,records)
    checks=json.loads((directory/'metadata-checks.json').read_text())
    for r in checks:
        product=run/'raw'/f'{r["scene_id"]}-product.xml'
        datatake=next(e.attrib['datatakeIdentifier'] for e in ET.parse(product).iter() if e.tag.split('}')[-1]=='Datatake')
        assert datatake==r['datatake'] and text_xml(product,'SENSING_ORBIT_NUMBER')=='19'
    chosen=recommended(run,selection)
    proposals=[];spatial=[]
    city=projected(json.loads(Path(json.loads((run/'config.json').read_text())['boundary']).read_text())['geometry'])
    for r in chosen:
        tiles=[c for c in checks if c['date']==r['date']]
        assert len(tiles)==2 and len({c['datatake'] for c in tiles})==1 and len({c['platform'] for c in tiles})==1
        proposals.append({'date':r['date'],'season':r['season'],'tiles':tiles,'SCL_fractions':r['fractions'],
                          'SCL_counts':r['reasons'],'full_geographic_coverage':r['full_footprint_coverage'],
                          'uncovered_m2':r['uncovered_m2'],'uncovered_target_pixels':r['uncovered_target_pixels'],
                          'status':'proposed_candidate_only','radiometry_validated':False})
        with rio.open(r['mask_path']) as src:
            a=src.read(1);aoi=src.read(2)>0
            inside=rasterize([(mapping(city),1)],out_shape=src.shape,transform=src.transform).astype(bool)
            summary={'date':r['date'],'city_vs_outer_buffer':{},'exclusion_bounds_UTM':{},'blocks_5km':[]}
            for name,mask in [('city',inside),('outer_1000m',aoi&~inside)]:
                summary['city_vs_outer_buffer'][name]={'pixels':int(mask.sum()),
                    'SCL456_fraction':float(np.isin(a[mask],[4,5,6]).mean()),
                    'counts_by_SCL':{str(k):int((mask&(a==k)).sum()) for k in range(12)}}
            for name,classes in [('cloud_cirrus',[8,9,10]),('shadow',[3]),('snow',[11]),('nodata',[0])]:
                rows,cols=np.where(aoi&np.isin(a,classes))
                summary['exclusion_bounds_UTM'][name]=[src.transform.c+int(cols.min())*20,
                   src.transform.f-(int(rows.max())+1)*20,src.transform.c+(int(cols.max())+1)*20,
                   src.transform.f-int(rows.min())*20] if len(rows) else None
            for block in r['spatial_blocks_5km']:
                rr,cc=block['row'],block['col'];mask=aoi[rr:rr+250,cc:cc+250];values=a[rr:rr+250,cc:cc+250]
                summary['blocks_5km'].append({**block,'counts_by_SCL':{str(k):int((mask&(values==k)).sum()) for k in range(12)},
                                             'bounds_UTM':[src.transform.c+cc*20,src.transform.f-(rr+250)*20,
                                                           src.transform.c+(cc+250)*20,src.transform.f-rr*20]})
            spatial.append(summary)
    save(directory/'exclusion-spatial-details.json',spatial)
    full_cog=sum(a['content_length'] for r in checks for a in r['assets'].values())
    full_reference=sum(a['bytes'] for r in checks for a in r['native_JP2_availability'].values())
    target_meta=json.loads((run/'target-metrics.json').read_text())
    estimates={'full_COG_files_bytes_from_HEAD':full_cog,'full_reference_JP2_bytes_from_HEAD':full_reference,
               'total_full_download_upper_strategy_bytes':full_cog+full_reference,
               'range_download_estimate_bytes':[300000000,1000000000],
               'range_estimate_warning':'Only estimate for city COG windows; exact bytes depend on blocks/overviews. Native JP2 references additional.',
               'dense_15bytes_per_pixel_two_date_outputs_uncompressed':target_meta['bounding_pixels_10m']*15*2,
               'disk_reserve_GiB_estimate':[7,9], 'current_monolithic_pipeline_peak_GiB_estimate':[2,3],
               'proposed_block_processing_peak_GiB_budget_to_measure':[.5,1],
               'full_download_minutes_at_0_5_to_10_decimal_MBps':[6.5,129],
               'offline_processing_minutes_estimate_not_benchmark':[5,20],
               'pipeline_changes_required':['multi-tile same-pass identity/provenance and manifest compatibility',
                  'window/block IO and bounded memory instead of raising 4M guard without measurement',
                  'shared 10m grid and deterministic overlap assignment independent of SCL/NDVI',
                  'new native JP2/COG radiometry proof for all four products over retained city pixels',
                  'explicit AOI, prepared rectangle, source footprint and per-date valid masks',
                  'bounded coverage vectorization and revised city-index compatibility tests']}
    save(directory/'resource-estimates.json',estimates)
    artifacts={str(p.relative_to(run)):{'bytes':p.stat().st_size,'sha256':digest(p)}
               for p in sorted(run.rglob('*')) if p.is_file() and 'python-libs' not in p.parts}
    visual=json.loads((directory/'visual-review.json').read_text())
    assert visual['status']=='viewed' and all((directory/p).exists() for p in visual['images'])
    result={'status':'A9.4_candidates_proposed_not_releases','created_at':datetime.now(timezone.utc).isoformat(),
            'target':{'path':'target.geojson','sha256':digest(run/'target.geojson'),**target_meta},
            'proposals':proposals,'comparison':f'best SCL456 fractions among {len(json.loads((directory/"scl-assessment.json").read_text())["results"])} assessed complete same-pass candidates; candidate list and selection limits retained',
            'scope':'SCL classification of entire AOI at 20m; B04/B08/DN1 validity over city remains unverified',
            'selection':'No arbitrary suitability threshold; full footprint coverage is required; no mixing of dates',
            'visual_review':visual,'resources':estimates,
            'actual':{'source_requests':len(records),'failed_zero_body_requests':sum(bool(r.get('error')) for r in records),'body_bytes':sum(r['bytes'] for r in records),
                      'HTTP_request_seconds_sum_not_whole_task_time':sum(r['elapsed_seconds'] for r in records),
                      'SCL_assessment_seconds_including_download':json.loads((directory/'scl-assessment.json').read_text())['seconds_including_SCL_download'],
                      'storage_bytes_before_manifest':sum(p.stat().st_size for p in run.rglob('*') if p.is_file()),
                      'network_time_includes_download':True,'archive_extraction_performed':False,'peak_RSS_measured':False},
            'software':{'python':sys.version,'rasterio':rio.__version__,'gdal':rio.__gdal_version__,
                        'numpy':np.__version__,'shapely':shapely.__version__,'geos':shapely.geos_version_string,
                        'script_sha256':digest(Path(__file__)),'transport_sha256':digest(Path(__file__).resolve().parents[1]/'experiments/source-feasibility/period_fetch.py')},
            'artifacts':artifacts,
            'reproduce_offline':'PYTHONPATH=<isolated-shapely>:<existing-rasterio> python3 -B scripts/select-satellite-city.py --run <this-run> --stage rank --selection replay-01; then --stage assess --selection replay-01 uses retained raw SCL without network',
            'limits':['OSM urban okrug snapshot, not a legal cadastral boundary','Buffer is EPSG:32646 metres, round approximation error <=0.076m',
                      'SCL and TCI are from same Sentinel source; no independent cloud/land-cover validation',
                      'TCI overview 100m cannot establish accuracy of single 20m exclusions','No NDVI, city release, API/UI or activation prepared']}
    save(directory/'selection-manifest.json',result)
    print(json.dumps({'manifest':str(directory/'selection-manifest.json'),'dates':[r['date'] for r in proposals],'actual':result['actual'],'estimates':estimates},ensure_ascii=False))


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run',type=Path,required=True)
    p.add_argument('--stage',choices=['init','search','rank','assess','probe','previews','present','finish'],required=True)
    p.add_argument('--selection',default='selection-v2')
    args=p.parse_args()
    if args.stage in ['rank','assess','probe','previews','present','finish']:
        globals()[args.stage](args.run,args.selection)
    else:
        globals()[args.stage](args.run)
