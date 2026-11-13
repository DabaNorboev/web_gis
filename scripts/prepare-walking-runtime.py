"""Freeze the reviewed ORS walking graph and source guards; offline, never overwrite."""
import argparse
import datetime
import hashlib
import json
import math
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION = 'ors-foot-20261026-v1'
IMAGE = 'heigit/openrouteservice@sha256:e63d4df17a8df5fa1c0432c27b0c361be33e6f21a7b28496e97b6434b5954ce1'
# Reviewed inputs, independent of mutable report manifests.
SOURCE_HASHES = {
    'context': 'a3d291e9a44891defbb2c3f88ea9e29b18f33bdea08b4f4b2b782a3163afc576',
    'extract': '7b6233984c6246db014fa8d85461d7a2f33405261410f040612e0380a1c1089d',
    'nodes': '3e1329e215b66f4d81bbf1d2ef11cae9d09cf8f78932f62a893dc3d5d3f7d714',
    'obstacles': '1f52bfab8011ee5105f95c01a8cb7ca961ea60d8ea6d9527be0e43758959a550',
    'sources': 'ee76358f3e9712c837ea6a08db1a3dd868197463ccfb29df841fbb614e278701',
}
GRAPH_HASHES = {
    'foot-walking/edges': 'feceb073670ba310e09e0da79f4937b2bd03b0d71331b490bb71b4787c7febc4',
    'foot-walking/geometry': 'a3194adb2dd3f748526ee89fef0ee6cecb7a07c0119c68ce743c5771bd11d8ac',
    'foot-walking/graph_build_info.yml': '19c79e1f3e8b34593e69da968951b4892bd102daa7823cd2a299d6781e71289d',
    'foot-walking/landmarks_pedestrian_ors_recommended': '78c6473fd5ff396135873e482e88c9cab9f45c2ff3659cb599c7c65101604406',
    'foot-walking/landmarks_pedestrian_ors_shortest': 'bcfb3a7276df9f027c96503a17941144a58c0b275b9c82c7315ae645252525ea',
    'foot-walking/location_index': '91d251f433f56fd10b037fdc2f51408363a12402757dd17e27e2af36251f138c',
    'foot-walking/nodes': 'e43c2cdc0a08cae89311a83ebe2095a15021223d3488caa69f6ef60050f52ef6',
    'foot-walking/properties': 'e2edc0a95d19feb7f7d66c5191090a51402df9f954d4186eedbabf97a2bb6cfa',
    'foot-walking/stamp.txt': '9022c2a8d4a67945c0732db1bb813985d9c59297a5847445aa3b1042beb9b771',
    'foot-walking/string_index_keys': 'f3f9d875153c89c01ac7d79edd38d8ea32080031b970dc33da1b94c62940327e',
    'foot-walking/string_index_vals': '5341650646f683863c97fbbdb9dfdf33ac242f8a14839cdd4b6b4a3ea185174a',
    'foot-walking/subnetwork_landmarks_pedestrian_ors_recommended': '32b4119404f361da9029fb54c1fc4d9df679529fb863a54ee09c42026b80bf6d',
    'foot-walking/subnetwork_landmarks_pedestrian_ors_shortest': '32b4119404f361da9029fb54c1fc4d9df679529fb863a54ee09c42026b80bf6d',
    'foot-walking/turn_costs': '42c01a63d8cfdcb4a8d331a262148cffb1141c5370242f510cdce32c2bd4e777',
}
CONFIG = '''server:
  port: 8082
  servlet:
    context-path: /ors
logging:
  file:
    name: /tmp/ors.log
  level:
    root: WARN
    org.heigit: WARN
ors:
  engine:
    init_threads: 1
    profile_default:
      graph_path: /tmp/graphs
      build:
        source_file: /data/source.osm.pbf
        elevation: false
    profiles:
      driving-car:
        enabled: false
      foot-walking:
        enabled: true
        build:
          elevation: false
          ext_storages:
            OsmId: {}
'''


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n')
    return digest(path)


