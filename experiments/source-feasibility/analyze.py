"""A2 diagnostics with per-file radiometry proof; not a validated change product."""
import argparse
import csv
from decimal import Decimal, localcontext
import hashlib
import json
import math
from pathlib import Path
import resource
import statistics
import time

from PIL import Image, ImageDraw, ImageFont
from radiometry import dn_to_reflectance, verified_recipes

Image.MAX_IMAGE_PIXELS = 130_000_000  # Recorded Sentinel tile size is 10980 squared.
FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'


def font(size=19):
    return ImageFont.truetype(FONT_PATH, size)


def write_json(path, value):
    with path.open('x') as target:
        json.dump(value, target, ensure_ascii=False, indent=2, allow_nan=False)
        target.write('\n')


def utm46(lon, lat):
    """WGS84 Transverse Mercator forward series, cross-checked against provider footprint."""
    a, ecc2, k0 = 6378137.0, 0.0066943799901413165, 0.9996
    phi, delta = math.radians(lat), math.radians(lon - 93)
    ep2 = ecc2 / (1 - ecc2)
    n = a / math.sqrt(1 - ecc2 * math.sin(phi) ** 2)
    t, c, aa = math.tan(phi) ** 2, ep2 * math.cos(phi) ** 2, math.cos(phi) * delta
    m = a * ((1 - ecc2 / 4 - 3 * ecc2**2 / 64 - 5 * ecc2**3 / 256) * phi
             - (3 * ecc2 / 8 + 3 * ecc2**2 / 32 + 45 * ecc2**3 / 1024) * math.sin(2 * phi)
             + (15 * ecc2**2 / 256 + 45 * ecc2**3 / 1024) * math.sin(4 * phi)
             - 35 * ecc2**3 / 3072 * math.sin(6 * phi))
    x = 500000 + k0 * n * (aa + (1 - t + c) * aa**3 / 6
                           + (5 - 18*t + t*t + 72*c - 58*ep2) * aa**5 / 120)
    y = k0 * (m + n * math.tan(phi) * (aa*aa/2 + (5 - t + 9*c + 4*c*c)*aa**4/24
                                     + (61 - 58*t + t*t + 600*c - 330*ep2)*aa**6/720))
    return x, y


def verify_projection(scene):
    transform = scene['assets']['red']['proj:transform']
    height, width = scene['assets']['red']['proj:shape']
    left, right = transform[2], transform[2] + transform[0]*width
    top, bottom = transform[5], transform[5] + transform[4]*height
    points = [utm46(*ll) for ll in scene['geometry']['coordinates'][0][:-1]]
    # STAC geometry is the valid-data footprint, not the full rectangular TIFF.
    # Check the two eastern vertices against the raster edge to half a native pixel.
    eastern = sorted(points, reverse=True)[:2]
    edge_distances = [min(math.dist(p, c) for c in [(right, top), (right, bottom)]) for p in eastern]
    if max(edge_distances) > transform[0]/2:
        raise ValueError('Geographic footprint inconsistent with native raster edge')
    if not all(left <= x <= right and bottom <= y <= top for x, y in points):
        raise ValueError('Geographic footprint outside native raster')
    return edge_distances


def crop_band(run, year, key, scene, extent, size):
    asset = scene['assets'][key]
    dx, _, west, _, dy, north = asset['proj:transform']
    x0, top, x1, bottom = extent
    box = (round((x0-west)/dx), round((top-north)/dy),
           round((x1-west)/dx), round((bottom-north)/dy))
    with Image.open(run/'raw'/f'satellite-{year}-{key}.tif') as im:
        if list(reversed(im.size)) != asset['proj:shape']:
            raise ValueError('TIFF/STAC shape mismatch')
        scale, tie = im.tag_v2[33550], im.tag_v2[33922]
        if (scale[0], -scale[1], tie[3], tie[4]) != (dx, dy, west, north):
            raise ValueError('TIFF/STAC georeferencing mismatch')
        tags = im.tag_v2[34735]
        if (3072, 0, 1, 32646) not in [tuple(tags[i:i+4]) for i in range(4, len(tags), 4)]:
            raise ValueError('Expected EPSG:32646')
        crop = im.crop(box)
        if crop.size != size:
            if key != 'scl':
                raise ValueError('Unexpected reflectance crop shape')
            crop = crop.resize(size, Image.NEAREST)
        return crop.copy()


def summary(values):
    if not values:
        return {'n': 0, 'mean': None, 'median': None, 'min': None, 'max': None}
    return {'n': len(values), 'mean': statistics.fmean(values), 'median': statistics.median(values),
            'min': min(values), 'max': max(values)}


