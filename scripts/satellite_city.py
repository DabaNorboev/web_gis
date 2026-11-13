"""Bounded multi-tile Sentinel city release. Legacy single-tile format stays unchanged."""
from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import resource
import sys
import time
import xml.etree.ElementTree as ET

import numpy as np
import rasterio as rio
from rasterio.features import rasterize
from rasterio.warp import reproject, Resampling, transform_geom, transform_bounds
from rasterio.windows import Window
from shapely.geometry import shape, mapping, box
from shapely.ops import unary_union

SPEC=importlib.util.spec_from_file_location('satellite_legacy',Path(__file__).with_name('prepare-satellite.py'))
legacy=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(legacy)
require=legacy.require
sha256=legacy.sha256
save=legacy.write_json
CRS='EPSG:32646'
MASK_VERSION='scl456-dn-city-v1'
REASONS={**legacy.REASONS,12:'outside_target',13:'outside_source_footprints'}
LAYER_SPECS={'true-color.tif':('uint8',3,0),'ndvi.tif':('float32',1,-9999),
             'ndvi-rgba.tif':('uint8',4,None),'scl.tif':('uint8',1,0),
             'exclusion-reason.tif':('uint8',1,None),'target-mask.tif':('uint8',1,None),
             'footprint-mask.tif':('uint8',1,None),'source-tile.tif':('uint8',1,None),
             'geographic-mask.tif':('uint8',1,None),'usable-mask.tif':('uint8',1,None),
             'tci-valid-mask.tif':('uint8',1,None)}


def pinned(path, item):
    require(path.is_file() and path.stat().st_size==item['bytes'] and sha256(path)==item['sha256'],f'Input checksum: {path.name}')
    return path


def xml(path, name):
    return legacy.xml_values(path,name)[0].text


def acquire(run):
    """Only pinned selected seasonal 2024–2026 dates; source budget and raw log are local."""
    from satellite_fetch import Source
    cfg=json.loads((run/'config.json').read_text())
    sp=Path(cfg['selection_manifest'])
    require(sha256(sp)==cfg['selection_sha256'],'Selection manifest changed')
    selection=json.loads(sp.read_text());root=sp.parents[1]
    date=datetime.strptime(cfg['date'],'%Y-%m-%d').date()
    require((date.year in (2024,2025) and date.month in (5,6,8,9)) or cfg['date'] in ('2026-06-06','2026-09-09'),
            'Only selected seasonal 2024–2026 dates are authorized')
    proposal=next((p for p in selection['proposals'] if p['date']==cfg['date']),None)
    require(proposal is not None,'Date missing from pinned selection')
    require(cfg['tiles']==proposal['tiles'],'Product selection differs')
    source=Source(run);tiles=[]
    shortlist=json.loads((sp.parent/'shortlist.json').read_text())
    group=next(g for g in shortlist if g['date']==cfg['date'])
    def retained(path, expected_sha, url):
        require(path.is_file() and sha256(path)==expected_sha,'Retained selection input changed')
        return {'path':str(path),'bytes':path.stat().st_size,'sha256':expected_sha,'source':url,'reused':True}
    for t in proposal['tiles']:
        sid=t['scene_id'];inputs={}
        for key,band in [('red_jp2','B04'),('nir_jp2','B08'),('red','red'),('nir','nir'),('visual','visual')]:
            original=key.endswith('_jp2')
            a=t['native_JP2_availability'][band] if original else t['assets'][key]
            expected=a['bytes'] if original else a['content_length']
            name=f'{sid}-{band}.jp2' if original else f'{sid}-{key}.tif'
            reused=cfg.get('reuse_inputs',{}).get(sid,{}).get(key)
            if reused:
                require(reused['source']==a['source'] and reused['bytes']==expected,'Reused source/size differs from selection')
                pinned(Path(reused['path']),reused)
                inputs[key]={**reused,'reused':True}
                print('reused',sid,key,expected,flush=True)
                continue
            path=run/'raw'/name
            if not path.exists():
                r=source.get(name,a['source'])
                require(r['status']==200 and r['bytes']==expected,'Unexpected full response')
            logs=[json.loads(l) for l in (run/'requests.jsonl').read_text().splitlines()]
            r=next(r for r in logs if r['name']==name and not r.get('error'))
            require(r['url']==a['source'] and r['method']=='GET' and r['status']==200,
                    'Retained download source/method/status differs from selection')
            require(path.stat().st_size==expected and sha256(path)==r['sha256'],'Downloaded input is partial or changed')
            inputs[key]={'path':str(path),'bytes':expected,'sha256':r['sha256'],'source':a['source'],'reused':False}
            print('retained',sid,key,expected,flush=True)
        for key,filename,url,h in [
            ('scl',f'{sid}-scl.tif',t['assets']['scl']['source'],None),
            ('product_xml',f'{sid}-product.xml','native same-product XML',t['product_XML_sha256']),
            ('granule_xml',f'{sid}-granule.xml','native same-product granule XML',t['granule_XML_sha256'])]:
            entry=selection['artifacts']['raw/'+filename]
            require(h is None or entry['sha256']==h,'XML hash identity')
            log=next(json.loads(l) for l in (root/'requests.jsonl').read_text().splitlines() if json.loads(l)['name']==filename)
            inputs[key]=retained(root/'raw'/filename,entry['sha256'],log['url'])
        item=next(i for i in group['items'] if i['id']==sid)
        tiles.append({**t,'inputs':inputs,'stac_item':item})
    target_path=root/'target.geojson';target_hash=selection['target']['sha256']
    target_item=retained(target_path,target_hash,'A9.4 fixed AOI with boundary provenance')
    target=json.loads(target_path.read_text());boundary=Path(target['properties']['source'])
    boundary_item=retained(boundary,target['properties']['sha256'],target['properties']['source_properties']['source_url'])
    logs=[json.loads(l) for l in (run/'requests.jsonl').read_text().splitlines()]
    record={'schema_version':1,'observation_date':cfg['date'],'selection_manifest':str(sp),'selection_sha256':sha256(sp),
            'target':target_item,'boundary':boundary_item,'tiles':tiles,
            'acquisition':{'strategy':'Full native JP2 and full COG after measured first JP2 cost; cached SCL/XML reused',
                          'source_requests':len(logs),'download_bytes':sum(r['bytes'] for r in logs),
                          'download_active_seconds':sum(r['elapsed_seconds'] for r in logs),
                          'timing':'sum of sequential HTTP request durations, including transfer; excludes idle implementation time',
                          'archive_extraction':False,'raw_log':str(run/'requests.jsonl'),'raw_log_sha256':sha256(run/'requests.jsonl')}}
    save(run/'inputs-manifest.json',record)
    print(json.dumps(record['acquisition']),flush=True)


