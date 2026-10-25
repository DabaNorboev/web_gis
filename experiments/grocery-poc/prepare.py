"""Read the saved PBF; create a NEW private PoC snapshot, never a DB import.

Uses the existing project ETL image/osmium and its disk-backed node index.
All referenced coordinates are resolved before geographic selection.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import resource
import time

import osmium

from geo import bounds, covers, in_ring, intersects_rect, overlaps, representative

SHOP = {'supermarket', 'convenience', 'grocery'}
AUDIT_WAYS = [152945810,156145449,158912284,193617310,317918293,318504845,
              689541521,689541591,689972456,693072305,999846717]
ZONES = [('C',92.860885,56.013183),('R',92.908736,56.044687),
         ('O',92.921873,56.111938),('I',93.044626,56.005267)]
EXPECTED_PBF = '25c716a36131aab2e99802feca29d44495b80303d37e1d46eddc2a36f211863e'


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(4*1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def meta(o, kind):
    return {'id': f'{kind}/{o.id}', 'version': o.version,
            'edited_at': o.timestamp.isoformat().replace('+00:00','Z'), 'tags':dict(o.tags)}


def feature(row, geometry):
    return {'type':'Feature','geometry':geometry,'properties':row}


def assemble(members, ways):
    """Join only by exact OSM node references, never by coordinate proximity."""
    by_role = {'outer':[], 'inner':[]}
    for member in members:
        if member['type'] != 'w' or member['role'] not in ('', 'outer', 'inner'):
            raise ValueError('unsupported relation member type/role')
        row = ways.get(member['ref'])
        if not row:
            raise ValueError('missing relation member')
        by_role[member['role'] or 'outer'].append(row)
    rings = {}
    for role, rows in by_role.items():
        pending = [(list(r['nodes']), list(r['geometry']['coordinates'][0] if r['geometry']['type']=='Polygon' else r['geometry']['coordinates'])) for r in rows]
        rings[role] = []
        while pending:
            ids, points = pending.pop(0)
            while ids[0] != ids[-1]:
                options = [(i, ns, ps) for i,(ns,ps) in enumerate(pending) if ids[-1] in (ns[0],ns[-1])]
                if len(options) != 1:
                    raise ValueError('unclosed or ambiguous relation ring')
                i, ns, ps = options[0]
                pending.pop(i)
                if ns[-1] == ids[-1]:
                    ns, ps = ns[::-1], ps[::-1]
                ids.extend(ns[1:]); points.extend(ps[1:])
            if len(set(ids[:-1])) < 3:
                raise ValueError('degenerate ring')
            rings[role].append(points)
    result = [[ring] for ring in rings['outer']]
    if not result:
        raise ValueError('no outer ring')
    for inner in rings['inner']:
        parents = [p for p in result if in_ring(inner[0],p[0])]
        if len(parents) != 1:
            raise ValueError('ambiguous hole')
        parents[0].append(inner)
    return {'type':'MultiPolygon','coordinates':result}


def prepare(pbf, boundary_file, output):
    started = time.monotonic()
    if sha(pbf) != EXPECTED_PBF:
        raise ValueError('This PoC expects the audited saved PBF checksum')
    doc = json.loads(boundary_file.read_text())
    boundary = doc['geometry'] if doc.get('type')=='Feature' else doc['features'][0]['geometry'] if doc.get('type')=='FeatureCollection' else doc
    w,s,e,n = bounds(boundary)
    selection = [w-.03,s-.02,e+.03,n+.02]
    output.mkdir(parents=True,exist_ok=False)
    relations = []
    class Relations(osmium.SimpleHandler):
        def relation(self, rel):
            if rel.tags.get('shop') not in SHOP:
                return
            row = meta(rel,'relation')
            row['members'] = [{'type':m.type,'ref':m.ref,'role':m.role} for m in rel.members]
            relations.append(row)
    print('Pass 1: shop relations',flush=True)
    Relations().apply_file(str(pbf))
    required = {m['ref'] for r in relations for m in r['members'] if m['type']=='w'}
    food, addresses, roads, audit, ways = [], [], [], {}, {}
    failures = []

    def keep_address(row, geometry):
        tags = row['tags']
        if not tags.get('addr:housenumber') or not (tags.get('addr:street') or tags.get('addr:place')):
            return
        point = representative(geometry)
        if not covers(point,boundary):
            return
        street = tags.get('addr:street') or tags.get('addr:place')
        label = f"{street}, {tags['addr:housenumber']}"
        if tags.get('addr:city'):
            label = tags['addr:city']+', '+label
        addresses.append({'id':row['id'],'label':label,'point':point,'city':tags.get('addr:city'),
                          'point_method':'source_node' if geometry['type']=='Point' else 'inside_centroid_or_boundary_vertex'})

    class Objects(osmium.SimpleHandler):
        def node(self, node):
            if not node.location.valid():
                return
            p = [node.lon,node.lat]
            if not (selection[0]<=p[0]<=selection[2] and selection[1]<=p[1]<=selection[3]):
                return
            tags = node.tags
            if tags.get('shop') not in SHOP and not tags.get('addr:housenumber'):
                return
            row = meta(node,'node'); geometry = {'type':'Point','coordinates':p}
            if tags.get('shop') in SHOP:
                food.append(feature(row,geometry))
            keep_address(row,geometry)

        def way(self, way):
            tags = way.tags
            shop = tags.get('shop') in SHOP
            address = bool(tags.get('addr:housenumber'))
            road = tags.get('highway') in {'motorway','trunk','primary','secondary','tertiary','residential','unclassified','living_street'}
            if not (shop or address or road or way.id in required or way.id in AUDIT_WAYS):
                return
            if any(not p.location.valid() for p in way.nodes):
                raise ValueError(f'way/{way.id}: incomplete coordinates; no snapshot published')
            points = [[p.lon,p.lat] for p in way.nodes]
            if len(points)<2:
                raise ValueError(f'way/{way.id}: empty geometry')
            geometry = {'type':'Polygon','coordinates':[points]} if len(points)>=4 and points[0]==points[-1] else {'type':'LineString','coordinates':points}
            relevant = overlaps(bounds(geometry),selection)
            if not (relevant or way.id in required or way.id in AUDIT_WAYS):
                return
            row = meta(way,'way')
            if way.id in required:
                ways[way.id] = {'nodes':[p.ref for p in way.nodes],'geometry':geometry}
            if way.id in AUDIT_WAYS:
                audit[str(way.id)] = {'id':row['id'],'name':tags.get('name'),'tags':dict(tags),
                    'vertices':len(points),'resolved_vertices':len(points),'bounds':bounds(geometry),
                    'point':representative(geometry),
                    'core_windows_intersected':[z for z,x,y in ZONES if intersects_rect(geometry,[x-.008,y-.005,x+.008,y+.005])],
                    'margin_windows_intersected':[z for z,x,y in ZONES if intersects_rect(geometry,[x-.025,y-.018,x+.025,y+.018])],
                    'selected_food':shop}
            if not relevant:
                return
            if shop:
                food.append(feature(row,geometry))
            if address:
                keep_address(row,geometry)
            if road:
                roads.append(feature({'id':row['id'],'name':tags.get('name'),'highway':tags.get('highway')},
                                     {'type':'LineString','coordinates':points}))

    index = output/'nodes.index'
    try:
        print('Pass 2: complete nodes/ways via disk-backed coordinate index',flush=True)
        Objects().apply_file(str(pbf),locations=True,idx=f'sparse_file_array,{index}')
        for row in relations:
            try:
                if row['tags'].get('type')!='multipolygon':
                    raise ValueError('only multipolygon shop relations supported')
                geometry = assemble(row['members'],ways)
                if overlaps(bounds(geometry),selection):
                    food.append(feature(row,geometry))
            except ValueError as exc:
                # Retain explicit evidence; unknown geometry cannot be assigned to a city.
                failures.append({'id':row['id'],'reason':str(exc),'members':row['members']})
    finally:
        index.unlink(missing_ok=True)
    if set(audit)!=set(map(str,AUDIT_WAYS)):
        raise ValueError('not all 11 audit ways recovered')
    with osmium.io.Reader(str(pbf),osmium.osm.NOTHING) as reader:
        timestamp = reader.header().get('osmosis_replication_timestamp')
    ids = [f['properties']['id'] for f in food]
    if len(ids)!=len(set(ids)):
        raise ValueError('duplicate source IDs')
    for f in food:
        f['properties']['point'] = representative(f['geometry'])
    metadata = {'source':'OpenStreetMap','license':'ODbL-1.0','pbf_sha256':EXPECTED_PBF,
                'boundary_sha256':sha(boundary_file),'osm_base_timestamp':timestamp,'observed_at':None,
                'freshness':'UNKNOWN','real_world_completeness':'UNKNOWN',
                'rules':{'shop':sorted(SHOP)},'selection_bbox':selection,
                'metric':'address-centred spherical AEQD, R=6371008.8 m; projected vertex segments',
                'relation_failures':failures,'shop_relations_in_entire_pbf':len(relations),
                'audit_ways':audit,'prepared_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'duration_s':round(time.monotonic()-started,2),
                'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                'counts':{'food_elements':len(food),'addresses':len(addresses),'roads':len(roads)}}
    dataset = {'metadata':metadata,'boundary':boundary,'addresses':addresses,'food':food,'roads':roads}
    (output/'dataset.json').write_text(json.dumps(dataset,ensure_ascii=False,separators=(',',':'))+'\n')
    (output/'manifest.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in metadata.items() if k!='audit_ways'},ensure_ascii=False,indent=2),flush=True)


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf',type=pathlib.Path)
    parser.add_argument('boundary',type=pathlib.Path)
    parser.add_argument('output',type=pathlib.Path)
    args = parser.parse_args()
    prepare(args.pbf,args.boundary,args.output)
