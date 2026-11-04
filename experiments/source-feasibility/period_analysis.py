"""One-period distribution and an unvalidated single-threshold area candidate."""
import argparse
import csv
import json
import math
from pathlib import Path
import sys

sys.path.insert(0,'data/reports/source-feasibility/2026-11-03-radiometry-01/python-libs')
import numpy as np
import rasterio as rio
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from period_inputs import layout
from check_radiometry import sha256

REASONS={0:'valid',1:'nodata',2:'COG_DN1',3:'saturated',4:'cloud_shadow',5:'cloud_cirrus',
         6:'unclassified',7:'cast_shadow_SCL2',8:'snow',9:'defective',10:'numerical',11:'other',12:'buffer60'}
COLOURS={0:(30,155,160),1:(100,100,100),2:(210,20,170),3:(130,30,60),4:(100,75,150),
         5:(255,190,45),6:(170,170,170),7:(60,75,110),8:(210,230,250),9:(130,30,60),10:(230,30,30),11:(180,180,180),12:(180,130,40)}
BINS=[-1,-.2,0,.2,.3,.4,.6,.8,1.0000001]
THRESHOLDS=[.2,.3,.4,.5]


def masks(red,nir,scl):
    reasons=np.zeros(red.shape,dtype=np.uint8)
    # Exclusive reasons in this priority. Also export marginal clipping separately.
    tests=[(1,(red==0)|(nir==0)|(scl==0)),(2,(red==1)|(nir==1)),
           (3,(red==65535)|(nir==65535)),(4,scl==3),(5,np.isin(scl,[8,9,10])),
           (6,scl==7),(7,scl==2),(8,scl==11),(9,scl==1),
           (11,~np.isin(scl,[0,1,2,3,4,5,6,7,8,9,10,11]))]
    for reason,test in tests: reasons[(reasons==0)&test]=reason
    denom=nir.astype(np.float64)+red.astype(np.float64)
    ndvi=np.divide(nir.astype(np.float64)-red,denom,out=np.full(red.shape,np.nan),where=denom>0)
    bad=(denom<=0)|~np.isfinite(ndvi)|(abs(ndvi)>1)
    reasons[(reasons==0)&bad]=10
    base=reasons==0
    dark=base|((reasons==7)&~bad)
    hazard=np.isin(scl,[3,7,8,9,10,11])
    buffered=np.asarray(Image.fromarray(hazard.astype(np.uint8)*255).filter(ImageFilter.MaxFilter(13)))>0
    strict=base&~buffered
    return ndvi,reasons,{'base':base,'include_SCL2':dark,'buffer60':strict}


def circle(affine,shape,x,y,radius):
    rows,cols=np.indices(shape)
    xx=affine.c+(cols+.5)*affine.a
    yy=affine.f+(rows+.5)*affine.e
    return (xx-x)**2+(yy-y)**2 <= radius**2


