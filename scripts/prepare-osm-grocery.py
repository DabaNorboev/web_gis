"""Offline saved PBF to grocery nodes and complete source polygons.

Disk-backed relation/member staging, no polygon repair or clipping. Laravel
performs strict ring assembly and the exact boundary test.
"""
import argparse
import datetime
import importlib.util
import importlib.metadata
import json
import pathlib
import resource
import sqlite3
import time

import osmium

_spec = importlib.util.spec_from_file_location('linear_preparation', pathlib.Path(__file__).with_name('prepare-osm-linear.py'))
_common = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_common)
sha256, boundary_bbox = _common.sha256, _common.boundary_bbox
DATASET_KEY = 'grocery'
TAG_KEY = 'shop'
PRODUCER = pathlib.Path(__file__)
RULES = {'grocery': {'shop': ['supermarket', 'convenience']}}


def selected(tags):
    return any(tags.get(key) in values for rules in RULES.values() for key, values in rules.items())


def metadata(obj, kind):
    return {'type': kind, 'id': obj.id, 'version': obj.version,
            'timestamp': obj.timestamp.isoformat().replace('+00:00', 'Z'), 'tags': dict(obj.tags)}


class Relations(osmium.SimpleHandler):
    def __init__(self, db):
        super().__init__()
        self.db = db

    def relation(self, rel):
        if not selected(dict(rel.tags)):
            return
        row = metadata(rel, 'relation')
        row['members'] = [{'type': {'w': 'way', 'n': 'node', 'r': 'relation'}[m.type], 'ref': m.ref, 'role': m.role} for m in rel.members]
        self.db.execute('INSERT INTO relations VALUES (?,?)', (rel.id, json.dumps(row, ensure_ascii=False)))
        self.db.executemany('INSERT INTO members VALUES (?,?)', [(rel.id, m.ref) for m in rel.members if m.type == 'w'])


class Ways(osmium.SimpleHandler):
    def __init__(self, db):
        super().__init__()
        self.db = db
        self.required_ways = {row[0] for row in db.execute('SELECT DISTINCT way FROM members')}

    def node(self, node):
        if node.tags.get(TAG_KEY) in RULES[DATASET_KEY][TAG_KEY]:
            if not node.location.valid():
                raise ValueError(f'node/{node.id}: selected node has no location; publication refused')
            row = metadata(node, 'node')
            row.update(lon=node.lon, lat=node.lat)
            self.db.execute('INSERT INTO nodes VALUES (?,?,?,?,?)',
                            (node.id, node.lon, node.lat, json.dumps(row, ensure_ascii=False), 1))

    def way(self, way):
        chosen = way.tags.get(TAG_KEY) in RULES[DATASET_KEY][TAG_KEY]
        if not chosen and way.id not in self.required_ways:
            return
        if any(not n.location.valid() for n in way.nodes):
            raise ValueError(f'way/{way.id}: missing coordinates; no partial publication')
        points = [(n.lon, n.lat) for n in way.nodes]
        if not points:
            raise ValueError(f'way/{way.id}: empty geometry')
        row = metadata(way, 'way')
        row['nodes'] = [n.ref for n in way.nodes]
        row['geometry'] = [{'lon': lon, 'lat': lat} for lon, lat in points]
        self.db.execute('INSERT INTO ways VALUES (?,?,?,?,?,?,?)',
                        (way.id, int(chosen), min(p[0] for p in points), min(p[1] for p in points),
                         max(p[0] for p in points), max(p[1] for p in points), json.dumps(row, ensure_ascii=False, separators=(',', ':'))))


def envelope(bbox):
    w, s, e, n = bbox
    return {'type': 'Polygon', 'coordinates': [[[w,s],[e,s],[e,n],[w,n],[w,s]]]}