def all_points(coordinates):
    if isinstance(coordinates[0], (int, float)):
        if len(coordinates) != 2 or not all(math.isfinite(v) for v in coordinates):
            raise ValueError('Invalid source coordinates')
        yield coordinates
    else:
        for child in coordinates:
            yield from all_points(child)


def prepare(report, source, guards, output, prepared_at):
    if output.exists():
        raise FileExistsError('Output must be absent')
    stamp = datetime.datetime.fromisoformat(prepared_at.replace('Z', '+00:00'))
    if stamp.utcoffset() != datetime.timedelta(0):
        raise ValueError('prepared-at must include UTC timezone')
    inputs = {'context': source / 'context.json', 'extract': source / 'pilot.osm.pbf',
              'nodes': report / 'nodes.jsonl', 'obstacles': guards / 'obstacles.jsonl', 'sources': guards / 'guard-sources.json'}
    for key, path in inputs.items():
        if path.is_symlink() or digest(path) != SOURCE_HASHES[key]:
            raise ValueError('Frozen source hash mismatch: ' + key)
    graph = report / 'walking/home/graphs'
    actual = {str(p.relative_to(graph)) for p in graph.rglob('*') if p.is_file()}
    if actual != set(GRAPH_HASHES):
        raise ValueError('Unexpected graph file set')
    for name, checksum in GRAPH_HASHES.items():
        if (graph / name).is_symlink() or digest(graph / name) != checksum:
            raise ValueError('Frozen graph hash mismatch: ' + name)
    context = json.loads(inputs['context'].read_text())
    sources = json.loads(inputs['sources'].read_text())
    if sources['export_sha256'] != SOURCE_HASHES['obstacles']:
        raise ValueError('Obstacle provenance mismatch')
    bbox, step, cells, node_positions = [92.7, 55.9, 93.2, 56.2], .005, {}, {}

    def node(node_id, position):
        if not isinstance(node_id, int) or node_id <= 0:
            raise ValueError('Invalid node ID')
        list(all_points(position))
        if node_id in node_positions and node_positions[node_id] != position:
            raise ValueError('Conflicting node coordinates')
        node_positions[node_id] = position

    def add(feature):
        points = list(all_points(feature['geometry']['coordinates']))
        bounds = [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]
        feature['bbox'] = bounds
        for x in range(math.floor(max(bounds[0], bbox[0]) / step), math.floor(min(bounds[2], bbox[2]) / step) + 1):
            for y in range(math.floor(max(bounds[1], bbox[1]) / step), math.floor(min(bounds[3], bbox[3]) / step) + 1):
                cells.setdefault(f'{x}-{y}', []).append(feature)

    ways = {}
    for way in context['ways']:
        if len(way['nodes']) != len(way['coordinates']) or len(way['nodes']) < 2:
            raise ValueError('Invalid source way')
        for node_id, position in zip(way['nodes'], way['coordinates']):
            node(node_id, position)
        if 'highway' in way['tags']:
            way_id = way['id']
            if not isinstance(way_id, int) or way_id <= 0 or way_id in ways:
                raise ValueError('Invalid or duplicate highway ID')
            ways[way_id] = {k: way[k] for k in ['id', 'nodes', 'coordinates', 'tags']}
        if any(k in way['tags'] for k in ['highway', 'barrier', 'railway']):
            add({'id': 'way/' + str(way['id']), 'kind': 'line', 'tags': way['tags'], 'nodes': way['nodes'],
                 'geometry': {'type': 'LineString', 'coordinates': way['coordinates']}})
    tagged = {}
    with inputs['nodes'].open() as stream:
        for line in stream:
            row = json.loads(line)
            node(row['id'], row['coordinate'])
            if row['id'] in tagged:
                raise ValueError('Duplicate tagged node ID')
            tagged[row['id']] = row
    for row in context['barrier_nodes']:
        node(row['id'], row['coordinate'])
        # The original context also retains standalone barriers omitted from
        # the graph extract. Keep their obstacle geometry without adding edges.
        if row['id'] in tagged and tagged[row['id']]['tags'] != row['tags']:
            raise ValueError('Tagged node provenance mismatch')
        tagged.setdefault(row['id'], row)
    for row in tagged.values():
        add({'id': 'node/' + str(row['id']), 'kind': 'node', 'tags': row['tags'],
             'geometry': {'type': 'Point', 'coordinates': row['coordinate']}})
    with inputs['obstacles'].open() as stream:
        for line in stream:
            add(json.loads(line))
    # No destination is created until every frozen input and node identity has passed.
    output.mkdir(parents=True, exist_ok=False)
    (output / 'graph/foot-walking').mkdir(parents=True)
    (output / 'ways').mkdir()
    (output / 'guards').mkdir()
    graph_hashes = {}
    for name, checksum in GRAPH_HASHES.items():
        shutil.copyfile(graph / name, output / 'graph' / name)
        if digest(output / 'graph' / name) != checksum:
            raise ValueError('Copied graph hash mismatch: ' + name)
        graph_hashes['graph/' + name] = checksum
    (output / 'graph.sha256').write_text(''.join(f'{h}  {name}\n' for name, h in sorted(graph_hashes.items())))
    shutil.copyfile(inputs['extract'], output / 'source.osm.pbf')
    if digest(output / 'source.osm.pbf') != SOURCE_HASHES['extract']:
        raise ValueError('Copied source hash mismatch')
    (output / 'ors-config.yml').write_text(CONFIG)
    way_hashes = {f'ways/{key}.json': write_json(output / f'ways/{key}.json', row) for key, row in sorted(ways.items())}
    guard_hashes = {f'guards/{key}.json': write_json(output / f'guards/{key}.json', rows) for key, rows in sorted(cells.items())}
    manifest = {'version': VERSION, 'engine': 'ORS', 'engine_version': '10.1.0', 'mode': 'walking', 'profile': 'foot-walking',
                'image': IMAGE, 'graph_hashes': graph_hashes, 'graph_list_sha256': digest(output / 'graph.sha256'),
                'config_sha256': digest(output / 'ors-config.yml'), 'source_hashes': SOURCE_HASHES,
                'pbf_sha256': '25c716a36131aab2e99802feca29d44495b80303d37e1d46eddc2a36f211863e',
                'extract_sha256': SOURCE_HASHES['extract'], 'observed_at': None, 'bbox': bbox,
                'boundary_margin_m': 1000, 'snap_limit_m': 20, 'source_precision_m': .25,
                'representation_tolerance_m': 1.25, 'guard_cell_degrees': step, 'guard_hashes': guard_hashes,
                'way_hashes': way_hashes, 'guard_sources': sources, 'prepared_at': prepared_at,
                'guard_method': 'source_obstacle_utm46_v1',
                'limitations': 'Street-only static walking model; no confirmed entrances, physical accessibility or field validation.'}
    checksum = write_json(output / 'manifest.json', manifest)
    (output / 'manifest.sha256').write_text(checksum + '\n')
    return {'manifest_sha256': checksum, 'graph_list_sha256': manifest['graph_list_sha256'],
            'ways': len(ways), 'cells': len(cells), 'tagged_nodes': len(tagged)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=pathlib.Path, default=ROOT / 'data/reports/ors-routing-poc-2026-10-26')
    parser.add_argument('--source', type=pathlib.Path, default=ROOT / 'data/reports/local-routing-2026-10-21/prepared')
    parser.add_argument('--guards', type=pathlib.Path, default=ROOT / 'data/reports/local-routing-integration-2026-10-21/guard-export')
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--prepared-at', required=True, help='Exact UTC release timestamp for byte-identical replay')
    args = parser.parse_args()
    print(json.dumps(prepare(args.report, args.source, args.guards, args.output, args.prepared_at)))