def blocks(width,height,size):
    require(isinstance(size,int) and 1<=size<=512,'Block side must be at most 512 pixels')
    for row in range(0,height,size):
        for col in range(0,width,size):
            yield Window(col,row,min(size,width-col),min(size,height-row))


def read_window(src, window):
    """Clip before IO; no full-image or implicit boundless VRT decode."""
    out=np.zeros((src.count,int(window.height),int(window.width)),dtype=src.dtypes[0])
    left=max(0,int(window.col_off));top=max(0,int(window.row_off))
    right=min(src.width,int(window.col_off+window.width));bottom=min(src.height,int(window.row_off+window.height))
    if right>left and bottom>top:
        data=src.read(window=Window(left,top,right-left,bottom-top))
        rr,cc=top-int(window.row_off),left-int(window.col_off)
        out[:,rr:rr+data.shape[1],cc:cc+data.shape[2]]=data
    return out


def read_at(src, affine, shape):
    col=(affine.c-src.transform.c)/src.res[0];row=(src.transform.f-affine.f)/src.res[1]
    require(abs(col-round(col))<1e-6 and abs(row-round(row))<1e-6,'Non-native band alignment')
    return read_window(src,Window(round(col),round(row),shape[1],shape[0]))


def read_scl(src, affine, shape):
    col=math.floor((affine.c-src.transform.c)/20);row=math.floor((src.transform.f-affine.f)/20)
    right=math.ceil((affine.c+shape[1]*10-src.transform.c)/20)
    bottom=math.ceil((src.transform.f-affine.f+shape[0]*10)/20)
    win=Window(col,row,right-col,bottom-row);data=read_window(src,win)[0]
    result=np.zeros(shape,dtype='uint8')
    reproject(data,result,src_transform=src.window_transform(win),src_crs=src.crs,
              dst_transform=affine,dst_crs=CRS,src_nodata=0,dst_nodata=0,resampling=Resampling.nearest)
    return result


def assign(footprints, affine, shape):
    assignment=np.zeros(shape,dtype='uint8');overlap=np.zeros(shape,dtype='uint8')
    for index,geom in enumerate(footprints,1):
        part=rasterize([(geom,1)],out_shape=shape,transform=affine).astype(bool)
        overlap+=part.astype('uint8')
        assignment[part&(assignment==0)]=index
    return assignment,overlap>1


def verify_encoding(cog, original, chosen):
    require(not np.any(chosen&(original==65535)),'Unestablished JP2 saturation encoding')
    expected=np.where(original==0,0,np.maximum(original.astype('int32')-1000,1))
    require(np.array_equal(cog[chosen],expected[chosen]),'New-product COG/JP2 encoding not established')
    return {'checked_pixels':int(chosen.sum()),'positive_reference_pixels':int((chosen&(original>1000)).sum()),
            'reference_nodata':int((chosen&(original==0)).sum()),
            'reference_low_1_1000':int((chosen&(original>0)&(original<=1000)).sum()),
            'COG_DN1':int((chosen&(cog==1)).sum()),'mismatches':0}


def validate_identity(tile):
    inp=tile['inputs'];item=tile['stac_item'];p=item['properties'];product=Path(inp['product_xml']['path']);granule=Path(inp['granule_xml']['path'])
    require(tile['scene_id']==item['id'] and tile['product_uri']==p['s2:product_uri']==xml(product,'PRODUCT_URI'),'Product identity')
    require(tile['baseline']==p['s2:processing_baseline']==xml(product,'PROCESSING_BASELINE'),'Baseline identity')
    require(tile['acquired_at_granule']==xml(granule,'SENSING_TIME'),'Granule observation time')
    require(abs((legacy.utc_time(p['datetime'])-legacy.utc_time(tile['acquired_at_granule'])).total_seconds())<.001,'Observation time mismatch')
    require(xml(product,'SPACECRAFT_NAME').replace('Sentinel-','S')==tile['scene_id'][:3],'Spacecraft identity')
    take=next(e.attrib['datatakeIdentifier'] for e in ET.parse(product).iter() if e.tag.split('}')[-1]=='Datatake')
    require(take==tile['datatake']==p['s2:datatake_id'],'Datatake identity')
    require(int(xml(product,'BOA_QUANTIFICATION_VALUE'))==10000,'Unsupported quantification')
    offsets={e.attrib['band_id']:int(e.text) for e in ET.parse(product).iter() if e.tag.split('}')[-1]=='BOA_ADD_OFFSET'}
    require(offsets['3']==offsets['7']==-1000,'Unsupported XML offsets')
    for key in ['red','nir','visual','scl']:
        require(inp[key]['source']==item['assets'][key]['href'],'Band/scene source identity')
    require(f'_T{tile["tile"].removeprefix("MGRS-")}_' in xml(granule,'TILE_ID'),'Tile identity')