def audit_relations(db, bbox):
    """Every selected relation is emitted, proven outside, or a publication blocker."""
    outcomes, emitted = [], []
    w, s, e, n = bbox
    for (doc,) in db.execute('SELECT doc FROM relations ORDER BY id'):
        row = json.loads(doc)
        members = row['members']
        outcome = {'source_id': 'osm:relation:' + str(row['id'])}
        way_members = [m for m in members if m['type'] == 'way']
        ways = {m['ref']: db.execute('SELECT west,south,east,north,doc FROM ways WHERE id=?', (m['ref'],)).fetchone() for m in way_members}
        reason = None
        if not members:
            reason = 'no_members'
        elif any(m['type'] != 'way' for m in members):
            reason = 'unsupported_node_or_nested_member'
        elif any(value is None for value in ways.values()):
            reason = 'missing_way_member'
        if reason is None:
            bounds = [min(v[0] for v in ways.values()), min(v[1] for v in ways.values()),
                      max(v[2] for v in ways.values()), max(v[3] for v in ways.values())]
            if bounds[2] < w or bounds[0] > e or bounds[3] < s or bounds[1] > n:
                # All referenced coordinates are resolved, so their complete envelope is outside.
                outcomes.append(outcome | {'status': 'outside_extraction', 'reason': 'complete_members_bbox_disjoint', 'bounds': bounds})
                continue
            if row['tags'].get('type') != 'multipolygon':
                reason = 'unsupported_relation_type'
            elif any(m['role'] not in ('outer','inner') for m in members) or not any(m['role'] == 'outer' for m in members):
                reason = 'unsupported_or_missing_outer_role'
        if reason is not None:
            outcomes.append(outcome | {'status': 'rejected', 'reason': reason})
            continue
        for member in members:
            member['geometry'] = json.loads(ways[member['ref']][4])['geometry']
        outcomes.append(outcome | {'status': 'emitted'})
        emitted.append(row)
    return outcomes, emitted


