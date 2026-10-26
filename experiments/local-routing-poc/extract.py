"""Bounded offline extract; full ways and referenced nodes, no production DB."""
import hashlib
import json
import pathlib
import resource
import time

import osmium


def main():
    started = time.monotonic()
    root = pathlib.Path('/experiment')
    controls = json.loads((root / 'controls.json').read_text())
    pbf = pathlib.Path('/input/siberian-fed-district-261018.osm.pbf')
    out = pathlib.Path('/output')
    if (out / 'pilot.osm.pbf').exists():
        raise RuntimeError('Refusing to overwrite prepared input')
    digest = hashlib.sha256()
    with pbf.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    assert digest.hexdigest() == controls['pbf_sha256'], 'PBF hash mismatch'
    west, south, east, north = controls['pilot_bbox']
    ways, relations, refs, barriers = {}, [], set(), []

    class Select(osmium.SimpleHandler):
        def way(self, way):
            tags = dict(way.tags)
            if not any(k in tags for k in ['highway', 'building', 'barrier', 'railway']) and tags.get('natural') != 'water':
                return
            if any(not n.location.valid() for n in way.nodes):
                raise RuntimeError(f'Missing node in way/{way.id}')
            points = [(n.lon, n.lat) for n in way.nodes]
            if not points or max(p[0] for p in points) < west or min(p[0] for p in points) > east or max(p[1] for p in points) < south or min(p[1] for p in points) > north:
                return
            nodes = [n.ref for n in way.nodes]
            refs.update(nodes)
            ways[way.id] = {'id': way.id, 'version': way.version, 'tags': tags,
                            'nodes': nodes, 'coordinates': points}

        def relation(self, relation):
            if relation.tags.get('type') != 'restriction':
                return
            members = [(m.type, m.ref, m.role) for m in relation.members]
            if all(ref in ways for typ, ref, role in members if typ == 'w'):
                relations.append({'id': relation.id, 'version': relation.version,
                                  'tags': dict(relation.tags), 'members': members})
                refs.update(ref for typ, ref, role in members if typ == 'n')

    index = out / 'nodes.index'
    try:
        Select().apply_file(str(pbf), locations=True, idx=f'sparse_file_array,{index}')
    finally:
        index.unlink(missing_ok=True)
    print(f'Selected {len(ways)} full ways and {len(refs)} referenced nodes', flush=True)
    writer = osmium.SimpleWriter(str(out / 'pilot.osm.pbf'))
    missing = set(refs)

    class Nodes(osmium.SimpleHandler):
        def node(self, node):
            if node.id in refs:
                writer.add_node(node)
                missing.discard(node.id)
            if node.location.valid() and west <= node.lon <= east and south <= node.lat <= north and node.tags.get('barrier'):
                barriers.append({'id': node.id, 'coordinate': [node.lon, node.lat], 'tags': dict(node.tags)})

    try:
        Nodes().apply_file(str(pbf))
        if missing:
            raise RuntimeError(f'Missing {len(missing)} selected nodes')
        for way in ways.values():
            writer.add_way(osmium.osm.mutable.Way(id=way['id'], version=way['version'], tags=way['tags'], nodes=way['nodes']))
        for relation in relations:
            writer.add_relation(osmium.osm.mutable.Relation(**relation))
    finally:
        writer.close()
    context = {'ways': list(ways.values()), 'barrier_nodes': barriers,
               'limitations': ['Multipolygon-only obstacles not assembled; absence of a conflict is not field validation.',
                               'Restriction relations retained only when all member ways are included.']}
    (out / 'context.json').write_text(json.dumps(context, ensure_ascii=False, separators=(',', ':')) + '\n')
    manifest = {'pbf_input_sha256': digest.hexdigest(), 'extract_sha256': hashlib.sha256((out / 'pilot.osm.pbf').read_bytes()).hexdigest(),
                'context_sha256': hashlib.sha256((out / 'context.json').read_bytes()).hexdigest(),
                'ways': len(ways), 'nodes': len(refs), 'restrictions': len(relations),
                'seconds': time.monotonic() - started, 'peak_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                'cpu_seconds': resource.getrusage(resource.RUSAGE_SELF).ru_utime + resource.getrusage(resource.RUSAGE_SELF).ru_stime,
                'observed_at': None, 'bbox': controls['pilot_bbox']}
    (out / 'extract-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    main()