def opened_sources(stack, tile):
    sources={key:stack.enter_context(rio.open(tile['inputs'][key]['path'])) for key in ['red','nir','visual','scl','red_jp2','nir_jp2']}
    ref=sources['red']
    require(ref.crs.to_epsg()==32646 and ref.transform.a==10 and ref.transform.e==-10 and
            ref.transform.b==ref.transform.d==0,'Native projected source grid')
    for key in ['red','nir','red_jp2','nir_jp2']:
        legacy.validate_grid(sources[key],ref,nodata=None if key.endswith('_jp2') else 0)
    legacy.validate_grid(sources['visual'],ref,count=3,dtype='uint8')
    legacy.validate_grid(sources['scl'],ref,factor=2,dtype='uint8')
    return sources


def grid_for(geometry):
    xmin,ymin,xmax,ymax=geometry.bounds
    left,top=math.floor(xmin/10)*10,math.ceil(ymax/10)*10
    width,height=math.ceil((xmax-left)/10),math.ceil((top-ymin)/10)
    return rio.Affine(10,0,left,0,-10,top),width,height


def prepare(config_path, output):
    started=time.perf_counter();require(not output.exists(),'Release directory already exists')
    recipe=json.loads(config_path.read_text());require(recipe['schema_version']==3,'City recipe schema required')
    inputs_path=Path(recipe['inputs_manifest']);require(sha256(inputs_path)==recipe['inputs_sha256'],'Inputs manifest changed')
    record=json.loads(inputs_path.read_text());tiles=sorted(record['tiles'],key=lambda t:t['scene_id'])
    require(tiles and len(tiles)<=8 and len({t['scene_id'] for t in tiles})==len(tiles),'Unique explicit tiles required')
    require(len({t['datatake'] for t in tiles})==1 and len({t['platform'] for t in tiles})==1,'Mixed observation')
    require(all(t['date']==record['observation_date'] for t in tiles),'Mixed dates')
    for item in [record['target'],record['boundary'],*[v for t in tiles for v in t['inputs'].values()]]:
        pinned(Path(item['path']),item)
    for tile in tiles:validate_identity(tile)
    target=json.loads(Path(record['target']['path']).read_text());boundary=json.loads(Path(record['boundary']['path']).read_text())
    geometry=shape(transform_geom('EPSG:4326',CRS,target['geometry']))
    require(geometry.is_valid and not geometry.is_empty,'Invalid target')
    projected_footprints=[transform_geom('EPSG:4326',CRS,t['stac_item']['geometry']) for t in tiles]
    require(unary_union([shape(g) for g in projected_footprints]).covers(geometry),'Incomplete source footprint coverage')
    affine,width,height=grid_for(geometry);block=recipe.get('block_size',512)
    require(1<=block<=512,'Block memory limit')
    memory_budget=recipe.get('peak_memory_budget_MiB',768)
    require(128<=memory_budget<=1024,'Explicit peak memory budget must be 128..1024 MiB')
    output.mkdir(parents=True,exist_ok=False)
    save(output/'recipe.json',recipe);save(output/'inputs-manifest.json',record)
    save(output/'target.geojson',target);save(output/'boundary.geojson',boundary)
    save(output/'legend.json',legacy.legend())
    save(output/'source-footprints.geojson',{'type':'FeatureCollection','features':[
        {'type':'Feature','properties':{'source_index':i,'scene_id':t['scene_id']},'geometry':t['stac_item']['geometry']}
        for i,t in enumerate(tiles,1)]})
    native_bounds=list(rio.transform.array_bounds(height,width,affine));bounds=list(transform_bounds(CRS,'EPSG:4326',*native_bounds,densify_pts=21))
    save(output/'prepared-grid.geojson',{'type':'Feature','properties':{'scope':'prepared_rectangle'},
         'geometry':transform_geom(CRS,'EPSG:4326',mapping(box(*native_bounds)))})
    counts={k:0 for k in REASONS};total_target=0;geographic_count=0;footprint_count=0;tci_count=0;overlap_count=0
    marginal_dn1=0;max_error=0.;assignments={str(i):0 for i in range(1,len(tiles)+1)}
    radiometry={t['scene_id']:{key:{} for key in ['red','nir']} for t in tiles}
    with ExitStack() as stack:
        sources=[opened_sources(stack,t) for t in tiles]
        writers={}
        for name,(dtype,count,nodata) in LAYER_SPECS.items():
            dst=stack.enter_context(rio.open(output/name,'w',driver='GTiff',width=width,height=height,count=count,
                dtype=dtype,crs=CRS,transform=affine,nodata=nodata,tiled=True,blockxsize=256,blockysize=256,compress='deflate',num_threads=1))
            if name in ['true-color.tif','ndvi-rgba.tif']:
                dst.colorinterp=(rio.enums.ColorInterp.red,rio.enums.ColorInterp.green,rio.enums.ColorInterp.blue)+((rio.enums.ColorInterp.alpha,) if count==4 else ())
            writers[name]=dst
        for win in blocks(width,height,block):
            at=rio.windows.transform(win,affine);sh=(int(win.height),int(win.width))
            aoi=rasterize([(mapping(geometry),1)],out_shape=sh,transform=at).astype(bool)
            assignment,overlap=assign(projected_footprints,at,sh);footprint=assignment>0
            assignment[~aoi]=0
            red=np.zeros(sh,dtype='uint16');nir=np.zeros(sh,dtype='uint16');scl=np.zeros(sh,dtype='uint8')
            rgb=np.zeros((3,*sh),dtype='uint8');direct=np.full(sh,np.nan)
            for i,(tile,src) in enumerate(zip(tiles,sources),1):
                chosen=assignment==i
                if not chosen.any():continue
                values={key:read_at(src[key],at,sh) for key in ['red','nir','visual','red_jp2','nir_jp2']}
                sc=read_scl(src['scl'],at,sh)
                for key,reference in [('red','red_jp2'),('nir','nir_jp2')]:
                    stats=verify_encoding(values[key][0],values[reference][0],chosen)
                    for k,n in stats.items():radiometry[tile['scene_id']][key][k]=radiometry[tile['scene_id']][key].get(k,0)+n
                red[chosen]=values['red'][0][chosen];nir[chosen]=values['nir'][0][chosen]
                rgb[:,chosen]=values['visual'][:,chosen];scl[chosen]=sc[chosen]
                r=values['red_jp2'][0].astype('float64');n=values['nir_jp2'][0].astype('float64');den=n+r-2000
                truth=np.divide(n-r,den,out=np.full(sh,np.nan),where=den!=0);direct[chosen]=truth[chosen]
                assignments[str(i)]+=int(chosen.sum())
            ndvi,reasons=legacy.calculate(red,nir,scl)
            reasons[aoi&~footprint]=13;reasons[~aoi]=12
            valid=(reasons==0);ndvi[~valid]=-9999
            require(np.allclose(ndvi[valid],direct[valid],rtol=0,atol=6e-8),'Independent native-JP2 NDVI mismatch')
            if valid.any():max_error=max(max_error,float(np.max(abs(ndvi[valid]-direct[valid]))))
            geographic=aoi&footprint&(red!=0)&(nir!=0)&(scl!=0)
            tci_valid=aoi&footprint&np.any(rgb!=0,axis=0)
            total_target+=int(aoi.sum());geographic_count+=int(geographic.sum());footprint_count+=int((aoi&footprint).sum())
            tci_count+=int(tci_valid.sum());overlap_count+=int((aoi&overlap).sum())
            marginal_dn1+=int((aoi&((red==1)|(nir==1))).sum())
            for code in REASONS:counts[code]+=int((reasons==code).sum())
            layers={'true-color.tif':rgb,'ndvi.tif':ndvi,'ndvi-rgba.tif':legacy.colorize(ndvi,valid),
                    'scl.tif':scl,'exclusion-reason.tif':reasons,'target-mask.tif':aoi.astype('uint8'),
                    'footprint-mask.tif':footprint.astype('uint8'),'source-tile.tif':assignment,
                    'geographic-mask.tif':geographic.astype('uint8'),'usable-mask.tif':valid.astype('uint8'),
                    'tci-valid-mask.tif':tci_valid.astype('uint8')}
            for name,data in layers.items():writers[name].write(data[None] if data.ndim==2 else data,window=win)
            require(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss<=memory_budget*1024,'Peak process memory budget exceeded; release incomplete')
            if win.col_off==0:print('processed row',int(win.row_off),'of',height,flush=True)
    require(sum(assignments.values())==footprint_count==total_target,'AOI missing source assignment')
    require(sum(counts.values())==width*height and counts[12]==width*height-total_target,'Coverage double count')
    for stats in radiometry.values():
        for band in stats.values():require(band.get('positive_reference_pixels',0)>0 and band['mismatches']==0,'No established radiometry for tile')
    coverage={'scope':'target_polygon_pixel_centers','target_pixels':total_target,'source_footprint_pixels':footprint_count,
              'geographic_pixels':geographic_count,'usable_pixels':counts[0],'tci_valid_pixels':tci_count,
              'geographic_fraction':geographic_count/total_target,'valid_fraction':counts[0]/total_target,
              'nodata_fraction':counts[1]/total_target,'masked_fraction':(total_target-counts[0]-counts[1]-counts[13])/total_target,
              'outside_source_fraction':counts[13]/total_target,'exclusive_reason_counts':{REASONS[k]:n for k,n in counts.items() if k!=12},
              'outside_target_pixels':counts[12],'rectangle_pixels':width*height,'overlap_target_pixels':overlap_count,
              'source_assignment_pixels':assignments,'dn1_marginal_pixels':marginal_dn1}
    assets={}
    for p in sorted(output.iterdir()):
        a={'path':p.name,'bytes':p.stat().st_size,'sha256':sha256(p)}
        if p.name in LAYER_SPECS:
            with rio.open(p) as src:
                require(src.shape==(height,width) and src.transform==affine and str(src.crs)==CRS,'Output grid mismatch')
                a.update(crs=CRS,bands=src.count,dtype=src.dtypes[0],nodata=src.nodata)
        assets[p.name]=a
    result={'schema_version':3,'status':'prepared_offline_city','observation_date':record['observation_date'],
            'created_at':datetime.now(timezone.utc).isoformat(),'method_version':legacy.METHOD,'mask_version':MASK_VERSION,
            'legend_version':legacy.legend()['version'],'processing_version':'city-block-v1',
            'scenes':[{k:t[k] for k in ['scene_id','product_uri','tile','platform','baseline','datatake','acquired_at_catalog','acquired_at_granule']} for t in tiles],
            'grid':{'crs':CRS,'transform':list(affine)[:6],'width':width,'height':height,'resolution_m':10,'block_size':block,'mask_source_resolution_m':20},
            'native_bounds':native_bounds,'bounds':bounds,'target':{'path':'target.geojson','sha256':sha256(output/'target.geojson'),
                'boundary_path':'boundary.geojson','boundary_sha256':sha256(output/'boundary.geojson'),'buffer_m':target['properties']['buffer_m']},
            'coverage':coverage,'source_assignment':{'rule':'first lexicographically sorted scene footprint, independent of quality; all channels/SCL from assigned tile',
                'indices':{str(i):t['scene_id'] for i,t in enumerate(tiles,1)},'outside_target_index':0},
            'radiometry':{'encoding':'exact own-product JP2 comparison of every assigned AOI pixel: COG=max(JP2-1000,1), original 0 remains 0',
                'applied_scale':.0001,'applied_offset':0,'product_offset_dn':-1000,'provider_shift_dn':1000,
                'quantification':10000,'ndvi':'(rho_B08-rho_B04)/(rho_B08+rho_B04)','max_NDVI_absolute_error':max_error,
                'proof_scope':'assigned AOI pixel centers only, including SCL-excluded pixels; no claim for unprepared rest of tile','bands':radiometry},
            'mask':{'accepted_scl':[4,5,6],'water_included':True,'reason_codes':REASONS,'DN1':'unknown even with JP2 available',
                'SCL_resampling':'nearest to exact 10m block grid','band_resampling':'none','cloud_buffer':None},
            'recipe_sha256':sha256(output/'recipe.json'),'source_recipe_sha256':sha256(config_path),
            'inputs_manifest_sha256':sha256(output/'inputs-manifest.json'),'assets':assets,
            'metrics':{'processing_seconds_before_manifest':time.perf_counter()-started,'peak_RSS_KiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                'memory_measurement':'Linux getrusage(RUSAGE_SELF).ru_maxrss for whole process, including imports/codecs/hashing/IO',
                'max_computation_block_pixels':block*block,'peak_memory_budget_MiB':memory_budget,'output_bytes_excluding_manifest':sum(a['bytes'] for a in assets.values()),
                'acquisition':record['acquisition']},
            'software':{'python':sys.version,'numpy':np.__version__,'rasterio':rio.__version__,'gdal':rio.__gdal_version__,
                'city_module_sha256':sha256(Path(__file__)),'legacy_numeric_module_sha256':sha256(Path(__file__).with_name('prepare-satellite.py'))},
            'limitations':['No vegetation percentage','SCL not independently validated','Geometries are small AOI/rectangle/scene polygons; usable coverage remains a raster, not a city-size polygonization',
                'Missing manifest means incomplete release','No API/UI/provider activation or server test','A9.4 OSM boundary snapshot is not a legal cadastral boundary']}
    save(output/'manifest.json',result)
    print(json.dumps({'manifest':str(output/'manifest.json'),'coverage':coverage,'metrics':result['metrics']},ensure_ascii=False),flush=True)
    return result


