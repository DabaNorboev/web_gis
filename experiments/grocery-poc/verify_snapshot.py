"""Reproduce the small real-address check and write PoC-only verification files."""
import json
import math

from geo import R, distance, intersects_rect
from server import ROOT, Snapshot

CASES = [
    ('Ленина 102','way/71888335'),
    ('Молокова 28','way/177078022'),
    ('Славы 12','way/223499926'),
    ('Шинная 36','way/206140286'),
    ('Борисевича 22','node/2332693473'),
    ('Свердловская 61Г','way/170583063'),
    ('Пограничников 115/1','way/1526637784'),
]
ZONES = [('C',92.860885,56.013183),('R',92.908736,56.044687),
         ('O',92.921873,56.111938),('I',93.044626,56.005267)]


def haversine(a,b):
    lon,lat = map(math.radians,a)
    x,y = map(math.radians,b)
    h = math.sin((lat-y)/2)**2 + math.cos(lat)*math.cos(y)*math.sin((lon-x)/2)**2
    return 2*R*math.asin(min(1,math.sqrt(h)))


def verify():
    snapshot = Snapshot(ROOT/'.runtime/data/dataset.json')
    cases, results = [], []
    for query, source_id in CASES:
        address = snapshot.addresses[source_id]
        case = {'query':query,'id':source_id,'label':address['label'],'point':address['point']}
        if source_id=='way/170583063':
            case['duplicate_ids'] = ['node/1817554654','way/170583063']
        if source_id=='way/1526637784':
            case['empty'] = True
        cases.append(case)
        by_radius = {}
        for radius in (300,500):
            result = snapshot.analyze(source_id,radius)
            features = result['collection']['features']
            ids = {f['id'] for f in features}
            # Check the bbox prefilter against an unfiltered geometry calculation.
            unfiltered = {f['properties']['id'] for f,_ in snapshot.food if distance(address['point'],f['geometry'])<=radius}
            assert ids==unfiltered,(source_id,radius,'prefilter omitted elements')
            for f in features:
                if f['geometry']['type']=='Point':
                    reference = haversine(address['point'],f['geometry']['coordinates'])
                    assert abs(reference-f['properties']['distance_m'])<1e-5
            if case.get('duplicate_ids'):
                assert set(case['duplicate_ids'])<=ids
            if case.get('empty'):
                assert not ids
            by_radius[str(radius)] = {'count':len(features),'ids':sorted(ids)}
        assert set(by_radius['300']['ids'])<=set(by_radius['500']['ids'])
        results.append({'address':address, 'radii':by_radius})
    windows = {}
    for z,x,y in ZONES:
        rect = [x-.008,y-.005,x+.008,y+.005]
        windows[z] = {
            'point_count':sum(rect[0]<=f['properties']['point'][0]<=rect[2] and rect[1]<=f['properties']['point'][1]<=rect[3] for f,_ in snapshot.food),
            'geometry_intersection_count':sum(intersects_rect(f['geometry'],rect) for f,_ in snapshot.food)}
    assert [windows[z]['point_count'] for z in 'CROI']==[11,13,8,3]
    # Verify the documented worst-case circle bbox is within the selection bbox
    # for every selectable address. Conservative spherical angular bound.
    w,s,e,n = snapshot.data['metadata']['selection_bbox']
    delta = math.degrees(500/R)
    for a in snapshot.addresses.values():
        x,y = a['point']
        dx = delta/math.cos(math.radians(abs(y)+delta))
        assert w < x-dx < x+dx < e and s < y-delta < y+delta < n
    output = {'cases':results,'audit_windows':windows,'all_address_radius_bboxes_within_selection':True,
              'address_count':len(snapshot.addresses),'prefilter_matches_unfiltered':True,
              'selected_point_distances_match_independent_haversine':True}
    (ROOT/'.runtime/cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2)+'\n')
    (ROOT/'.runtime/snapshot-checks.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'cases':len(cases),'radii':[300,500],'audit_windows':windows,
                      'all_address_radius_bboxes_within_selection':True},ensure_ascii=False))


if __name__=='__main__':
    verify()
