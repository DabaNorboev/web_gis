"""Conservative source-model checks, independent of router-reported ETA.

No DB, application runtime, HTTP, or third-party Python packages are used here.
Source weak components are evidence about this extract, not real city access.
"""
from collections import Counter, defaultdict
import csv
import json
import math
from pathlib import Path
import resource

from historical_geometry import (Index, bounds, decode_polyline, distance, inside_polygon,
                      inside_ring, intersects, polygons, project, touches_polygon, utm)
from review_support import HERE, REPORT, GUARDS, read, write, digest


def access(tags, policy, node=False):
    if policy.get('mode') == 'driving':
        from review_ors import car_access
        return car_access(tags, policy, node)
    if any(k.endswith(':conditional') and (k.startswith('foot') or k.startswith('access')) for k in tags):
        return False,'CONDITIONAL_ACCESS_UNKNOWN'
    value = tags.get('foot',tags.get('access'))
    if value is not None and value not in policy['access_allow']:
        return False,'ACCESS_DENIED_OR_UNKNOWN'
    if tags.get('locked')=='yes':
        return False,'LOCKED_GATE'
    if tags.get('indoor')=='yes' or tags.get('highway') in ['corridor','elevator'] or tags.get('conveying') not in [None,'no']:
        return False,'INDOOR_OR_CONVEYING_UNKNOWN'
    if tags.get('oneway:foot') not in [None,'no']:
        # Direction is not guessed by the independent undirected model.
        return False,'PEDESTRIAN_DIRECTION_REVIEW'
    if node:
        barrier = tags.get('barrier')
        if barrier in [None,'no','kerb','bollard']:
            return True,None
        if barrier in ['gate','lift_gate','wicket_gate','entrance','door','kissing_gate','swing_gate','sliding_gate']:
            return (True,None) if value in policy['access_allow'] else (False,'GATE_ACCESS_UNKNOWN')
        return False,'BARRIER_NODE_UNKNOWN'
    highway = tags.get('highway')
    if highway in ['construction','proposed','motorway','motorway_link']:
        return False,'UNSUPPORTED_OR_FORBIDDEN_HIGHWAY'
    if highway not in policy['osm_default_allowed_classes']:
        sidewalk = any(tags.get(k) in ['yes','both','left','right'] for k in ['sidewalk','sidewalk:left','sidewalk:right'])
        if not (value in policy['access_allow'] and sidewalk):
            return False,'MAJOR_ROAD_PEDESTRIAN_ACCESS_UNKNOWN'
    return True,None


def preserve_unresolved(result, previous):
    """A new approximation may not silently clear an earlier unresolved check."""
    if previous and previous.get('status')=='UNKNOWN':
        reasons = list((previous.get('geometry_review') or {}).get('issues') or {})
        result['previous_unresolved_checks'] = reasons or ['PREVIOUS_UNKNOWN']
        if result['status']=='MODEL_GEOMETRY_CONSISTENT':
            result.update(status='INSUFFICIENT_DATA',distance_m=None,
                          reasons=['UNRESOLVED_PREVIOUS_REVIEW:'+r for r in result['previous_unresolved_checks']])
    return result


