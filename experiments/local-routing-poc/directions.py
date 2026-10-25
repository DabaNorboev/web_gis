"""Check OSRM car annotation node order against complete original OSM ways."""
import collections
import json

from run import OUT

source = json.loads((OUT / 'prepared/context.json').read_text())
edges = collections.defaultdict(list)
for way in source['ways']:
    tags = way['tags']
    if 'highway' not in tags:
        continue
    oneway = tags.get('oneway:motorcar', tags.get('oneway:motor_vehicle', tags.get('oneway', 'yes' if tags.get('junction') == 'roundabout' else 'no')))
    for a, b in zip(way['nodes'], way['nodes'][1:]):
        edges[a, b].append((way['id'], oneway not in ['-1', 'reverse'], tags))
        edges[b, a].append((way['id'], oneway not in ['yes', '1', 'true'], tags))


def review(response):
    body = response.get('body') or {}
    if body.get('code') != 'Ok':
        return None
    nodes = body['routes'][0]['legs'][0]['annotation']['nodes']
    missing, forbidden, conditional = [], [], []
    for a, b in zip(nodes, nodes[1:]):
        if a == b:
            continue
        entries = edges.get((a, b), [])
        if not entries:
            missing.append([a, b])
        elif not any(e[1] for e in entries):
            forbidden.append([a, b, [e[0] for e in entries]])
        for way_id, allowed, tags in entries:
            if any('conditional' in key for key in tags):
                conditional.append(way_id)
    return {'pairs': len(nodes) - 1, 'missing_source_edges': missing,
            'wrong_direction_edges': forbidden, 'conditional_ways': sorted(set(conditional)),
            'scope': 'OSM internal annotation edges only; not proof of turns, parking or uncomputed endpoint connectors.'}


raw = json.loads((OUT / 'osrm-driving-responses.json').read_text())
result = {key: review(value) for key, value in raw['routes'].items()}
result.update({f"matrix-{r['source']}-{r['target']}": review(r['response']) for r in raw['matrix_pairs']})
(OUT / 'osrm-driving-direction-audit.json').write_text(json.dumps(result, indent=2) + '\n')
print('Direction checks:', len(result), 'records;', sum(r['pairs'] for r in result.values() if r), 'source edges')
