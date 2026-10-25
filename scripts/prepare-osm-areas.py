"""Offline PBF to complete source ways/relations for green areas and water.

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
RULES = {
    'green_areas': {'natural': ['wood', 'scrub', 'grassland', 'heath'],
                    'landuse': ['forest', 'grass', 'meadow', 'village_green', 'orchard'],
                    'leisure': ['park', 'garden']},
    'water': {'natural': ['water'], 'waterway': ['riverbank'], 'landuse': ['reservoir']},
}


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

    def way(self, way):
        tags = dict(way.tags)
        chosen = selected(tags)
        if not chosen and not self.db.execute('SELECT 1 FROM members WHERE way=? LIMIT 1', (way.id,)).fetchone():
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
    preparation = {'method': 'complete_source_members_aggregate_bbox_then_exact_polygon_in_postgis',
                   'pbf_sha256': digest, 'boundary_sha256': sha256(boundary), 'bbox': bbox,
                   'osmium_version': importlib.metadata.version('osmium'), 'node_index': 'sparse_file_array',
                   'script_sha256': sha256(pathlib.Path(__file__)), 'common_script_sha256': sha256(pathlib.Path(_common.__file__)),
                   'rules': RULES}
    counts = {'way': 0, 'relation': 0}
    db = sqlite3.connect(dbfile)
    try:
        db.executescript('PRAGMA journal_mode=OFF; PRAGMA cache_size=-16384; '
                         'CREATE TABLE relations(id INTEGER PRIMARY KEY,doc TEXT); '
                         'CREATE TABLE members(relation INTEGER,way INTEGER); CREATE INDEX member_way ON members(way); '
                         'CREATE INDEX member_relation ON members(relation); '
                         'CREATE TABLE ways(id INTEGER PRIMARY KEY,chosen INTEGER,west REAL,south REAL,east REAL,north REAL,doc TEXT);')
        Relations(db).apply_file(str(pbf))
        db.commit()
        print('Selected relation metadata staged; reading ways and coordinates.', flush=True)
        Ways(db).apply_file(str(pbf), locations=True, idx=f'sparse_file_array,{index}')
        db.commit()
        missing = db.execute('SELECT count(*) FROM members m LEFT JOIN ways w ON m.way=w.id WHERE w.id IS NULL').fetchone()[0]
        if missing:
            raise ValueError(f'{missing} selected relation members absent from PBF; preparation refused')
        db.executescript('CREATE TABLE bounds AS SELECT m.relation,min(w.west) west,min(w.south) south,max(w.east) east,max(w.north) north FROM members m JOIN ways w ON m.way=w.id GROUP BY m.relation;')
        # Aggregate bounds also keep polygons enclosing the bbox without a boundary node inside it.
        predicate = 'NOT(east<? OR west>? OR north<? OR south>?)'
        west, south, east, north = bbox
        bindings = (west, east, south, north)
        partial = output / 'areas.json.partial'
        with partial.open('x') as stream:
            prefix = {'generator': 'PlaceLens offline polygon member preparation', 'osm3s': {'timestamp_osm_base': timestamp}, 'preparation': preparation}
            stream.write(json.dumps(prefix, ensure_ascii=False)[:-1] + ',"elements":[\n')

            def emit(row):
                if sum(counts.values()):
                    stream.write(',\n')
                stream.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')))
                counts[row['type']] += 1

            for (doc,) in db.execute('SELECT doc FROM ways WHERE chosen=1 AND ' + predicate + ' ORDER BY id', bindings):
                emit(json.loads(doc))
            for (doc,) in db.execute('SELECT r.doc FROM relations r JOIN bounds b ON r.id=b.relation WHERE ' + predicate + ' ORDER BY r.id', bindings):
                row = json.loads(doc)
                for member in row['members']:
                    if member['type'] == 'way':
                        member['geometry'] = json.loads(db.execute('SELECT doc FROM ways WHERE id=?', (member['ref'],)).fetchone()[0])['geometry']
                emit(row)
            if not sum(counts.values()):
                raise ValueError('No candidates; preparation refused')
            stream.write('\n]}\n')
        partial.rename(output / 'areas.json')
    finally:
        db.close()
        index.unlink(missing_ok=True)
        dbfile.unlink(missing_ok=True)
    manifest = {'status': 'prepared_not_imported', 'source_url': source_url, 'file': 'areas.json',
                'sha256': sha256(output / 'areas.json'), 'bytes': (output / 'areas.json').stat().st_size,
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