def heat(values, size, low=-1, high=1, difference=False):
    pixels = []
    for v in values:
        if v is None:
            pixels.append((195, 195, 195))
        elif difference:
            q = min(abs(v) / high, 1)
            pixels.append((int(250*(1-q)), int(250-90*q), int(250-200*q)) if v >= 0
                          else (int(250-30*q), int(250*(1-q)), int(250-200*q)))
        else:
            q = max(0, min(1, (v-low)/(high-low)))
            pixels.append((int(220*(1-q)), int(70+110*q), int(90*(1-q))))
    im = Image.new('RGB', size)
    im.putdata(pixels)
    return im


def panel(images, titles, footer, output):
    canvas = Image.new('RGB', (1260, 1060), 'white')
    draw = ImageDraw.Draw(canvas)
    for i, (im, title) in enumerate(zip(images, titles)):
        x, y = 20 + (i % 3)*415, 20 + (i//3)*490
        draw.text((x, y), title, font=font(17), fill='black')
        canvas.paste(im.resize((395, 395), Image.NEAREST), (x, y+45))
    for i, line in enumerate(footer):
        draw.text((20, 1000+i*24), line, font=font(17), fill='black')
    canvas.save(output)


def satellite(run, output, figures, radiometry_evidence=None):
    started = time.monotonic()
    config = json.loads((run/'config.json').read_text())
    scenes = json.loads((run/'selected-scenes.json').read_text())
    recipes = verified_recipes(radiometry_evidence, scenes, run/'raw')
    center = utm46(*config['public_center'])
    west, north = math.floor((center[0]-1900)/20)*20, math.ceil((center[1]+1900)/20)*20
    extent, size = (west, north, west+3800, north-3800), (380, 380)
    method = {'formula': '(NIR_reflectance - red_reflectance)/(NIR_reflectance + red_reflectance)',
              'status': 'radiometry checked on these exact files against original JP2; vegetation-change validity not established',
              'radiometry_evidence': str(radiometry_evidence),
              'reflectance': '(stored DN + verified provider shift + XML BOA offset)/XML quantification',
              'effective_legacy_cog_transform': 'DN/10000 for verified retained pixels only; 0 nodata and 1 ambiguous/clipped excluded',
              'valid_scl': [4, 5, 6], 'scl_resampling': 'nearest; aligned 20m to 10m grid',
              'additional_validity': 'both reflectances nonnegative and sum > 0',
              'period_layer': 'one clear acquisition per year, not a validated seasonal composite',
              'dates': [s['properties']['datetime'] for s in scenes],
              'center_lon_lat': config['public_center'], 'center_epsg32646': center,
              'extent_epsg32646': extent, 'shape': size, 'circle_rule': '10m pixel centre in UTM circle',
              'circle_boundary_error': 'pixel-centre area, half pixel diagonal = sqrt(50) m',
              'projection_limitation': 'UTM grid metres; local scale near central meridian about 0.9996',
              'tuning': 'formula/mask selected from source metadata; no empirical accuracy tuning',
              'independent_controls': 'labels not established: do not claim method validation',
              'difference_display_only': [-0.4, 0.4], 'numeric_change_threshold': None}
    write_json(output/'frozen-method.json', method)
    results, indices, source_images, masks, manual = {}, {}, [], [], []
    for year, scene in zip(config['years'], scenes):
        errors = verify_projection(scene)
        bands = {k: crop_band(run, year, k, scene, extent, size) for k in ['red', 'nir', 'scl']}
        data = {k: list(v.getdata()) for k, v in bands.items()}
        red_recipe, nir_recipe = [recipes[(scene['id'], key)] for key in ['red', 'nir']]
        vals, valid = [], []
        for red, nir, scl in zip(data['red'], data['nir'], data['scl']):
            rr = dn_to_reflectance(red, **red_recipe)
            nn = dn_to_reflectance(nir, **nir_recipe)
            ok = scl in method['valid_scl'] and rr is not None and nn is not None and rr >= 0 and nn >= 0 and rr+nn > 0
            valid.append(ok)
            vals.append((nn-rr)/(nn+rr) if ok else None)
        indices[year] = vals
        results[str(year)] = {'scene': scene['id'], 'datetime': scene['properties']['datetime'],
                              'footprint_to_eastern_raster_corners_m': errors, 'all_crop': summary([v for v in vals if v is not None]),
                              'scl_counts': {str(k): data['scl'].count(k) for k in sorted(set(data['scl']))}, 'circles': {}}
        mask = Image.new('RGB', size)
        mask.putdata([(35, 155, 90) if ok else (185, 185, 185) for ok in valid])
        masks.append(mask)
        for band in ['red', 'nir']:
            display = Image.new('L', size)
            display.putdata([int(max(0, min(255, (dn_to_reflectance(dn, **recipes[(scene['id'], band)]) or 0)/.4*255))) for dn in data[band]])
            source_images.append(display)
        source_images.append(heat(vals, size))
        for radius in [200, 1000]:
            inside = [i for i in range(len(vals)) if math.hypot(west+(i%size[0]+.5)*10-center[0],
                                                            north-(i//size[0]+.5)*10-center[1]) <= radius]
            real = [vals[i] for i in inside if vals[i] is not None]
            area = len(inside)*100
            assert math.pi*(radius-math.sqrt(50))**2 <= area <= math.pi*(radius+math.sqrt(50))**2
            results[str(year)]['circles'][str(radius)] = summary(real) | {
                'total_pixels': len(inside), 'rasterized_circle_area_m2': area,
                'analytic_circle_area_m2': math.pi*radius*radius, 'valid_area_m2': len(real)*100,
                'valid_fraction': len(real)/len(inside), 'missing_pixels': len(inside)-len(real)}
        # Independent high-precision manual checks of three raw pixels, not repeated float arithmetic.
        for i in [i for i, v in enumerate(vals) if v is not None][::max(1, sum(valid)//3)][:3]:
            with localcontext() as context:
                context.prec = 30
                rr = Decimal(data['red'][i]+red_recipe['provider_shift_dn']+red_recipe['product_offset_dn'])/Decimal(red_recipe['quantification'])
                nn = Decimal(data['nir'][i]+nir_recipe['provider_shift_dn']+nir_recipe['product_offset_dn'])/Decimal(nir_recipe['quantification'])
                exact = (nn-rr)/(nn+rr)
                error = abs(float(exact)-vals[i])
                assert error < 1e-12
                manual.append({'year': year, 'pixel_index': i, 'red_dn': data['red'][i], 'nir_dn': data['nir'][i],
                               'decimal_ndvi': str(exact), 'float_ndvi': vals[i], 'numeric_error': error})
    difference = [b-a if a is not None and b is not None else None for a, b in zip(*indices.values())]
    results['difference'] = {'scope': '2026 minus 2024, common valid pixels only',
                             'all_crop': summary([v for v in difference if v is not None]), 'circles': {}}
    for radius in [200, 1000]:
        values = [v for i, v in enumerate(difference) if v is not None
                  and math.hypot(west+(i%380+.5)*10-center[0], north-(i//380+.5)*10-center[1]) <= radius]
        results['difference']['circles'][str(radius)] = summary(values) | {'common_valid_area_m2': len(values)*100}
    write_json(output/'satellite-statistics.json', results)
    write_json(output/'manual-pixel-checks.json', manual)
    with (output/'satellite-pixels.csv').open('x', newline='') as target:
        writer = csv.writer(target)
        writer.writerow(['pixel', 'easting', 'northing', 'ndvi_2024', 'ndvi_2026', 'delta_2026_minus_2024'])
        for i, d in enumerate(difference):
            writer.writerow([i, west+(i%380+.5)*10, north-(i//380+.5)*10, indices[2024][i], indices[2026][i], d])
    panel(source_images, ['2024: красный, отражение 0…0,4', '2024: ИК, отражение 0…0,4', '2024: NDVI −1…1, JP2-проверка',
                          '2026: красный, отражение 0…0,4', '2026: ИК, отражение 0…0,4', '2026: NDVI −1…1, JP2-проверка'],
          ['Sentinel-2 / Copernicus; 15.08.2024 и 12.08.2026; участок 3,8 × 3,8 км, EPSG:32646.',
           'Радиометрия проверена по JP2 этих продуктов. Индекс не процент зелени; изменение не валидировано.'], figures/'satellite-periods.png')
    common = Image.new('RGB', size)
    common.putdata([(35, 155, 90) if v is not None else (185, 185, 185) for v in difference])
    diffim = heat(difference, size, high=.4, difference=True)
    # Four panels on the same grid: difference is descriptive, no causal labels.
    panel(masks+[common, diffim], ['2024: маска SCL + данные', '2026: маска SCL + данные', 'Общая численная маска',
                                'Диагностическая разность NDVI'],
          ['Маска: SCL 4/5/6 + проверка каналов. SCL 20 м, индекс 10 м; нет проверки точности маски.',
           'Радиометрия проверена, но разность не подтверждает реальные изменения растительности и их причины.'],
          figures/'satellite-masks-difference.png')
    write_json(output/'satellite-processing-cost.json', {'elapsed_seconds': time.monotonic()-started,
               'process_peak_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--attempt', default='analysis-v1')
    parser.add_argument('--radiometry-evidence', required=True, type=Path)
    parser.add_argument('--output-root', type=Path, help='Keep recalculation separate from existing input runs')
    args = parser.parse_args()
    output_root = args.output_root or args.run
    output = output_root/'derived'/args.attempt
    figures = output_root/'figures'/args.attempt
    output.mkdir(exist_ok=False)
    figures.mkdir(exist_ok=False)
    satellite(args.run, output, figures, args.radiometry_evidence)
    print(output)