def validate_city_release(path):
    """Headers, required artifacts, hashes and provenance; does not require network/input files."""
    require(path.is_file(),'Missing city manifest')
    m=json.loads(path.read_text())
    require(m.get('schema_version')==3 and m.get('status')=='prepared_offline_city','Incomplete city release')
    require(m['method_version']==legacy.METHOD and m['mask_version']==MASK_VERSION and m['legend_version']==legacy.legend()['version'],'Incompatible city versions')
    expected=set(LAYER_SPECS)|{'recipe.json','inputs-manifest.json','target.geojson','boundary.geojson','legend.json','source-footprints.geojson','prepared-grid.geojson'}
    require(set(m['assets'])==expected,'Incomplete city asset list')
    for name,a in m['assets'].items():
        require(a['path']==name and Path(name).name==name,'Unsafe/misnamed asset')
        pinned(path.parent/name,a)
    require(sha256(path.parent/'recipe.json')==m['recipe_sha256'] and
            sha256(path.parent/'inputs-manifest.json')==m['inputs_manifest_sha256'],'Recipe/inputs manifest checksum')
    require(m['target']['sha256']==m['assets']['target.geojson']['sha256'] and
            m['target']['boundary_sha256']==m['assets']['boundary.geojson']['sha256'],'AOI provenance checksum')
    require(json.loads((path.parent/'legend.json').read_text())==legacy.legend(),'Legend content mismatch')
    record=json.loads((path.parent/'inputs-manifest.json').read_text());tiles=sorted(record['tiles'],key=lambda t:t['scene_id'])
    require(len(tiles)==len(m['scenes']) and len({t['datatake'] for t in m['scenes']})==1,'Mixed/incomplete city observation')
    for t,s in zip(tiles,m['scenes']):
        require(all(t[k]==s[k] for k in s),'Scene provenance mismatch')
        require(t['date']==m['observation_date'],'Wrong city observation date')
    grid=m['grid'];require(grid['crs']==CRS and grid['resolution_m']==10 and grid['block_size']<=512,'City grid/block contract')
    for name,(dtype,count,nodata) in LAYER_SPECS.items():
        with rio.open(path.parent/name) as src:
            a=m['assets'][name]
            require(src.width==grid['width'] and src.height==grid['height'] and list(src.transform)[:6]==grid['transform'] and
                    str(src.crs)==grid['crs']==a['crs'] and list(src.bounds)==m['native_bounds'],'City raster/grid mismatch')
            require(src.count==count==a['bands'] and all(t==dtype for t in src.dtypes) and a['dtype']==dtype and
                    src.nodata==nodata==a['nodata'],'City encoding mismatch')
    c=m['coverage'];total=c['target_pixels'];require(c['scope']=='target_polygon_pixel_centers' and total>0,'City denominator')
    require(sum(c['exclusive_reason_counts'].values())==total and c['rectangle_pixels']==grid['width']*grid['height'] and
            c['rectangle_pixels']==total+c['outside_target_pixels'],'City coverage double count')
    require(sum(c['source_assignment_pixels'].values())==c['source_footprint_pixels']==total,'City source assignment incomplete')
    require(0<c['usable_pixels']<=c['geographic_pixels']<=total and c['exclusive_reason_counts']['valid']==c['usable_pixels'],'City usable counts')
    require(math.isclose(c['valid_fraction'],c['usable_pixels']/total) and
            math.isclose(c['geographic_fraction'],c['geographic_pixels']/total),'Wrong target denominator')
    require(math.isclose(c['valid_fraction']+c['nodata_fraction']+c['masked_fraction']+c['outside_source_fraction'],1,abs_tol=1e-12),'Coverage fractions')
    proof=m['radiometry'];require(proof['applied_scale']==.0001 and proof['applied_offset']==0 and
                                  0<=proof['max_NDVI_absolute_error']<=6e-8,'Unsupported/unchecked city radiometry')
    for i,scene in enumerate(m['scenes'],1):
        for band in ['red','nir']:
            p=proof['bands'][scene['scene_id']][band]
            require(p['checked_pixels']==c['source_assignment_pixels'][str(i)] and p['mismatches']==0 and
                    p['positive_reference_pixels']>0,'Incomplete product radiometry proof')
    signature={'grid':{k:v for k,v in grid.items() if k!='block_size'},'target_sha256':m['target']['sha256'],
               'legend':legacy.legend(),'mask':m['mask'],'method_version':m['method_version'],
               'assignment_rule':m['source_assignment']['rule'],'bounds':m['bounds'],'native_bounds':m['native_bounds']}
    return m,signature


