#!/usr/bin/env python3
"""Limited offline release review: read-only inputs, new evidence directory only."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import rasterio as rio
from rasterio.features import rasterize
from rasterio.warp import transform_geom
from rasterio.windows import Window


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def circle_coverage(release, x, y, radius):
    """Full native-grid circle denominator, including pixels outside the prepared window."""
    scene = json.loads((release / 'scene.json').read_text())
    with rio.open(release / 'usable-mask.tif') as src:
        a = src.transform
        left = math.floor((x - radius - a.c) / a.a)
        right = math.ceil((x + radius - a.c) / a.a)
        top = math.floor((a.f - y - radius) / -a.e)
        bottom = math.ceil((a.f - y + radius) / -a.e)
        win = Window(left, top, right - left, bottom - top)
        affine = src.window_transform(win)
        usable = src.read(1, window=win, boundless=True, fill_value=0).astype(bool)
        rows, cols = np.indices(usable.shape)
        xx = affine.c + (cols + .5) * affine.a
        yy = affine.f + (rows + .5) * affine.e
        circle = (xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2
        prepared = (rows + top >= 0) & (rows + top < src.height) & (cols + left >= 0) & (cols + left < src.width)
        footprint = rasterize([(transform_geom('EPSG:4326', src.crs, scene['geometry']), 1)],
                              out_shape=usable.shape, transform=affine).astype(bool)
    with rio.open(release / 'geographic-mask.tif') as src:
        geographic = src.read(1, window=win, boundless=True, fill_value=0).astype(bool)
    with rio.open(release / 'exclusion-reason.tif') as src:
        reasons = src.read(1, window=win, boundless=True, fill_value=255)
    with rio.open(release / 'ndvi.tif') as src:
        ndvi = src.read(1, window=win, boundless=True, fill_value=-9999)
    total = int(circle.sum())
    valid = circle & usable & prepared
    result = {'center_utm': [x, y], 'radius_m': radius, 'circle_pixels': total,
              'source_scene_pixels': int((circle & footprint).sum()),
              'prepared_pixels': int((circle & prepared).sum()),
              'outside_prepared_pixels': int((circle & ~prepared).sum()),
              'geographic_pixels': int((circle & geographic & prepared).sum()),
              'usable_pixels': int(valid.sum()),
              'nodata_inside_prepared_pixels': int((circle & prepared & ~geographic).sum()),
              'masked_inside_prepared_pixels': int((circle & prepared & geographic & ~usable).sum()),
              'exclusive_reason_counts_inside_prepared': {str(int(k)): int((circle & prepared & (reasons == k)).sum())
                                                         for k in np.unique(reasons[circle & prepared])},
              'mean_ndvi': float(ndvi[valid].mean(dtype='float64')) if valid.any() else None}
    for prefix in ['source_scene', 'prepared', 'geographic', 'usable']:
        result[prefix + '_fraction'] = result[prefix + '_pixels'] / total
    assert total == (result['usable_pixels'] + result['outside_prepared_pixels'] +
                     result['nodata_inside_prepared_pixels'] + result['masked_inside_prepared_pixels'])
    return result


def review(release, output):
    output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((release / 'manifest.json').read_text())
    assert digest(release / 'recipe.json') == manifest['recipe_sha256']
    for name, asset in manifest['assets'].items():
        assert Path(name).name == name
        assert digest(release / name) == asset['sha256']
        assert (release / name).stat().st_size == asset['bytes']
    # Verify that the claimed calculation belongs to these exact inputs and output grid.
    for item in manifest['inputs'].values():
        assert digest(Path(item['path'])) == item['sha256']
    with rio.open(release / 'ndvi.tif') as ref:
        ndvi = ref.read(1)
        affine, shape = ref.transform, ref.shape
        for name in manifest['assets']:
            if name.endswith('.tif'):
                with rio.open(release / name) as src:
                    assert src.crs == ref.crs and src.transform == affine and src.shape == shape
    with rio.open(release / 'usable-mask.tif') as src:
        valid = src.read(1).astype(bool)
    with rio.open(release / 'exclusion-reason.tif') as src:
        reasons = src.read(1)
    with rio.open(release / 'ndvi-rgba.tif') as src:
        rgba = src.read()
    assert np.array_equal(valid, reasons == 0)
    assert np.array_equal(ndvi == -9999, ~valid)
    assert np.array_equal(rgba[3] == 255, valid)
    assert np.all(rgba[:3, ~valid] == 0)
    coverage = manifest['coverage']
    assert int(valid.sum()) == coverage['usable_pixels']
    assert float(valid.mean()) == coverage['valid_fraction']
    recipe = json.loads((release / 'recipe.json').read_text())
    win = Window(**recipe['window'])
    with rio.open(manifest['inputs']['red_jp2']['path']) as src:
        red = src.read(1, window=win).astype('float64')
    with rio.open(manifest['inputs']['nir_jp2']['path']) as src:
        nir = src.read(1, window=win).astype('float64')
    direct = (nir[valid] - red[valid]) / (nir[valid] + red[valid] - 2000)
    max_error = float(np.max(abs(ndvi[valid] - direct))) if valid.any() else None
    assert max_error == manifest['verification']['ndvi_max_absolute_error']
    # New-date adapter controls: exact TCI crop and independent integer nearest SCL.
    cropped = recipe.get('input_layout', 'full_tile') == 'native_window'
    source_bands = {}
    for key in ['red', 'nir', 'visual']:
        with rio.open(manifest['inputs'][key]['path']) as src:
            source_bands[key] = src.read(window=None if cropped else win)
    with rio.open(release/'true-color.tif') as src:
        assert np.array_equal(src.read(), source_bands['visual'])
    with rio.open(manifest['inputs']['scl']['path']) as src:
        sw = Window(win.col_off//2, win.row_off//2,
                    (win.width+win.col_off%2+1)//2, (win.height+win.row_off%2+1)//2)
        original_scl = src.read(1, window=sw)
    expanded = np.repeat(np.repeat(original_scl, 2, axis=0), 2, axis=1)
    rr, cc = int(win.row_off % 2), int(win.col_off % 2)
    expected_scl = expanded[rr:rr+int(win.height), cc:cc+int(win.width)]
    with rio.open(release/'scl.tif') as src:
        assert np.array_equal(src.read(1), expected_scl)
    red_dn, nir_dn = source_bands['red'][0], source_bands['nir'][0]
    expected_valid = (np.isin(expected_scl, [4, 5, 6]) & (red_dn > 1) & (red_dn < 65535) &
                      (nir_dn > 1) & (nir_dn < 65535))
    assert np.array_equal(valid, expected_valid)
    with rio.open(release/'geographic-mask.tif') as src:
        assert np.array_equal(src.read(1)>0, (red_dn != 0) & (nir_dn != 0) & (expected_scl != 0))
    for code, name in manifest['mask']['reason_codes'].items():
        assert int((reasons == int(code)).sum()) == coverage['exclusive_reason_counts'][name]
    centers = {'inside': (497230, 6209920), 'west_edge': (494080, 6209920),
               'outside_near': (493780, 6209920), 'outside_far': (492080, 6209920)}
    circles = [dict(case=name, **circle_coverage(release, *center, radius))
               for name, center in centers.items() for radius in [200, 1000]]
    # Fixed public synthetic UTM centers. No personal locations or inferred object IDs.
    with rio.open(release / 'true-color.tif') as src:
        tci = np.moveaxis(src.read(), 0, -1)
    with rio.open(release / 'scl.tif') as src:
        scl = src.read(1)
    locations = {'water': (92.949971, 56.018185), 'built': (92.923, 56.038),
                 'vegetation': (92.988528, 56.027632)}
    from rasterio.warp import transform
    samples = []
    for label, (lon, lat) in locations.items():
        xs, ys = transform('EPSG:4326', 'EPSG:32646', [lon], [lat])
        row, col = rio.transform.rowcol(affine, xs[0], ys[0])
        samples.append((label, int(row), int(col)))
    for code, label in [(7, 'excluded_SCL2'), (6, 'excluded_unclassified'), (2, 'excluded_DN1'),
                        (4, 'excluded_cloud_shadow'), (5, 'excluded_cloud_or_cirrus')]:
        rr, cc = np.where(reasons == code)
        if len(rr):
            samples.append((label, int(rr[len(rr)//2]), int(cc[len(cc)//2])))
    canvas = Image.new('RGB', (1240, len(samples) * 215 + 90), 'white')
    draw = ImageDraw.Draw(canvas)
    for i, name in enumerate(['TCI (unaltered)', 'NDVI over checker', 'SCL categorical', 'Exclusion reason']):
        draw.text((i * 256 + 5, 5), name, fill='black')
    # Deterministic diagnostic palette for categorical inspection, not a land-cover legend.
    palette = np.array([[40, 150, 80], [100, 100, 100], [230, 0, 210], [190, 0, 0], [95, 60, 150],
                        [255, 180, 0], [160, 160, 160], [40, 65, 110], [220, 230, 255], [140, 0, 0],
                        [255, 0, 0], [180, 120, 60]], dtype='uint8')
    scl_palette = np.array([[0, 0, 0], [190, 0, 0], [50, 65, 110], [95, 60, 150], [40, 150, 80],
                            [200, 170, 120], [40, 100, 210], [160, 160, 160], [230, 230, 230],
                            [255, 255, 255], [220, 200, 255], [200, 230, 255]], dtype='uint8')
    sample_records = []
    for i, (name, row, col) in enumerate(samples):
        r0, r1, c0, c1 = max(0, row-40), min(shape[0], row+40), max(0, col-40), min(shape[1], col+40)
        rr, cc = np.indices((r1-r0, c1-c0))
        checker = np.where(((rr//4 + cc//4) % 2)[..., None], 200, 120).repeat(3, axis=2).astype('uint8')
        ndvi_color = np.moveaxis(rgba[:3, r0:r1, c0:c1], 0, -1).copy()
        ok = valid[r0:r1, c0:c1]
        ndvi_color[~ok] = checker[~ok]
        layers = [tci[r0:r1, c0:c1], ndvi_color, scl_palette[scl[r0:r1, c0:c1]], palette[reasons[r0:r1, c0:c1]]]
        for j, layer in enumerate(layers):
            canvas.paste(Image.fromarray(layer).resize((200, 200), Image.NEAREST), (j*256+5, i*215+25))
        draw.text((1030, i*215+28), f'{name}\nrow={row} col={col}\nSCL={scl[row,col]}\nreason={reasons[row,col]}', fill='black')
        sample_records.append({'label': name, 'row': row, 'col': col, 'center_scl': int(scl[row,col]),
                               'center_reason': int(reasons[row,col]), 'window': [r0, r1, c0, c1]})
    leg = json.loads((release / 'legend.json').read_text())
    for i, item in enumerate(leg['classes']):
        left = i*145
        draw.rectangle((left, canvas.height-55, left+140, canvas.height-35), fill=item['color'])
        draw.text((left+2, canvas.height-30), f"[{item['min']}, {item['max']}{']' if i==6 else ')'}", fill='black')
    canvas.save(output / 'aligned-samples.png')
    result = {'release': str(release), 'manifest_sha256': digest(release/'manifest.json'),
              'checks': 'all input/asset hashes, grids, exact TCI, independent nearest SCL and valid mask, reason counts, nodata/alpha invariants and JP2 error claim',
              'ndvi_max_absolute_error': max_error, 'coverage': coverage, 'circles': circles,
              'circle_method': 'EPSG:32646 Euclidean radius; native pixel centers; full circle denominator; source footprint from STAC, not source data validity',
              'visual_samples': sample_records, 'visual_warning': 'Same-source diagnostic; not independent SCL validation',
              'review_script_sha256': digest(Path(__file__))}
    (output / 'review.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False)+'\n')
    print(json.dumps({'evidence': str(output / 'review.json'), 'circles': circles}, ensure_ascii=False))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--release', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    review(args.release, args.output)