class Network:
    def __init__(self,source,out,policy):
        self.policy = policy
        context = read(source/REPORT/'prepared/context.json')
        self.ways = [w for w in context['ways'] if any(k in w['tags'] for k in ['highway','barrier','railway'])]
        self.source_limitations = context['limitations']
        del context
        self.nodes = {}
        for line in (out/'nodes.jsonl').open():
            n = json.loads(line)
            n['point'] = utm(n['coordinate'])
            self.nodes[n['id']] = n
        self.segments = []
        self.index = Index()
        self.node_index = Index()
        self.parent = {}
        self.highway_nodes = set()
        self.footway_nodes = set()
        self.allowed_nodes = set()
        self.segment_counts = Counter()
        self.highway_counts = Counter()
        for id,n in self.nodes.items():
            if any(k in n['tags'] for k in ['barrier','access','foot','railway']):
                self.node_index.add(id,bounds([n['point']]))
        for w in self.ways:
            tags = w['tags']
            if 'highway' in tags:
                self.highway_nodes.update(w['nodes'])
                self.highway_counts[tags['highway']] += 1
            if tags.get('highway') in ['footway','path','pedestrian','steps']:
                self.footway_nodes.update(w['nodes'])
            points = [utm(p) for p in w['coordinates']]
            for i,(a,b) in enumerate(zip(points,points[1:])):
                if distance(a,b)<1e-7:
                    continue
                u,v = w['nodes'][i:i+2]
                allowed,reason = access(tags,policy)
                if 'highway' in tags:
                    for id in [u,v]:
                        if id in self.nodes:
                            ok,why = access(self.nodes[id]['tags'],policy,node=True)
                            if not ok:
                                allowed,reason = False,why
                    self.segment_counts['ALLOWED_SOURCE_POLICY' if allowed else reason] += 1
                    if allowed:
                        self.join(u,v)
                        self.allowed_nodes.update([u,v])
                s = {'way':w['id'],'tags':tags,'a':a,'b':b,'u':u,'v':v,'allowed':allowed,'reason':reason}
                key = len(self.segments)
                self.segments.append(s)
                self.index.add(key,bounds([a,b],.3))

    def find(self,u):
        self.parent.setdefault(u,u)
        while self.parent[u]!=u:
            self.parent[u] = self.parent[self.parent[u]]
            u = self.parent[u]
        return u

    def join(self,u,v):
        a,b = self.find(u),self.find(v)
        if a!=b:
            self.parent[a] = b

    def near_segments(self,a,b,margin=.3):
        return [self.segments[k] for k in self.index.query(bounds([a,b],margin))]

    def candidates(self,p,radius):
        result = []
        for s in self.near_segments(p,p,radius):
            if 'highway' not in s['tags'] or not s['allowed']:
                continue
            gap,q = project(p,s['a'],s['b'])
            if gap<=radius:
                result.append({'gap':gap,'point':q,'way':s['way'],'u':s['u'],'v':s['v']})
        return sorted(result,key=lambda r:(r['gap'],r['way'],r['u'],r['v']))

    def matching(self,a,b):
        t = self.policy['source_tolerance_m']
        return [s for s in self.near_segments(a,b) if 'highway' in s['tags']
                and project(a,s['a'],s['b'])[0]<=t and project(b,s['a'],s['b'])[0]<=t]


class Obstacles:
    """Byte offsets + bbox index; original polygons are decoded only on demand."""
    def __init__(self,source):
        self.path = source/GUARDS/'obstacles.jsonl'
        self.index = Index(200)
        self.meta = {}
        with self.path.open('rb') as stream:
            while True:
                offset = stream.tell()
                line = stream.readline()
                if not line:
                    break
                obj = json.loads(line)
                points = []
                def flatten(items):
                    if isinstance(items[0],(int,float)):
                        points.append(items)
                    else:
                        for child in items:
                            flatten(child)
                flatten(obj['geometry']['coordinates'])
                x1,y1,x2,y2 = bounds(points)
                box = bounds([utm(p) for p in [(x1,y1),(x1,y2),(x2,y1),(x2,y2)]],5)
                self.meta[offset] = (obj['id'],obj['kind'])
                self.index.add(offset,box)

    def query(self,a,b):
        result = []
        with self.path.open('rb') as stream:
            for offset in self.index.query(bounds([a,b],.3)):
                stream.seek(offset)
                obj = json.loads(stream.readline())
                result.append((obj['id'],obj['kind'],polygons(obj['geometry'])))
        return result


def entrance_summary(network,obstacles,cases):
    entries = {id:n for id,n in network.nodes.items() if n['tags'].get('entrance') not in [None,'no']}
    totals = {'retained_entrance_nodes':len(entries),'shared_highway_node':len(entries.keys()&network.highway_nodes),
              'shared_footway_path_steps_pedestrian_node':len(entries.keys()&network.footway_nodes),
              'connected_to_source_policy_weak_graph':len(entries.keys()&network.allowed_nodes),
              'access_tag_values':dict(Counter(n['tags'].get('access','MISSING') for n in entries.values())),
              'foot_tag_values':dict(Counter(n['tags'].get('foot','MISSING') for n in entries.values()))}
    samples = []
    for case in cases:
        if case['id'] not in ['building_centre','edge_building']:
            continue
        p = utm(case['start']['coordinate'])
        containers = [(id,poly) for id,kind,parts in obstacles.query(p,p) if kind=='building'
                      for poly in parts if inside_polygon(p,poly)]
        candidates = []
        for id,n in entries.items():
            if distance(n['point'],p)>300:
                continue
            if any(any(project(n['point'],a,b)[0]<=.25 for ring in poly for a,b in zip(ring,ring[1:]))
                   for _,poly in containers):
                candidates.append({'osm_node_id':id,'entrance':n['tags']['entrance'],
                                   'access':n['tags'].get('access'),'foot':n['tags'].get('foot'),
                                   'shared_highway_node':id in network.highway_nodes,
                                   'source_policy_graph_node':id in network.allowed_nodes})
        samples.append({'case_id':case['id'],'containing_buildings':sorted(set(id for id,_ in containers)),
                        'entrance_candidates':sorted(candidates,key=lambda c:c['osm_node_id']),
                        'selected_entrance':None,'route_origin_replaced':False})
    return {'totals':totals,'building_cases':samples,
            'limitations':['Retained nodes only; standalone entrances omitted by old extractor.',
                           'Shared IDs / weak connectivity do not establish real public access.',
                           'Full source ways can extend beyond bbox. No field confirmation.']}