def unknown_pattern(shape):
    rr,cc=np.indices(shape)
    a=np.where(((rr//2+cc//2)%2)[...,None],np.array([210,210,210]),np.array([115,115,115]))
    return a.astype(np.uint8)


def ndvi_rgb(ndvi,valid):
    # Fixed shared numerical palette: negative blue, low neutral/brown, high green.
    stops=np.array([-1,-.2,0,.2,.4,.6,.8,1])
    colors=np.array([[35,70,130],[80,140,185],[185,175,155],[205,165,95],[215,220,140],[115,175,90],[35,115,55],[10,65,35]])
    data=np.stack([np.interp(np.nan_to_num(ndvi),stops,colors[:,k]) for k in range(3)],axis=-1).astype(np.uint8)
    data[~valid]=unknown_pattern(ndvi.shape)[~valid]
    return data


def draw_figure(run,output,date,values,sites,affine,zoom=False):
    ndvi,reason,variants,rgb=values;valid=variants['base']
    display_sites=[s for s in sites if s['split']=='holdout'] if zoom else sites
    extent=440 if zoom else 2100
    psize=230;header=190;rowheight=260
    canvas=Image.new('RGB',(1000,header+rowheight*len(display_sites)+80),'white')
    draw=ImageDraw.Draw(canvas);font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',16)
    small=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',13)
    draw.text((8,5),f'{date} | Sentinel-2 L2A | 10 м | '+('Отложенные участки, круг 200 м' if zoom else 'Круги 200 / 1000 м'),font=font,fill='black')
    draw.text((8,29),'Общая шкала NDVI: отрицательные — синий; около нуля — нейтральный; высокие — зелёный',font=small,fill='black')
    bar=ndvi_rgb(np.linspace(-1,1,900)[None,:].repeat(13,axis=0),np.ones((13,900),bool))
    canvas.paste(Image.fromarray(bar),(20,49))
    for v in [-1,-.5,0,.2,.4,.6,.8,1]:draw.text((20+int((v+1)/2*900)-8,65),str(v),font=small,fill='black')
    draw.text((8,87),'Шахматная заливка = НЕИЗВЕСТНО. Кандидат NDVI ≥ 0,30 не является проверенной площадью зелени.',font=small,fill='black')
    for i,(name,color) in enumerate([('Пригодно',COLOURS[0]),('Обрезание DN=1',COLOURS[2]),('Облака',COLOURS[5]),('Тень облака',COLOURS[4]),('Тень SCL2',COLOURS[7]),('Не классиф.',COLOURS[6]),('Nodata',COLOURS[1])]):
        x=8+(i%4)*245;y=110+(i//4)*23;draw.rectangle((x,y,x+12,y+12),fill=color);draw.text((x+17,y-2),name,font=small,fill='black')
    for k,title in enumerate(['Исходное RGB / TCI','NDVI, безразмерный','Пригодность / исключения','Пороговый кандидат']):draw.text((k*250+5,166),title,font=small,fill='black')
    candidate=unknown_pattern(ndvi.shape);candidate[valid]=[195,182,150];candidate[valid&(ndvi>=.3)]=[65,150,75]
    mask=unknown_pattern(ndvi.shape)
    for code,color in COLOURS.items():mask[reason==code]=color
    layers=[np.moveaxis(rgb,0,2),ndvi_rgb(ndvi,valid),mask,candidate]
    half=int(extent/20)
    for i,site in enumerate(display_sites):
        row,col=rio.transform.rowcol(affine,site['x'],site['y']);top=header+i*rowheight
        for k,layer in enumerate(layers):
            a=layer[row-half:row+half,col-half:col+half]
            image=Image.fromarray(a).resize((psize,psize),Image.NEAREST)
            x=k*250+5;canvas.paste(image,(x,top))
            p=200/extent*psize;mid=psize/2
            draw.ellipse((x+mid-p,top+mid-p,x+mid+p,top+mid+p),outline='cyan',width=1)
            if not zoom:
                p=1000/extent*psize
                draw.ellipse((x+mid-p,top+mid-p,x+mid+p,top+mid+p),outline='cyan',width=1)
        split='отложенный' if site['split']=='holdout' else 'настройка'
        label={'vegetation':'растительность','built':'застройка — гипотеза выборки','mixed':'смешанная территория','water':'вода'}[site['expected']]
        draw.text((8,top+psize+3),site['id']+' | '+split+' | '+label+' | RGB не является независимым эталоном',font=small,fill='black')
    bottom=canvas.height-65
    draw.text((8,bottom),'RGB — готовый TCI поставщика; растяжка яркости не количественная. Пороговый кандидат: зелёный ≥ 0,30; бежевый < 0,30.',font=small,fill='black')
    draw.text((8,bottom+21),'Смешанные пиксели 10 м, ошибки SCL и неизвестная площадь ограничивают вывод. Contains modified Copernicus Sentinel data 2024.',font=small,fill='black')
    canvas.save(output/(date+('-heldout-cores.png' if zoom else '-diagnostics.png')))


def analyse(run,proof_path,attempt):
    out=run/'derived'/attempt;out.mkdir(exist_ok=False)
    figures=run/'figures'/attempt;figures.mkdir(exist_ok=False)
    proof=json.loads(proof_path.read_text());assert proof['status']=='window_reference_checked'
    sites,_,affine=layout(run)
    rows=[];cache={};reason_rows=[]
    dates=sorted(set(r['date'] for r in proof['records']))
    for date in dates:
        inputs={}
        for key in ['red','nir','scl','visual']:
            path=run/'raw'/f'{date}-{key}-window.tif'
            if key in ['red','nir']:
                rec=next(r for r in proof['records'] if r['date']==date and r['band']==key)
                assert sha256(path)==rec['crop_sha256']
                assert rec['positive_mismatches']==0 and rec['product_offset_dn']+rec['provider_shift_dn']==0
            with rio.open(path) as src:
                assert src.transform==affine and src.crs.to_epsg()==32646
                inputs[key]=src.read() if key=='visual' else src.read(1)
        ndvi,reasons,variants=masks(inputs['red'],inputs['nir'],inputs['scl'])
        cache[date]=(ndvi,reasons,variants,inputs['visual'])
        np.savez_compressed(out/f'{date}-arrays.npz',ndvi=ndvi,reasons=reasons,**variants)
        for site in sites:
            for radius in [200,1000]:
                region=circle(affine,ndvi.shape,site['x'],site['y'],radius)
                # Check full circles were acquired, do not silently normalise to a truncated window.
                assert not (region[0].any() or region[-1].any() or region[:,0].any() or region[:,-1].any())
                total=int(region.sum());geometric=math.pi*radius**2
                assert abs(total*100/geometric-1)<.01
                for variant,valid in variants.items():
                    accepted=region&valid;n=int(accepted.sum());values=ndvi[accepted]
                    row={'site':site['id'],'split':site['split'],'expected':site['expected'],'date':date,'radius_m':radius,'mask':variant,
                         'total_pixels':total,'total_grid_m2':total*100,'circle_geometric_m2':geometric,
                         'valid_pixels':n,'valid_m2':n*100,'valid_fraction':n/total,'unknown_m2':(total-n)*100,
                         'clip_dn1_pixels':int((region&(reasons==2)).sum()),
                         'clip_dn1_fraction':float((region&(reasons==2)).sum()/total),
                         'clip_dn1_marginal_pixels':int((region&((inputs['red']==1)|(inputs['nir']==1))).sum())}
                    for q in [.1,.5,.9]:row[f'ndvi_p{int(q*100)}']=float(np.quantile(values,q)) if n else None
                    for threshold in THRESHOLDS:
                        count=int((values>=threshold).sum())
                        row[f'candidate_pixels_ge_{threshold}']=count
                        row[f'candidate_m2_ge_{threshold}']=count*100
                        row[f'candidate_fraction_of_valid_ge_{threshold}']=count/n if n else None
                    row['histogram_counts']=np.histogram(values,bins=BINS)[0].tolist()
                    rows.append(row)
                for code,name in REASONS.items():
                    count=int((region&(reasons==code)).sum())
                    reason_rows.append({'site':site['id'],'date':date,'radius_m':radius,'reason':name,'pixels':count,'area_m2':count*100,'fraction_of_total':count/total})
        draw_figure(run,figures,date,cache[date],sites,affine)
        draw_figure(run,figures,date,cache[date],sites,affine,zoom=True)
    # Same-season diagnostic on common valid support. No composite or change attribution.
    sensitivity=[]
    for site in sites:
        for radius in [200,1000]:
            region=circle(affine,next(iter(cache.values()))[0].shape,site['x'],site['y'],radius)
            common=region.copy()
            for date in dates:common&=cache[date][2]['base']
            counts=[int((cache[d][0][common]>=.3).sum()) for d in dates]
            n=int(common.sum());medians=[float(np.median(cache[d][0][common])) if n else None for d in dates]
            classifications=np.stack([cache[d][0][common]>=.3 for d in dates])
            sensitivity.append({'site':site['id'],'radius_m':radius,'dates':dates,'common_valid_pixels':n,
                'common_valid_fraction_of_total':n/int(region.sum()),'candidate_fractions_common': [c/n if n else None for c in counts],
                'ndvi_medians_common':medians,'pixels_crossing_threshold_between_dates':int(np.any(classifications!=classifications[0],axis=0).sum()),
                'interpretation':'temporal sensitivity; not evidence of real vegetation change'})
    for name,data in [('statistics',rows),('exclusions',reason_rows),('date-sensitivity',sensitivity)]:
        (out/(name+'.json')).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
        with (out/(name+'.csv')).open('x',newline='') as target:
            writer=csv.DictWriter(target,fieldnames=list(data[0]));writer.writeheader();writer.writerows(data)
    (out/'method.json').write_text(json.dumps({'proof':str(proof_path),'proof_sha256':sha256(proof_path),
        'sampling_sha256':sha256(run/'sampling-frozen-v2.json'),'threshold':.3,'sensitivity_thresholds':THRESHOLDS,
        'histogram_bins':BINS,'area':'100m2 per native 10m pixel whose centre is in EPSG32646 circle; geometric area also reported',
        'denominator':'candidate / valid area only; unknown is separate; not extrapolated',
        'mask_sensitivity':'base SCL4/5/6; add SCL2; remove a 13x13 square (60m each side) around SCL3/7/8/9/10/11',
        'limits':'RGB labels from same scene are not independent ground truth; no validated vegetation fraction, season composite, ecological health, or user utility'},indent=2)+'\n')
    print('Wrote',len(rows),'statistics rows,',len(reason_rows),'exclusion rows and',len(sensitivity),'common-support rows')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',type=Path,required=True)
    p.add_argument('--proof',type=Path,required=True);p.add_argument('--attempt',required=True)
    a=p.parse_args();analyse(a.run,a.proof,a.attempt)
