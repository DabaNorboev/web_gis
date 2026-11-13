"""Render saved one-period numeric results without repeating pixel verification."""
import argparse
import json
from pathlib import Path

from period_analysis import np, rio, Image, ImageDraw, ImageFont, layout, draw_figure, BINS


def present(run,attempt,output_name):
    output=run/'figures'/output_name;output.mkdir(exist_ok=False)
    sites,_,affine=layout(run)
    data=run/'derived'/attempt
    rows=json.loads((data/'statistics.json').read_text())
    dates=sorted(set(r['date'] for r in rows))
    for date in dates:
        a=np.load(data/f'{date}-arrays.npz')
        with rio.open(run/'raw'/f'{date}-visual-window.tif') as src:rgb=src.read()
        values=(a['ndvi'],a['reasons'],{k:a[k] for k in ['base','include_SCL2','buffer60']},rgb)
        draw_figure(run,output,date,values,sites,affine)
        draw_figure(run,output,date,values,sites,affine,zoom=True)
    # Actual area-normalised distributions, not a mean masquerading as green percentage.
    canvas=Image.new('RGB',(1100,1120),'white');draw=ImageDraw.Draw(canvas)
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',16)
    small=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',13)
    colors=[(45,100,170),(205,120,30),(60,60,60)]
    draw.text((10,7),'Распределение NDVI: отложенные участки, базовая маска; доли пригодных пикселей',font=font,fill='black')
    for j,date in enumerate(dates):draw.text((20+j*300,36),date,font=font,fill=colors[j])
    draw.text((10,63),'Одинаковые интервалы NDVI. Высота столбца — доля в интервале (не плотность и не процент зелени).',font=small,fill='black')
    for i,site in enumerate([s for s in sites if s['split']=='holdout']):
        for col,radius in enumerate([200,1000]):
            x0=50+col*540;y0=145+i*235;width=470;height=150
            draw.text((x0,y0-35),f"{site['id']} | {radius} м",font=font,fill='black')
            for frac in [0,.5,1]:
                y=y0+height-int(frac*height);draw.line((x0,y,x0+width,y),fill=(220,220,220))
                draw.text((x0-35,y-8),f'{frac*100:.0f}%',font=small,fill='black')
            step=width/8
            for j,date in enumerate(dates):
                r=next(r for r in rows if r['site']==site['id'] and r['radius_m']==radius and r['date']==date and r['mask']=='base')
                for k,count in enumerate(r['histogram_counts']):
                    x=x0+k*step+3+j*16;h=count/r['valid_pixels']*height
                    draw.rectangle((x,y0+height-h,x+14,y0+height),fill=colors[j])
            for k in range(8):
                label=f'{BINS[k]:g}…{min(1,BINS[k+1]):g}'
                draw.text((x0+k*step,y0+height+6),label,font=small,fill='black')
    draw.text((10,1085),'Неизвестные пиксели исключены из знаменателя. Полная площадь и пригодность — в таблице; композит сезона не строился.',font=small,fill='black')
    canvas.save(output/'heldout-distributions.png')
    print('Rendered 7 figures from saved numeric results:',output)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--run',required=True,type=Path)
    p.add_argument('--attempt',required=True);p.add_argument('--output-name',required=True)
    a=p.parse_args();present(a.run,a.attempt,a.output_name)
