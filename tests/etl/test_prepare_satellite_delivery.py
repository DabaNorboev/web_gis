"""Small offline delivery fixtures; distinct from immutable real-data checks."""
import importlib.util, json, tempfile, unittest, hashlib, contextlib, io
from pathlib import Path
import numpy as np
import rasterio as rio
from rasterio.transform import from_origin
from PIL import Image
spec=importlib.util.spec_from_file_location('delivery',Path(__file__).parents[2]/'scripts/prepare-satellite-delivery.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)

class DeliveryTest(unittest.TestCase):
    def test_identity_legend_alpha_and_nearest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);runtime=root/'runtime';runtime.mkdir();releases=[];entries=[]
            for date,color in [('2024-05-07',[35,115,55]),('2026-06-06',[115,175,90])]:
                release=root/date;release.mkdir();assets={}
                a=np.zeros((4,64,64),dtype='uint8');a[:3]=np.array(color)[:,None,None];a[3,:,32:]=255;a[:3,:,:32]=0
                rgb=np.full((3,64,64),80,dtype='uint8');mask=np.zeros((1,64,64),dtype='uint8');mask[:,:,32:]=1
                for name,data in [('ndvi-rgba.tif',a),('true-color.tif',rgb),('tci-valid-mask.tif',mask)]:
                    with rio.open(release/name,'w',driver='GTiff',width=64,height=64,count=len(data),dtype='uint8',crs='EPSG:32646',transform=from_origin(497000,6210000,10,10)) as f:f.write(data)
                    assets[name]={'path':name,'sha256':d.digest(release/name)}
                (release/'legend.json').write_text(json.dumps({'version':'ndvi-fixed-v2','fixture':True}))
                (release/'manifest.json').write_text(json.dumps({'assets':assets}))
                h=d.digest(release/'manifest.json');releases.append({'date':date,'manifest_sha256':h});entries.append({'date':date,'manifest':date+'/manifest.json'})
            index=root/'index.json';index.write_text(json.dumps({'releases':entries}))
            (runtime/'catalog.json').write_text(json.dumps({'source_index':{'sha256':d.digest(index)},'legend_version':'ndvi-fixed-v2','releases':releases}))
            with contextlib.redirect_stdout(io.StringIO()): d.build(runtime,d.digest(runtime/'catalog.json'),index,root/'out')
            c=json.loads((root/'out/catalog.json').read_text());found={};transparent=False
            for key,tile in c['tiles'].items():
                p=root/'out'/(key+'.png');self.assertEqual(d.digest(p),tile['sha256']);im=Image.open(p);self.assertEqual(im.mode,'RGBA');self.assertEqual(im.size,(256,256));a=np.asarray(im)
                self.assertTrue(np.isin(a[:,:,3],[0,255]).all());transparent|=bool((a[:,:,3]==0).any())
                if '/ndvi/' in key:
                    found.setdefault(key[:10],set()).update(map(tuple,a[a[:,:,3]>0,:3]))
            self.assertEqual(found['2024-05-07'],{(35,115,55)});self.assertEqual(found['2026-06-06'],{(115,175,90)});self.assertTrue(transparent)
            with self.assertRaises(ValueError):d.build(runtime,'0'*64,index,root/'bad')
            with self.assertRaises(ValueError):d.build(runtime,d.digest(runtime/'catalog.json'),index,root/'out')

if __name__=='__main__':unittest.main()
