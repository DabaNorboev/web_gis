"""Small spherical AEQD model for this isolated experiment; no database access.

Input/output positions are lon, lat, EPSG:4326. Query distances use a local
azimuthal equidistant projection centred on the address, R=6371008.8 m.
Segments between projected vertices are straight. This is not a walking route,
an entrance distance, or an ellipsoidal PostGIS geography calculation.
"""
import math

R = 6371008.8


def project(point, origin):
    lon, lat = map(math.radians, point)
    lon0, lat0 = map(math.radians, origin)
    dl = lon - lon0
    cosine = math.sin(lat0)*math.sin(lat) + math.cos(lat0)*math.cos(lat)*math.cos(dl)
    c = math.acos(max(-1, min(1, cosine)))
    k = c/math.sin(c) if c > 1e-12 else 1
    return (R*k*math.cos(lat)*math.sin(dl),
            R*k*(math.cos(lat0)*math.sin(lat)-math.sin(lat0)*math.cos(lat)*math.cos(dl)))


def circle(origin, radius, steps=96):
    lon, lat = map(math.radians, origin)
    d = radius/R
    out = []
    for i in range(steps+1):
        angle = 2*math.pi*i/steps
        y = math.asin(math.sin(lat)*math.cos(d)+math.cos(lat)*math.sin(d)*math.cos(angle))
        x = lon+math.atan2(math.sin(angle)*math.sin(d)*math.cos(lat),
                           math.cos(d)-math.sin(lat)*math.sin(y))
        out.append([math.degrees(x), math.degrees(y)])
    return {'type': 'Polygon', 'coordinates': [out]}


def segment_distance(p, a, b):
    vx, vy = b[0]-a[0], b[1]-a[1]
    length = vx*vx+vy*vy
    t = max(0, min(1, ((p[0]-a[0])*vx+(p[1]-a[1])*vy)/length)) if length else 0
    return math.hypot(p[0]-a[0]-t*vx, p[1]-a[1]-t*vy)


def in_ring(point, ring):
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:]):
        if segment_distance(point, a, b) < 1e-10:
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            inside = not inside
    return inside


def polygons(geometry):
    if geometry['type'] == 'Polygon':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiPolygon':
        return geometry['coordinates']
    return []


def covers(point, geometry):
    return any(in_ring(point, rings[0]) and not any(in_ring(point, r) for r in rings[1:])
               for rings in polygons(geometry))


def positions(geometry):
    if geometry['type'] == 'Point':
        return [geometry['coordinates']]
    if geometry['type'] == 'LineString':
        return geometry['coordinates']
    return [p for poly in polygons(geometry) for ring in poly for p in ring]


def bounds(geometry):
    pts = positions(geometry)
    return [min(p[0] for p in pts), min(p[1] for p in pts),
            max(p[0] for p in pts), max(p[1] for p in pts)]


def overlaps(a, b):
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def representative(geometry):
    if geometry['type'] == 'Point':
        return geometry['coordinates']
    if geometry['type'] == 'LineString':
        return geometry['coordinates'][0]
    ring = polygons(geometry)[0][0]
    # Translate first to avoid cancellation at longitude ~93 degrees.
    ox, oy = ring[0]
    area = cx = cy = 0
    for a, b in zip(ring, ring[1:]):
        ax, ay, bx, by = a[0]-ox, a[1]-oy, b[0]-ox, b[1]-oy
        c = ax*by-bx*ay
        area += c
        cx += (ax+bx)*c
        cy += (ay+by)*c
    if area:
        point = [ox+cx/(3*area), oy+cy/(3*area)]
        if covers(point, geometry):
            return point
    return ring[0]


def distance(origin, geometry):
    if geometry['type'] == 'Point':
        return math.hypot(*project(geometry['coordinates'], origin))
    if geometry['type'] == 'LineString':
        paths = [geometry['coordinates']]
    else:
        paths = []
        for rings in polygons(geometry):
            projected = [[project(p, origin) for p in ring] for ring in rings]
            if in_ring((0, 0), projected[0]) and not any(in_ring((0, 0), r) for r in projected[1:]):
                return 0.0
            paths.extend(rings)
    return min(segment_distance((0, 0), project(a, origin), project(b, origin))
               for ring in paths for a, b in zip(ring, ring[1:]))


def intersects_rect(geometry, rect):
    if not overlaps(bounds(geometry), rect):
        return False
    w, s, e, n = rect
    if any(w <= x <= e and s <= y <= n for x, y in positions(geometry)):
        return True
    corners = [(w, s), (e, s), (e, n), (w, n), (w, s)]
    if polygons(geometry) and any(covers(p, geometry) for p in corners):
        return True
    paths = [geometry['coordinates']] if geometry['type'] == 'LineString' else [r for p in polygons(geometry) for r in p]
    def orient(a, b, c):
        return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    for path in paths:
        for a, b in zip(path, path[1:]):
            for c, d in zip(corners, corners[1:]):
                if orient(a,b,c)*orient(a,b,d) < 0 and orient(c,d,a)*orient(c,d,b) < 0:
                    return True
    return False