def circle_city(release,x,y,radius):
    footprints=json.loads((release/'source-footprints.geojson').read_text())
    with rio.open(release/'target-mask.tif') as src:
        a=src.transform
        left=math.floor((x-radius-a.c)/10);top=math.floor((a.f-y-radius)/10)
        right=math.ceil((x+radius-a.c)/10);bottom=math.ceil((a.f-y+radius)/10)
        win=Window(left,top,right-left,bottom-top);at=src.window_transform(win)
        target=src.read(1,window=win,boundless=True,fill_value=0)>0
        rows,cols=np.indices(target.shape);circle=(at.c+(cols+.5)*10-x)**2+(at.f-(rows+.5)*10-y)**2<=radius**2
        rectangle=(rows+top>=0)&(rows+top<src.height)&(cols+left>=0)&(cols+left<src.width)
        source=rasterize([(transform_geom('EPSG:4326',CRS,f['geometry']),1) for f in footprints['features']],
                         out_shape=target.shape,transform=at).astype(bool)
    layers={}
    for key in ['usable-mask','geographic-mask','source-tile','exclusion-reason','ndvi']:
        with rio.open(release/(key+'.tif')) as src:
            layers[key]=src.read(1,window=win,boundless=True,fill_value=-9999 if key=='ndvi' else 0)
    prepared=circle&target&rectangle;valid=prepared&(layers['usable-mask']>0);total=int(circle.sum())
    values=layers['ndvi'][valid]
    result={'center_utm':[float(x),float(y)],'radius_m':radius,'circle_pixels':total,
            'source_footprint_pixels':int((circle&source).sum()),'prepared_pixels':int(prepared.sum()),
            'outside_rectangle_pixels':int((circle&~rectangle).sum()),
            'inside_rectangle_outside_target_pixels':int((circle&rectangle&~target).sum()),
            'geographic_pixels':int((prepared&(layers['geographic-mask']>0)).sum()),'usable_pixels':int(valid.sum()),
            'reason_counts':{REASONS[k]:int((prepared&(layers['exclusion-reason']==k)).sum()) for k in REASONS if k!=12},
            'source_pixels':{str(int(k)):int((prepared&(layers['source-tile']==k)).sum()) for k in np.unique(layers['source-tile'][prepared])},
            'mean_ndvi':float(values.mean(dtype='float64')) if len(values) else None}
    for k in ['source_footprint','prepared','geographic','usable']:result[k+'_fraction']=result[k+'_pixels']/total
    require(sum(result['reason_counts'].values())==result['prepared_pixels'],'Circle denominator/count mismatch')
    require(result['prepared_pixels']+result['outside_rectangle_pixels']+result['inside_rectangle_outside_target_pixels']==total,'Circle outside-target accounting')
    return result


