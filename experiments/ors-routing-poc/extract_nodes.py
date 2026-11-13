"""Read retained pilot nodes using already installed pyosmium; no graph writes."""
import json
import osmium


class Nodes(osmium.SimpleHandler):
    def node(self, node):
        tags = dict(node.tags)
        if tags:
            print(json.dumps({'id': node.id, 'coordinate': [node.lon,node.lat], 'tags': tags},
                             ensure_ascii=False, separators=(',',':')))


Nodes().apply_file('/input/pilot.osm.pbf')
