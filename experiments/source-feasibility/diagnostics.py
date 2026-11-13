"""Show real RGB inputs and radiometry uncertainty without selecting a winning offset."""
import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw
from analyze import crop_band, font, heat, panel, summary, write_json


def process(run):
    output, figures = run/'derived/diagnostics-v1', run/'figures/diagnostics-v1'
    output.mkdir(exist_ok=False)
    figures.mkdir(exist_ok=False)
    method = json.loads((run/'derived/analysis-v3/frozen-method.json').read_text())
    scenes = json.loads((run/'selected-scenes.json').read_text())
    extent, size = method['extent_epsg32646'], tuple(method['shape'])
    images, titles, report, rgb_images, validity, band_values = [], [], {}, [], {}, {}
    for year, scene in zip([2024, 2026], scenes):
        rgb_images.append(crop_band(run, year, 'visual', scene, extent, size))
        values = {k: list(crop_band(run, year, k, scene, extent, size).getdata()) for k in ['red', 'nir', 'scl']}
        band_values[year] = values
        comparisons = []
        report[str(year)] = {'boa_offset_applied_flag': scene['properties']['earthsearch:boa_offset_applied'],
                            'asset_offset': scene['assets']['red']['raster:bands'][0]['offset'],
                            'scl_surface_pixels': sum(v in [4, 5, 6] for v in values['scl']), 'hypotheses': {}}
        for offset in [-.1, 0]:
            ndvi = []
            negative = 0
            for red, nir, scl in zip(values['red'], values['nir'], values['scl']):
                rr, nn = red*.0001+offset, nir*.0001+offset
                surface = scl in [4, 5, 6] and red != 0 and nir != 0
                negative += surface and (rr < 0 or nn < 0)
                ndvi.append((nn-rr)/(nn+rr) if surface and rr >= 0 and nn >= 0 and rr+nn > 0 else None)
            images.append(heat(ndvi, size))
            titles.append(f'{year}: NDVI, offset {offset:g}')
            report[str(year)]['hypotheses'][str(offset)] = {'negative_reflectance_surface_pixels': negative,
                'descriptive_ndvi_not_validated': summary([x for x in ndvi if x is not None])}
            comparisons.append(ndvi)
        bad = Image.new('RGB', size)
        bad.putdata([(210, 75, 50) if scl in [4, 5, 6] and (red < 1000 or nir < 1000) else (190, 190, 190)
                     for red, nir, scl in zip(values['red'], values['nir'], values['scl'])])
        images.append(bad)
        titles.append(f'{year}: отрицательное при −0,1')
        validity[year] = comparisons[0]
    report['conclusion'] = 'Unresolved radiometric metadata conflict: neither hypothesis is accepted as validated vegetation output.'
    report['independent_validation'] = 'Stopped: radiometry unresolved and no independently dated changed/unchanged labels established.'
    write_json(output/'radiometry-diagnostic.json', report)
    panel(images, titles, ['Две гипотезы на одних реальных каналах. Эталон радиометрии не установлен.',
                          'Не выбирать вариант по красивой карте или доле валидных пикселей. Это не процент зелени.'],
          figures/'radiometry-diagnostic.png')
    rgb = Image.new('RGB', (1280, 790), 'white')
    draw = ImageDraw.Draw(rgb)
    draw.text((30, 15), 'Реальные исходные TCI Sentinel-2: один и тот же участок Красноярска', font=font(24), fill='black')
    for i, (im, year) in enumerate(zip(rgb_images, [2024, 2026])):
        image = im.resize((590, 590), Image.NEAREST)
        pen = ImageDraw.Draw(image)
        cx = (method['center_epsg32646'][0]-extent[0])/10*590/380
        cy = (extent[1]-method['center_epsg32646'][1])/10*590/380
        for radius in [200, 1000]:
            r = radius/10*590/380
            pen.ellipse((cx-r, cy-r, cx+r, cy+r), outline='white', width=2)
        rgb.paste(image, (30+i*625, 95))
        draw.text((30+i*625, 57), f"{year}: {scenes[i]['properties']['datetime'][:10]}, {scenes[i]['id'].split('_')[0]}", font=font(21), fill='black')
    draw.text((30, 715), 'Белые круги: 200 и 1000 м. TCI — готовый цветовой продукт, не измерение доли растительности.', font=font(19), fill='black')
    draw.text((30, 749), 'Contains modified Copernicus Sentinel data 2024, 2026; Earth Search / Element 84.', font=font(18), fill='black')
    rgb.save(figures/'satellite-real-rgb.png')
    # A clearly labelled map of a diagnostic arithmetic difference, never a validated change map.
    delta = [b-a if a is not None and b is not None else None
             for a, b in zip(validity[2024], validity[2026])]
    diag = heat(delta, size, high=.4, difference=True).resize((640, 640), Image.NEAREST)
    canvas = Image.new('RGB', (1280, 790), 'white')
    d = ImageDraw.Draw(canvas)
    d.text((30, 20), 'Диагностическая разность NDVI: 2026 − 2024', font=font(25), fill='black')
    canvas.paste(diag, (30, 85))
    notes = ['Не подтверждённая карта изменений.', 'Расчёт по заявленному offset −0,1.',
             'Метаданные радиометрии противоречивы.', 'Независимая проверка метода остановлена.',
             'Красный: −0,4; светлый: 0; зелёный: +0,4.', 'Серый: нет общего пригодного значения.',
             'Причины изменения не определяются.', 'Это не процент зелени.']
    for i, note in enumerate(notes):
        d.text((700, 110+i*52), note, font=font(19), fill='black')
    d.text((30, 748), 'Contains modified Copernicus Sentinel data 2024, 2026; только исследовательская диагностика.', font=font(18), fill='black')
    canvas.save(figures/'satellite-diagnostic-difference.png')
    # Save exact SCL-only masks independently of the disputed reflectance offset.
    masks = []
    for year in [2024, 2026]:
        im = Image.new('RGB', size)
        im.putdata([(40, 145, 95) if v in [4, 5, 6] else (190, 190, 190) for v in band_values[year]['scl']])
        masks.append(im)
    panel(masks, ['2024: SCL 4/5/6', '2026: SCL 4/5/6'],
          ['Это маска классов поверхности SCL; её точность независимо не проверена.',
           'Зелёный: SCL 4/5/6; серый: прочее. Маска не устраняет конфликт радиометрии каналов.'],
          figures/'satellite-scl-masks.png')
    print(output)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run', required=True, type=Path)
    process(p.parse_args().run)