def inventory(source,out):
    policy = read(HERE/'policy.json')
    network = Network(source,out,policy)
    components = Counter(network.find(u) for u in network.allowed_nodes)
    obstacles = Obstacles(source)
    cases = read(HERE/'controls.json')['cases']
    diagnostic = read(HERE/'diagnostic-controls.json')
    isolated = {}
    for name in ['isolated_stairs','isolated_service']:
        id = int(diagnostic[name]['source'].split('/')[1])
        w = next(w for w in network.ways if w['id']==id)
        roots = {network.find(u) for u in w['nodes'] if u in network.allowed_nodes}
        isolated[name] = {'way':id,'source_nodes':len(w['nodes']),
                          'weak_component_sizes':sorted(components[r] for r in roots)}
    return {'highway_way_counts':dict(network.highway_counts),'edge_policy_counts':dict(network.segment_counts),
            'weak_components':len(components),'largest_component_node_counts':sorted(components.values(),reverse=True)[:10],
            'component_definition':'OSM node identity; conservative foot/access/gates; undirected, not native routing graph.',
            'isolated_controls':isolated,'entrances':entrance_summary(network,obstacles,cases),
            'source_limitations':network.source_limitations,'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}


class Reviewer:
    def __init__(self,source,out):
        self.policy = read(HERE/'policy.json')
        self.network = Network(source,out,self.policy)
        self.obstacles = Obstacles(source)
        guard = read(source/GUARDS/'guard-sources.json')
        self.service = polygons(guard['service_geometry'])
        self.bbox = read(HERE/'controls.json')['pilot_bbox']
        w,s,e,n = self.bbox
        self.box_ring = [utm(p) for p in [(w,s),(e,s),(e,n),(w,n),(w,s)]]

    def in_scope(self,points):
        margin = self.policy['boundary_margin_m']
        for p in points:
            if not inside_ring(p,self.box_ring) or min(project(p,a,b)[0] for a,b in zip(self.box_ring,self.box_ring[1:]))<margin:
                return False
            if not any(inside_polygon(p,poly) for poly in self.service):
                return False
        for a,b in zip(points,points[1:]):
            if any(intersects(a,b,c,d) for poly in self.service for ring in poly for c,d in zip(ring,ring[1:])):
                return False
        return True

    def node_issues(self,a,b):
        issues = []
        for id in self.network.node_index.query(bounds([a,b],.25)):
            node = self.network.nodes[id]
            if project(node['point'],a,b)[0] <= self.policy['source_tolerance_m']:
                ok,reason = access(node['tags'],self.policy,node=True)
                if not ok:
                    issues.append(reason+':node/'+str(id))
        return issues

    def conflicts(self,a,b,mapped=(),connector=False):
        issues = self.node_issues(a,b)
        tunnel = any(s['tags'].get('tunnel') in ['yes','building_passage'] for s in mapped)
        bridge = any(s['tags'].get('bridge') in ['yes','viaduct','boardwalk'] for s in mapped)
        for id,kind,parts in self.obstacles.query(a,b):
            if not any(touches_polygon(a,b,p) for p in parts):
                continue
            if not connector and ((kind=='water' and bridge) or (kind=='building' and (bridge or tunnel))):
                continue
            issues.append(('CONNECTOR_' if connector else 'ROUTE_')+kind.upper()+':'+id)
        for s in self.network.near_segments(a,b):
            tags = s['tags']
            if not intersects(a,b,s['a'],s['b']):
                continue
            barrier = tags.get('barrier')
            if barrier in ['wall','fence','retaining_wall']:
                gates = [self.network.nodes[id] for id in self.network.node_index.query(bounds([a,b],.25))
                         for node in [self.network.nodes[id]]
                         if node['tags'].get('barrier') and distance(node['point'],a)<distance(a,b)+1
                         and project(node['point'],a,b)[0]<=.25 and project(node['point'],s['a'],s['b'])[0]<=.25
                         and access(node['tags'],self.policy,node=True)[0]
                         and any(id in [edge['u'],edge['v']] for edge in mapped)]
                if not gates or connector:
                    issues.append('BARRIER_REVIEW:way/'+str(s['way']))
            if tags.get('railway') in ['rail','narrow_gauge']:
                separated = False
                for edge in mapped:
                    layer1,layer2 = tags.get('layer'),edge['tags'].get('layer')
                    if layer1 is not None and layer2 is not None:
                        try:
                            separated |= int(layer1)!=int(layer2) and (bridge or tunnel)
                        except ValueError:
                            pass
                crossing = any(node['tags'].get('railway') in ['crossing','level_crossing']
                               and project(node['point'],a,b)[0]<=.25 and project(node['point'],s['a'],s['b'])[0]<=.25
                               and any(id in [edge['u'],edge['v']] for edge in mapped)
                               and access(node['tags'],self.policy,node=True)[0]
                               for id in self.network.node_index.query(bounds([a,b],.25))
                               for node in [self.network.nodes[id]])
                if connector or not (separated or crossing):
                    issues.append('RAILWAY_LEVEL_OR_CROSSING_UNKNOWN:way/'+str(s['way']))
            if connector and 'highway' in tags and tags['highway'] not in ['footway','path','steps','pedestrian']:
                # Ignore touching the selected graph end, but never cross another carriageway.
                if project(b,s['a'],s['b'])[0]>.25 or project(a,s['a'],s['b'])[0]>.25:
                    issues.append('CONNECTOR_ROAD_SIDE_UNKNOWN:way/'+str(s['way']))
        return sorted(set(issues))

    def endpoint(self,p,actual,radius):
        for id,kind,parts in self.obstacles.query(p,p):
            if kind=='building' and any(inside_polygon(p,poly) for poly in parts):
                return 'NEEDS_REFINEMENT',['ORIGINAL_IN_BUILDING:'+id]
        candidates = self.network.candidates(p,radius)
        if not candidates:
            return 'INSUFFICIENT_DATA',['NO_SOURCE_POLICY_SNAP']
        near = [c for c in candidates if c['gap']<=candidates[0]['gap']+self.policy['ambiguity_band_m']]
        unique = []
        for c in near:
            if not any(distance(c['point'],q)<=self.policy['source_tolerance_m'] for q in unique):
                unique.append(c['point'])
        if len(unique)>1:
            return 'AMBIGUOUS_SNAP',['MULTIPLE_SOURCE_LOCATIONS_WITHIN_FROZEN_BAND']
        if actual is not None:
            if distance(p,actual)>radius:
                return 'NEEDS_REFINEMENT',['ACTUAL_ENDPOINT_OUTSIDE_RADIUS']
            if project(actual,candidates[0]['point'],candidates[0]['point'])[0]>self.policy['source_tolerance_m']:
                return 'INSUFFICIENT_DATA',['ENGINE_ENDPOINT_DIFFERS_FROM_SOURCE_CANDIDATE']
            if distance(p,actual)>1e-7:
                issues = self.conflicts(p,actual,connector=True)
                if issues:
                    return 'NEEDS_REFINEMENT',issues
        return None,[]

    def row(self,engine,row,case):
        a,b = utm(case['start']),utm(case['target'])
        result = {'id':row['id'],'diagnostic':row['diagnostic'],'status':'INSUFFICIENT_DATA','reasons':[],
                  'distance_m':None,'raw_distance_m':None,'raw_model_seconds':None,
                  'geometry_distance_m':None,'endpoint_gaps_m':None,'model_time_validated':False}
        if row.get('status')=='OUTSIDE_PILOT' or not all(self.in_scope([p]) for p in [a,b]):
            return result | {'status':'OUTSIDE_PILOT','reasons':['OUTSIDE_CONFIRMED_SCOPE']}
        body = row.get('body') or {}
        radius = self.policy['diagnostic_snap_limit_m'] if row['diagnostic'] else self.policy['snap_limit_m']
        error = body.get('code') if engine=='osrm' else body.get('error_code')
        if row.get('error_class') or row.get('http_status',0)>=500:
            return result | {'status':'UNAVAILABLE','reasons':['ROUTER_RESPONSE_UNAVAILABLE']}
        if error in ['NoSegment',171]:
            return result | {'status':'NEEDS_REFINEMENT','reasons':['NATIVE_NO_SNAP']}
        if error in ['NoRoute',442]:
            for p in [a,b]:
                status,reasons = self.endpoint(p,None,radius)
                if status:
                    return result | {'status':status,'reasons':reasons+['NATIVE_NO_PATH_WITH_UNCONFIRMED_END']}
            return result | {'status':'NO_PATH','reasons':['NATIVE_GRAPH_NO_PATH_WITH_SOURCE_CANDIDATES']}
        try:
            if engine=='osrm':
                route = body['routes'][0]
                coordinates = route['geometry']['coordinates']
                raw_length,seconds = route['distance'],route['duration']
            else:
                trip = body['trip']
                if trip.get('status')!=0 or len(trip['legs'])!=1:
                    raise ValueError('Invalid trip')
                coordinates = decode_polyline(trip['legs'][0]['shape'])
                raw_length,seconds = trip['summary']['length']*1000,trip['summary']['time']
            if len(coordinates)<2 or len(coordinates)>10000:
                raise ValueError('Invalid line size')
            if not all(len(p)==2 and all(isinstance(x,(int,float)) and math.isfinite(x) for x in p)
                       and self.bbox[0]<=p[0]<=self.bbox[2] and self.bbox[1]<=p[1]<=self.bbox[3] for p in coordinates):
                raise ValueError('Invalid coordinates')
            if not all(isinstance(x,(int,float)) and math.isfinite(x) and x>=0 for x in [raw_length,seconds]):
                raise ValueError('Invalid measures')
        except (KeyError,IndexError,TypeError,ValueError):
            return result | {'reasons':['NATIVE_RESPONSE_NO_VERIFIABLE_LINE']}
        points = [utm(p) for p in coordinates]
        length = sum(distance(p,q) for p,q in zip(points,points[1:]))
        result.update(raw_distance_m=raw_length,raw_model_seconds=seconds,geometry_distance_m=length,
                      endpoint_gaps_m=[distance(a,points[0]),distance(b,points[-1])],
                      length_difference_m=raw_length-length,
                      length_consistent=abs(raw_length-length)<=max(self.policy['length_absolute_tolerance_m'],length*self.policy['length_relative_tolerance']))
        if not self.in_scope(points):
            return result | {'status':'OUTSIDE_PILOT','reasons':['LINE_OUTSIDE_CONFIRMED_SCOPE']}
        endpoint_checks = []
        for label,original,actual in [('start',a,points[0]),('target',b,points[-1])]:
            status,reasons = self.endpoint(original,actual,radius)
            endpoint_checks.append({'endpoint':label,'status':status or 'SOURCE_CANDIDATE_CONSISTENT','reasons':reasons})
        result['endpoint_checks'] = endpoint_checks
        if length<.01 and distance(a,b)>.1:
            return result | {'status':'NEEDS_REFINEMENT','reasons':['DISTINCT_INPUTS_COLLAPSED_TO_ZERO_LINE']}
        issues,way_ids,unmatched = [],set(),0
        for p,q in zip(points,points[1:]):
            if distance(p,q)<1e-7:
                continue
            mapped = self.network.matching(p,q)
            if not mapped:
                unmatched += 1
                continue
            for edge in mapped:
                way_ids.add(edge['way'])
                if not edge['allowed']:
                    issues.append(edge['reason']+':way/'+str(edge['way']))
            issues.extend(self.conflicts(p,q,mapped))
        result.update(matched_source_way_ids=sorted(way_ids),unmatched_shape_segments=unmatched)
        if unmatched:
            issues.append('UNATTRIBUTED_GEOMETRY_SEGMENTS')
        if not result['length_consistent']:
            issues.append('LENGTH_MISMATCH')
        result['geometry_issues'] = sorted(set(issues))
        endpoint_statuses = {c['status'] for c in endpoint_checks}
        for status in ['NEEDS_REFINEMENT','AMBIGUOUS_SNAP','INSUFFICIENT_DATA']:
            if status in endpoint_statuses:
                return result | {'status':status,'reasons':sorted(set(issues)) + [
                    c['endpoint']+':'+r for c in endpoint_checks for r in c['reasons']]}
        if issues:
            return result | {'reasons':sorted(set(issues))}
        return result | {'status':'MODEL_GEOMETRY_CONSISTENT','distance_m':length,'reasons':[
            'SOURCE_MODEL_ONLY; OSM_DEFAULT_ACCESS_ASSUMPTIONS; NO_FIELD_OR_TIME_VALIDATION']}
