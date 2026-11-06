"""Offline real PNG integrity/palette + independent pixel-centre georeferencing samples."""
import argparse,json,hashlib,math
from pathlib import Path
import numpy as np
import rasterio as rio
from rasterio.warp import transform
from rasterio.windows import Window
from PIL import Image
p=argparse.ArgumentParser();p.add_argument('--delivery',type=Path,required=True);p.add_argument('--sha256',required=True);p.add_argument('--index',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
assert not a.output.exists()
c=json.loads((a.delivery/'catalog.json').read_text());assert hashlib.sha256((a.delivery/'catalog.json').read_bytes()).hexdigest()==a.sha256
idx=json.loads(a.index.read_text());palette={tuple(bytes.fromhex(x['color'][1:])) for x in c['legend']['classes']};samples=0;unknown=0;opaque=0;maxbytes=0
for key,tile in c['tiles'].items():
    raw=(a.delivery/(key+'.png')).read_bytes();assert len(raw)==tile['bytes'] and hashlib.sha256(raw).hexdigest()==tile['sha256'];maxbytes=max(maxbytes,len(raw));assert len(raw)<=300000
    image=np.asarray(Image.open(a.delivery/(key+'.png')));assert image.shape==(256,256,4);assert np.isin(image[:,:,3],[0,255]).all();unknown+=int((image[:,:,3]==0).sum());opaque+=int((image[:,:,3]>0).sum())
    date,layer,z,x,y=key.split('/');z,x,y=int(z),int(x),int(y)
    if layer=='ndvi':assert set(map(tuple,np.unique(image[:,:,:3][image[:,:,3]>0],axis=0)))<=palette
    # Every z13 tile: 9 independent inverse-projected pixel centres, no GDAL warp as oracle.
    if z!=13:continue
    entry=next(e for e in idx['releases'] if e['date']==date);root=(a.index.parent/entry['manifest']).parent
    assert hashlib.sha256((root/'manifest.json').read_bytes()).hexdigest()==c['releases'][date]['manifest_sha256']
    extent=20037508.342789244;span=extent*2/2**z
    with rio.open(root/('ndvi-rgba.tif' if layer=='ndvi' else 'true-color.tif')) as src,rio.open(root/'tci-valid-mask.tif') as mask:
        for row in [31,127,223]:
            for col in [31,127,223]:
                mx=-extent+(x+(col+.5)/256)*span;my=extent-(y+(row+.5)/256)*span
                xx,yy=transform('EPSG:3857',src.crs,[mx],[my]);sr,sc=src.index(xx[0],yy[0]);expected=np.zeros(4,dtype='uint8')
                if 0<=sr<src.height and 0<=sc<src.width:
                    v=src.read(window=Window(sc,sr,1,1))[:,0,0];expected[:len(v)]=v
                    if layer=='true-color':expected[3]=mask.read(1,window=Window(sc,sr,1,1))[0,0]*255
                    if expected[3]==0:expected[:3]=0
                assert np.array_equal(image[row,col],expected),(key,row,col,image[row,col],expected)
                samples+=1
assert unknown>0 and opaque>0
result={'passed':True,'PNG_tiles':len(c['tiles']),'independent_georeference_samples':samples,'transparent_pixels':unknown,'opaque_pixels':opaque,'max_PNG_bytes':maxbytes}
a.output.write_text(json.dumps(result,indent=2));print(json.dumps(result))