def review_city(release, output):
    """Independent streamed output checks and bounded visual/circle evidence."""
    started=time.perf_counter();require(not output.exists(),'Review directory already exists')
    m,_=validate_city_release(release/'manifest.json');record=json.loads((release/'inputs-manifest.json').read_text())
    tiles=sorted(record['tiles'],key=lambda t:t['scene_id'])
    for item in [record['target'],record['boundary'],*[v for t in tiles for v in t['inputs'].values()]]:pinned(Path(item['path']),item)
    geom=shape(transform_geom('EPSG:4326',CRS,json.loads((release/'target.geojson').read_text())['geometry']))
    foot=[transform_geom('EPSG:4326',CRS,t['stac_item']['geometry']) for t in tiles]
    affine=rio.Affine(*m['grid']['transform']);width,height=m['grid']['width'],m['grid']['height']
    sampled={};counts={k:0 for k in REASONS};max_error=0.;assign_count={str(i):0 for i in range(1,len(tiles)+1)};overlap_count=0
    with ExitStack() as stack:
        readers={name:stack.enter_context(rio.open(release/name)) for name in LAYER_SPECS}
        sources=[opened_sources(stack,t) for t in tiles]
        for win in blocks(width,height,512):
            at=rio.windows.transform(win,affine);sh=(int(win.height),int(win.width))
            data={name:src.read(window=win) for name,src in readers.items()}
            target=data['target-mask.tif'][0]>0;valid=data['usable-mask.tif'][0]>0;reason=data['exclusion-reason.tif'][0]
            expected_target=rasterize([(mapping(geom),1)],out_shape=sh,transform=at)>0
            require(np.array_equal(target,expected_target),'Output AOI differs from pinned geometry')
            expected_assignment,overlap=assign(foot,at,sh);expected_assignment[~target]=0
            require(np.array_equal(expected_assignment,data['source-tile.tif'][0]),'Source seam/overlap assignment mismatch')
            require(np.array_equal(valid,reason==0) and np.array_equal(data['ndvi.tif'][0]==-9999,~valid),'NDVI nodata/mask mismatch')
            rgba=data['ndvi-rgba.tif'];require(np.array_equal(rgba[3]==255,valid) and not rgba[:3,~valid].any(),'NDVI alpha mismatch')
            require(np.array_equal(rgba,legacy.colorize(data['ndvi.tif'][0],valid)),'NDVI legend/color mismatch')
            require(np.all(reason[~target]==12),'Outside target not explicit')
            overlap_count+=int((overlap&target).sum())
            for i,src in enumerate(sources,1):
                selected=expected_assignment==i
                if not selected.any():continue
                sc=read_scl(src['scl'],at,sh);rgb=read_at(src['visual'],at,sh)
                r=read_at(src['red'],at,sh)[0];n=read_at(src['nir'],at,sh)[0]
                require(np.array_equal(data['scl.tif'][0][selected],sc[selected]) and
                        np.array_equal(data['true-color.tif'][:,selected],rgb[:,selected]),'Channels have different tile provenance')
                accepted=selected&np.isin(sc,[4,5,6])&(r>1)&(r<65535)&(n>1)&(n<65535)
                require(np.array_equal(valid[selected],accepted[selected]),'Validity not consistent with source DN/SCL')
                jr=read_at(src['red_jp2'],at,sh)[0].astype('float64');jn=read_at(src['nir_jp2'],at,sh)[0].astype('float64')
                actual=data['ndvi.tif'][0][accepted];truth=(jn[accepted]-jr[accepted])/(jn[accepted]+jr[accepted]-2000)
                if len(actual):max_error=max(max_error,float(np.max(abs(actual-truth))))
                require(np.allclose(actual,truth,rtol=0,atol=6e-8),'Output NDVI differs from own JP2')
                geo=selected&(r!=0)&(n!=0)&(sc!=0)
                require(np.array_equal(data['geographic-mask.tif'][0][selected]>0,geo[selected]),'Geographic data mask mismatch')
                require(np.array_equal(data['tci-valid-mask.tif'][0][selected]>0,np.any(rgb[:,selected]!=0,axis=0)),'TCI availability mismatch')
                assign_count[str(i)]+=int(selected.sum())
            for k in REASONS:
                count=int((reason==k).sum());counts[k]+=count
                if count and k in [1,2,5,7,8] and k not in sampled:
                    rr,cc=np.where(reason==k);j=len(rr)//2
                    sampled[k]=[int(win.row_off+rr[j]),int(win.col_off+cc[j])]
    require(max_error<=6e-8 and assign_count==m['coverage']['source_assignment_pixels'] and overlap_count==m['coverage']['overlap_target_pixels'],'Streamed verification totals')
    require(all(counts[k]==m['coverage']['exclusive_reason_counts'][REASONS[k]] for k in REASONS if k!=12),'Exclusive reason totals')
    output.mkdir(parents=True,exist_ok=False)
    # An exact western AOI edge plus explicit outside and source seam centers, all public/synthetic.
    poly=min(geom.geoms,key=lambda p:p.bounds[0]) if geom.geom_type=='MultiPolygon' else geom
    edge=min(poly.exterior.coords,key=lambda p:p[0]);centers={'inside':(497230,6209920),'target_edge':edge,'outside':(geom.bounds[0]-1500,edge[1])}
    from shapely.geometry import LineString
    seam_x=sorted([shape(f).bounds[2] for f in foot])[0]
    section=geom.intersection(LineString([(seam_x,geom.bounds[1]),(seam_x,geom.bounds[3])]))
    if not section.is_empty:
        line=max(section.geoms,key=lambda p:p.length) if hasattr(section,'geoms') else section
        point=line.interpolate(.5,normalized=True);centers['seam']=(point.x,point.y)
    circles=[dict(case=name,**circle_city(release,*center,radius)) for name,center in centers.items() for radius in [200,1000]]
    for c in circles:
        if c['case']=='outside':require(c['prepared_pixels']==0 and c['mean_ndvi'] is None,'Outside circle should be unknown')
        if c['case']=='seam':require(set(c['source_pixels'])=={'1','2'},'Seam circles must exercise both products')
    from PIL import Image,ImageDraw,ImageFont
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',15)
    canvas=Image.new('RGB',(1500,2040),'white');draw=ImageDraw.Draw(canvas)
    palette=np.array([[60,155,90],[110,110,110],[230,0,200],[170,0,0],[125,65,170],[255,185,20],[160,160,160],
                      [45,60,95],[90,205,235],[180,0,0],[255,0,0],[180,120,60],[245,245,245],[230,20,20]],dtype='uint8')
    for i,(name,title) in enumerate([('true-color.tif','TCI, unchanged provider display'),('ndvi-rgba.tif','NDVI, fixed shared legend v2; checker = unknown'),('exclusion-reason.tif','Exclusions: green valid, yellow cloud, blue-gray SCL2, magenta DN1, gray nodata')]):
        with rio.open(release/name) as src:
            a=src.read(out_shape=(src.count,594,1457),resampling=Resampling.nearest)
        with rio.open(release/'target-mask.tif') as src:target=src.read(1,out_shape=(594,1457),resampling=Resampling.nearest)>0
        if name=='exclusion-reason.tif':rgb=palette[a[0]]
        else:
            rgb=np.moveaxis(a[:3],0,-1).copy()
            if name=='ndvi-rgba.tif':
                rr,cc=np.indices(target.shape);checker=np.where(((rr//5+cc//5)%2)[...,None],200,125).repeat(3,axis=2)
                rgb[a[3]==0]=checker[a[3]==0]
        rgb[~target]=[245,245,245]
        canvas.paste(Image.fromarray(rgb.astype('uint8')),(15,i*660+35));draw.text((15,i*660+8),datetime.strptime(m['observation_date'],'%Y-%m-%d').strftime('%d.%m.%Y')+' | '+title,font=font,fill='black')
    canvas.save(output/'city-overview.png')
    sample_list=[('cloud',*sampled[5])] if 5 in sampled else []
    for code,label in [(1,'nodata'),(2,'ambiguous_DN1'),(7,'SCL2'),(8,'snow')]:
        if code in sampled:sample_list.append((label,*sampled[code]))
    for label,point in [('seam',centers.get('seam')),('inside',centers['inside'])]:
        if point:
            rr,cc=rio.transform.rowcol(affine,*point);sample_list.append((label,int(rr),int(cc)))
    samples=Image.new('RGB',(1040,max(1,len(sample_list))*245),'white');sd=ImageDraw.Draw(samples)
    for i,(label,row,col) in enumerate(sample_list):
        left,top=max(0,col-48),max(0,row-48);win=Window(left,top,min(96,width-left),min(96,height-top))
        layers=[]
        for name in ['true-color.tif','ndvi-rgba.tif','exclusion-reason.tif','source-tile.tif']:
            with rio.open(release/name) as src:a=src.read(window=win)
            if name=='exclusion-reason.tif':rgb=palette[a[0]]
            elif name=='source-tile.tif':rgb=np.array([[245,245,245],[30,140,195],[220,130,55]],dtype='uint8')[a[0]]
            else:
                rgb=np.moveaxis(a[:3],0,-1).copy()
                if len(a)==4:
                    rr,cc=np.indices(a.shape[1:]);v=np.where(((rr//4+cc//4)%2)[...,None],200,125).repeat(3,axis=2);rgb[a[3]==0]=v[a[3]==0]
            layers.append(rgb.astype('uint8'))
        for j,a in enumerate(layers):samples.paste(Image.fromarray(a).resize((230,230),Image.NEAREST),(j*260,i*245+15))
        sd.text((5,i*245),f'{label}: row {row}, col {col} | TCI / NDVI / reason / source',font=font,fill='black')
    samples.save(output/'control-windows.png')
    result={'release':str(release),'manifest_sha256':sha256(release/'manifest.json'),'full_streamed_output_checks':True,
            'NDVI_max_absolute_error':max_error,'source_pixels':assign_count,'overlap_target_pixels':overlap_count,'circles':circles,
            'visual_windows':sample_list,'visual_status':'images_generated; require actual viewing, not independent SCL validation',
            'seconds':time.perf_counter()-started,'peak_RSS_KiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            'module_sha256':sha256(Path(__file__))}
    save(output/'review.json',result)
    print(json.dumps({'review':str(output/'review.json'),'seconds':result['seconds'],'peak_RSS_KiB':result['peak_RSS_KiB'],'circles':circles},ensure_ascii=False),flush=True)
    return result
