#!/usr/bin/env python3
"""Validate an explicit small local release list and write a new A10 input index."""
import argparse
from datetime import date
import hashlib
import json
import math
import os
from pathlib import Path

import rasterio as rio

SPECS = {'true-color.tif': ('uint8', 3, 0), 'ndvi.tif': ('float32', 1, -9999),
         'ndvi-rgba.tif': ('uint8', 4, None), 'scl.tif': ('uint8', 1, 0),
         'exclusion-reason.tif': ('uint8', 1, None), 'geographic-mask.tif': ('uint8', 1, None),
         'usable-mask.tif': ('uint8', 1, None)}
REQUIRED = set(SPECS) | {'geographic-coverage.geojson', 'usable-coverage.geojson', 'scene.json', 'recipe.json', 'legend.json'}
VERSIONS = {'method_version': 'placelens-s2-date-v1', 'mask_version': 'scl456-dn-v1', 'legend_version': 'ndvi-fixed-v2'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def validate_release(path):
    require(path.is_file(), f'Missing manifest: {path}')
    m = json.loads(path.read_text())
    if m.get('schema_version') == 3:
        from satellite_city import validate_city_release
        return validate_city_release(path)
    require(m.get('schema_version') == 2 and m.get('status') == 'prepared_offline', 'Incomplete/unsupported release')
    require(all(m.get(k) == v for k, v in VERSIONS.items()), 'Incompatible method/mask/legend')
    require(date.fromisoformat(m['observation_date']).isoformat() == m['observation_date'] and
            m['acquired_at'][:10] == m['observation_date'], 'Observation identity')
    require(set(m['assets']) == REQUIRED, 'Incomplete asset list')
    for name, a in m['assets'].items():
        p = path.parent / name
        require(a['path'] == name and p.is_file(), f'Missing/misnamed asset: {name}')
        require(p.stat().st_size == a['bytes'] and sha256(p) == a['sha256'], f'Asset checksum: {name}')
    require(sha256(path.parent/'recipe.json') == m['recipe_sha256'], 'Recipe checksum')
    scene = json.loads((path.parent/'scene.json').read_text())
    require(scene['id'] == m['scene_id'] and scene['properties']['s2:product_uri'] == m['product_uri'] and
            scene['properties']['s2:processing_baseline'] == m['baseline'] and scene.get('geometry'), 'Scene identity/footprint')
    grid = m['grid']
    require(grid['crs'] == 'EPSG:32646' and grid['resolution_m'] == 10 and grid['scl_source_resolution_m'] == 20,
            'Unsupported release grid')
    for name, (dtype, count, nodata) in SPECS.items():
        with rio.open(path.parent/name) as src:
            a = m['assets'][name]
            require(str(src.crs) == grid['crs'] == a['crs'] and
                    list(src.transform)[:6] == grid['transform'] and
                    src.width == grid['width'] and src.height == grid['height'], 'Raster/manifest grid mismatch')
            require(src.count == count == a['bands'] and all(t == dtype for t in src.dtypes) and
                    a['dtype'] == dtype and src.nodata == nodata == a['nodata'], 'Raster encoding mismatch')
            require(list(src.bounds) == m['native_bounds'] and a['bounds'] == m['bounds'], 'Raster bounds mismatch')
    c = m['coverage']
    require(c['scope'] == 'prepared_window' and 'scene_fraction' not in c, 'Ambiguous coverage scope')
    total = c['total_pixels']
    require(total == grid['width'] * grid['height'] and
            0 < c['usable_pixels'] <= c['geographic_pixels'] <= total and
            sum(c['exclusive_reason_counts'].values()) == total and
            c['exclusive_reason_counts']['valid'] == c['usable_pixels'], 'Invalid coverage counts')
    for key, expected in [('geographic_fraction', c['geographic_pixels']/total), ('valid_fraction', c['usable_pixels']/total),
                          ('nodata_fraction', 1-c['geographic_pixels']/total),
                          ('masked_fraction', (c['geographic_pixels']-c['usable_pixels'])/total)]:
        require(math.isclose(c[key], expected, abs_tol=1e-12), 'Invalid coverage denominator')
    error = m['verification']['ndvi_max_absolute_error']
    require(m['verification']['jp2_checked_pixels_per_band'] == total and m['verification']['outputs_reopened'] is True and
            error is not None and math.isfinite(error) and 0 <= error <= 6e-8, 'Missing numerical verification')
    require(m['radiometry']['applied_scale'] == .0001 and m['radiometry']['applied_offset'] == 0 and
            m['mask']['accepted_scl'] == [4, 5, 6] and m['mask']['buffer'] is None, 'Incompatible preparation rules')
    legend = json.loads((path.parent/'legend.json').read_text())
    require(legend['version'] == VERSIONS['legend_version'], 'Legend content/version mismatch')
    return m, {'grid': grid, 'legend': legend, 'mask': m['mask'], 'radiometry': m['radiometry'],
               'bounds': m['bounds'], 'native_bounds': m['native_bounds']}


def build_index(manifests, output):
    require(not output.exists(), 'Index already exists; choose a new path')
    require(1 <= len(manifests) <= 6, 'Explicit list of at most six releases required')
    entries, reference, first = [], None, None
    for path in manifests:
        path = path.resolve()
        require(path.is_relative_to(output.parent.resolve()), 'Manifests must be inside the local index directory tree')
        m, signature = validate_release(path)
        require(m['schema_version'] == 3 or len(manifests) <= 3, 'Legacy set remains limited to three releases')
        require(reference is None or signature == reference, 'Incompatible release geometry or rules')
        reference = signature
        if first is None: first = m
        entries.append({'date': m['observation_date'],
                        **({'scene_ids': [s['scene_id'] for s in m['scenes']]} if m['schema_version'] == 3 else {'scene_id': m['scene_id']}), 'release_id': path.parent.name,
                        'manifest': os.path.relpath(path, output.parent), 'manifest_sha256': sha256(path),
                        **{k: m[k] for k in VERSIONS}})
    require(len({e['date'] for e in entries}) == len(entries) and len({tuple(e['scene_ids']) if 'scene_ids' in e else (e['scene_id'],) for e in entries}) == len(entries),
            'Duplicate date/scene')
    result = {'schema_version': 2 if first['schema_version'] == 3 else 1, 'status': 'validated_offline_set',
              'scope': first['coverage']['scope'], **{k: first[k] for k in VERSIONS}, 'grid': reference['grid'], 'native_bounds': reference['native_bounds'],
              'releases': sorted(entries, key=lambda e: e['date'])}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as f:
        json.dump(result, f, ensure_ascii=False, indent=2, allow_nan=False)
        f.write('\n')
    print(json.dumps({'index': str(output), 'dates': [e['date'] for e in result['releases']]}))
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', type=Path, action='append', required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    try:
        build_index(args.manifest, args.output)
    except (ValueError, KeyError, OSError) as error:
        p.exit(1, f'{error}\n')
