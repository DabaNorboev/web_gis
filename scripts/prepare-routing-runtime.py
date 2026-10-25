"""Prepare immutable OSRM car graph and spatial guard tiles; no network or import."""
import argparse
import datetime
import hashlib
import json
import math
import pathlib
import shutil
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def all_points(coordinates):
    if isinstance(coordinates[0], (int, float)):
        yield coordinates
    else:
        for child in coordinates:
            yield from all_points(child)


def prepare(report, guards, output, prepared_at=None):
    started = time.monotonic()
    summary = json.loads((report / 'summary.json').read_text())
    if summary['decision']['driving'] != 'GO_LIMITED_OSRM_CAR_PILOT':
        raise ValueError('Explicit car Go required')
    sources = json.loads((guards / 'guard-sources.json').read_text())
    if digest(guards / 'obstacles.jsonl') != sources['export_sha256']:
        raise ValueError('Obstacle export hash mismatch')
    output.mkdir(parents=True, exist_ok=False)
    (output / 'graph').mkdir()
    (output / 'guards').mkdir()
    graph_hashes = {}
    for name, meta in summary['graphs']['osrm-driving']['files'].items():
        if not name.startswith('pilot.osrm'):
            continue
        original = report / 'osrm-driving' / name
        if digest(original) != meta['sha256']:
            raise ValueError('Prepared graph changed: ' + name)
        shutil.copyfile(original, output / 'graph' / name)
        graph_hashes['graph/' + name] = meta['sha256']
    (output / 'graph.sha256').write_text(''.join(f'{h}  {name}\n' for name, h in sorted(graph_hashes.items())))
    context = json.loads((report / 'prepared/context.json').read_text())
    extract = json.loads((report / 'prepared/extract-manifest.json').read_text())
    if digest(report / 'prepared/context.json') != extract['context_sha256']:
        raise ValueError('Context hash mismatch')
    bbox, step, tiles = [92.70, 55.90, 93.20, 56.20], .005, {}

    def add(feature):
        points = list(all_points(feature['geometry']['coordinates']))
        bounds = [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]
        feature['bbox'] = bounds
        for x in range(math.floor(max(bounds[0], bbox[0]) / step), math.floor(min(bounds[2], bbox[2]) / step) + 1):
            for y in range(math.floor(max(bounds[1], bbox[1]) / step), math.floor(min(bounds[3], bbox[3]) / step) + 1):
                tiles.setdefault(f'{x}-{y}', []).append(feature)

    for way in context['ways']:
        tags = way['tags']
        if not any(k in tags for k in ['highway', 'barrier', 'railway']):
            continue
        add({'id': 'way/' + str(way['id']), 'kind': 'line', 'tags': tags, 'nodes': way['nodes'],
             'geometry': {'type': 'LineString', 'coordinates': way['coordinates']}})
    for node in context['barrier_nodes']:
        add({'id': 'node/' + str(node['id']), 'kind': 'node', 'tags': node['tags'],
             'geometry': {'type': 'Point', 'coordinates': node['coordinate']}})
    with (guards / 'obstacles.jsonl').open() as stream:
        for line in stream:
            add(json.loads(line))
    tile_hashes = {}
    for key, features in sorted(tiles.items()):
        name = 'guards/' + key + '.json'
        (output / name).write_text(json.dumps(features, ensure_ascii=False, separators=(',', ':')) + '\n')
        tile_hashes[name] = digest(output / name)
    manifest = {'version': 'osrm-car-20261021-v1', 'engine': 'OSRM', 'engine_version': '5.27.1', 'mode': 'driving',
                'image': 'ghcr.io/project-osrm/osrm-backend@sha256:855614a38f464b0558a2ad6eaa7cb8c139f39887da9b38b485ce453c6e6e6124',
                'profile': '/opt/car.lua', 'algorithm': 'MLD', 'graph_hashes': graph_hashes,
                'pbf_sha256': extract['pbf_input_sha256'], 'extract_sha256': extract['extract_sha256'],
                'observed_at': None, 'bbox': bbox, 'boundary_margin_m': 1000, 'snap_limit_m': 35,
                'guard_cell_degrees': step, 'guard_hashes': tile_hashes, 'guard_sources': sources,
                'guard_method': 'source_obstacle_utm46_v1', 'prepared_at': prepared_at or datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'limitations': 'Static road graph. No live traffic, parking, waiting, timetables or confirmed entrances. Missing obstacles/access may remain.'}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    checksum = digest(output / 'manifest.json')
    (output / 'manifest.sha256').write_text(checksum + '\n')
    print(json.dumps({'manifest_sha256': checksum, 'tiles': len(tiles), 'seconds': time.monotonic() - started,
                      'bytes': sum(p.stat().st_size for p in output.rglob('*') if p.is_file())}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=pathlib.Path, default=ROOT / 'data/reports/local-routing-2026-10-21')
    parser.add_argument('--guards', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--prepared-at', help='Exact UTC release timestamp for byte-identical replay')
    args = parser.parse_args()
    if args.prepared_at:
        stamp = datetime.datetime.fromisoformat(args.prepared_at.replace('Z', '+00:00'))
        if stamp.utcoffset() != datetime.timedelta(0):
            parser.error('--prepared-at must include UTC timezone')
    prepare(args.report, args.guards, args.output, args.prepared_at)
