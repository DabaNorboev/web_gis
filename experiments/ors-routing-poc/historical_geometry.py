"""Small conservative geometry helpers. WGS84 -> UTM zone 46N, metres.

Transverse Mercator series through A^6, WGS84 a/f and UTM k0=.9996.
Only the frozen Krasnoyarsk bbox is supported by the experiment; not a GIS API.
Ambiguous or unsupported topology must never become a successful route.
"""
import math
from collections import defaultdict


def utm(p):
    lon, lat = map(math.radians, p)
    a, f, k = 6378137.0, 1 / 298.257223563, .9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    t, c = math.tan(lat) ** 2, ep2 * math.cos(lat) ** 2
    q = math.cos(lat) * (lon - math.radians(93))
    m = a * ((1-e2/4-3*e2**2/64-5*e2**3/256)*lat
             -(3*e2/8+3*e2**2/32+45*e2**3/1024)*math.sin(2*lat)
             +(15*e2**2/256+45*e2**3/1024)*math.sin(4*lat)
             -(35*e2**3/3072)*math.sin(6*lat))
    x = 500000 + k*n*(q+(1-t+c)*q**3/6+(5-18*t+t*t+72*c-58*ep2)*q**5/120)
    y = k*(m+n*math.tan(lat)*(q*q/2+(5-t+9*c+4*c*c)*q**4/24
                             +(61-58*t+t*t+600*c-330*ep2)*q**6/720))
    return x, y


def distance(a, b):
    return math.hypot(a[0]-b[0], a[1]-b[1])


def project(p, a, b):
    d = (b[0]-a[0], b[1]-a[1])
    denominator = d[0]**2 + d[1]**2
    t = 0 if denominator == 0 else max(0, min(1, ((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1])/denominator))
    q = (a[0]+t*d[0], a[1]+t*d[1])
    return distance(p, q), q


def cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def intersects(a, b, c, d, epsilon=1e-7):
    if max(a[0],b[0])+epsilon < min(c[0],d[0]) or max(c[0],d[0])+epsilon < min(a[0],b[0]):
        return False
    if max(a[1],b[1])+epsilon < min(c[1],d[1]) or max(c[1],d[1])+epsilon < min(a[1],b[1]):
        return False
    p, q, r, s = cross(a,b,c), cross(a,b,d), cross(c,d,a), cross(c,d,b)
    return p*q <= epsilon and r*s <= epsilon


def inside_ring(p, ring):
    inside = False
    for a, b in zip(ring, ring[1:]):
        if project(p,a,b)[0] < 1e-6:
            return False  # boundary separately tested by touches_polygon
        if (a[1] > p[1]) != (b[1] > p[1]):
            x = a[0]+(p[1]-a[1])*(b[0]-a[0])/(b[1]-a[1])
            if x > p[0]:
                inside = not inside
    return inside


def inside_polygon(p, rings):
    return inside_ring(p,rings[0]) and not any(inside_ring(p,r) for r in rings[1:])


def touches_polygon(a, b, rings):
    return inside_polygon(a,rings) or inside_polygon(b,rings) or any(
        intersects(a,b,c,d) for ring in rings for c,d in zip(ring,ring[1:]))


def polygons(geometry):
    if geometry['type'] == 'Polygon':
        return [[[utm(p) for p in ring] for ring in geometry['coordinates']]]
    if geometry['type'] == 'MultiPolygon':
        return [[[utm(p) for p in ring] for ring in poly] for poly in geometry['coordinates']]
    raise ValueError('Unsupported polygon geometry')


def bounds(points, margin=0):
    return (min(p[0] for p in points)-margin, min(p[1] for p in points)-margin,
            max(p[0] for p in points)+margin, max(p[1] for p in points)+margin)


class Index:
    def __init__(self, step=100):
        self.step = step
        self.cells = defaultdict(list)

    def cells_for(self, box):
        a,b,c,d = box
        for x in range(math.floor(a/self.step),math.floor(c/self.step)+1):
            for y in range(math.floor(b/self.step),math.floor(d/self.step)+1):
                yield x,y

    def add(self, key, box):
        for cell in self.cells_for(box):
            self.cells[cell].append(key)

    def query(self, box):
        return set(key for cell in self.cells_for(box) for key in self.cells.get(cell,()))


def decode_polyline(shape, precision=6):
    values, index, lat, lon = [], 0, 0, 0
    while index < len(shape):
        delta = []
        for _ in range(2):
            result = shift = 0
            while True:
                if index >= len(shape) or shift > 35:
                    raise ValueError('Invalid polyline')
                b = ord(shape[index])-63
                index += 1
                if not 0 <= b <= 63:
                    raise ValueError('Invalid polyline')
                result |= (b&31)<<shift
                shift += 5
                if b < 32:
                    break
            delta.append(-(result//2)-1 if result&1 else result//2)
        lat += delta[0]
        lon += delta[1]
        values.append([lon/10**precision,lat/10**precision])
    return values