def prepare(pbf, boundary, output, expected_checksum=None, source_url=None):
    started = time.monotonic()
    digest = sha256(pbf)
    if expected_checksum and expected_checksum != digest:
        raise ValueError('PBF checksum mismatch')
    bbox = boundary_bbox(json.loads(boundary.read_text()))
    with osmium.io.Reader(str(pbf), osmium.osm.NOTHING) as reader:
        timestamp = reader.header().get('osmosis_replication_timestamp') or None
    output.mkdir(parents=True, exist_ok=False)
    dbfile, index = output / 'members.sqlite', output / 'nodes.index'
    preparation = {'schema_version': 2, 'dataset_key': DATASET_KEY, 'categories': [DATASET_KEY],
                   'object_types': ['node', 'way', 'relation'],
                   'method': 'complete_source_members_bbox_v2',
                   'extraction_geometry': envelope(bbox),
                   'pbf_sha256': digest, 'boundary_sha256': sha256(boundary), 'bbox': bbox,
                   'osmium_version': importlib.metadata.version('osmium'), 'node_index': 'sparse_file_array',
                   'script_sha256': sha256(PRODUCER), 'common_script_sha256': sha256(pathlib.Path(_common.__file__)),
                   'rules': RULES}
    if DATASET_KEY != 'grocery':
        preparation['retail_script_sha256'] = sha256(pathlib.Path(__file__))
    counts = {'node': 0, 'way': 0, 'relation': 0}
    db = sqlite3.connect(dbfile)
    try:
        db.executescript('PRAGMA journal_mode=OFF; PRAGMA cache_size=-16384; '
                         'CREATE TABLE nodes(id INTEGER PRIMARY KEY,lon REAL,lat REAL,doc TEXT,chosen INTEGER); '
                         'CREATE TABLE relations(id INTEGER PRIMARY KEY,doc TEXT); '
                         'CREATE TABLE members(relation INTEGER,way INTEGER); CREATE INDEX member_way ON members(way); '
                         'CREATE INDEX member_relation ON members(relation); '
                         'CREATE TABLE ways(id INTEGER PRIMARY KEY,chosen INTEGER,west REAL,south REAL,east REAL,north REAL,doc TEXT);')
        Relations(db).apply_file(str(pbf))
        db.commit()
        print('Selected relation metadata staged; reading ways and coordinates.', flush=True)
        Ways(db).apply_file(str(pbf), locations=True, idx=f'sparse_file_array,{index}')
        db.commit()
        db.executescript('CREATE TABLE bounds AS SELECT m.relation,min(w.west) west,min(w.south) south,max(w.east) east,max(w.north) north FROM members m JOIN ways w ON m.way=w.id GROUP BY m.relation;')
        predicate = 'NOT(east<? OR west>? OR north<? OR south>?)'
        west, south, east, north = bbox
        bindings = (west, east, south, north)
        outcomes, emitted_relations = audit_relations(db, bbox)
        preparation['relation_audit'] = {'selected_count': len(outcomes), 'outcomes': outcomes}
        diagnostics = {'status': 'rejected' if any(r['status'] == 'rejected' for r in outcomes) else 'accounted',
                       'relation_audit': preparation['relation_audit']}
        (output / 'diagnostics.json').write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2) + '\n')
        if diagnostics['status'] == 'rejected':
            raise ValueError('Selected relations have unresolved geometry; publication refused; see diagnostics.json')
        preparation['emitted_counts'] = {
            'node': db.execute('SELECT count(*) FROM nodes WHERE lon>=? AND lon<=? AND lat>=? AND lat<=?', bindings).fetchone()[0],
            'way': db.execute('SELECT count(*) FROM ways WHERE chosen=1 AND ' + predicate, bindings).fetchone()[0],
            'relation': len(emitted_relations),
        }
        partial = output / (DATASET_KEY + '.json.partial')
        with partial.open('x') as stream:
            prefix = {'generator': 'PlaceLens offline ' + DATASET_KEY + ' preparation v2', 'osm3s': {'timestamp_osm_base': timestamp}, 'preparation': preparation}
            stream.write(json.dumps(prefix, ensure_ascii=False)[:-1] + ',"elements":[\n')

            def emit(row):
                if sum(counts.values()):
                    stream.write(',\n')
                stream.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')))
                counts[row['type']] += 1

            for (doc,) in db.execute('SELECT doc FROM nodes WHERE lon>=? AND lon<=? AND lat>=? AND lat<=? ORDER BY id', bindings):
                emit(json.loads(doc))
            for (doc,) in db.execute('SELECT doc FROM ways WHERE chosen=1 AND ' + predicate + ' ORDER BY id', bindings):
                emit(json.loads(doc))
            for row in emitted_relations:
                emit(row)
            if counts != preparation['emitted_counts']:
                raise ValueError('Prepared object counts do not reconcile; publication refused')
            if not sum(counts.values()):
                raise ValueError('No candidates; preparation refused')
            stream.write('\n]}\n')
        partial.rename(output / (DATASET_KEY + '.json'))
    finally:
        db.close()
        index.unlink(missing_ok=True)
        dbfile.unlink(missing_ok=True)
    manifest = {'status': 'prepared_not_imported', 'source_url': source_url, 'file': DATASET_KEY + '.json',
                'sha256': sha256(output / (DATASET_KEY + '.json')), 'bytes': (output / (DATASET_KEY + '.json')).stat().st_size,
                'osm_base_timestamp': timestamp, 'observed_at': None, 'counts': counts, 'preparation': preparation,
                'prepared_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'duration_seconds': round(time.monotonic() - started, 2),
                'peak_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf', type=pathlib.Path)
    parser.add_argument('boundary', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path)
    parser.add_argument('--expected-pbf-sha256')
    parser.add_argument('--source-url')
    args = parser.parse_args()
    print(json.dumps(prepare(args.pbf, args.boundary, args.output, args.expected_pbf_sha256, args.source_url), ensure_ascii=False, indent=2))
