"""Loopback-only, read-only HTTP server for the isolated grocery experiment."""
import argparse
import json
import mimetypes
import pathlib
import re
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from geo import bounds, circle, distance, overlaps

ROOT = pathlib.Path(__file__).resolve().parent
NOTICE = ('Данные OSM: полнота и актуальность неизвестны. Число найденных элементов '
          'не означает число всех работающих магазинов. Ноль результатов означает '
          'только отсутствие найденных объектов в выбранном снимке.')


def normalize(text):
    text = unicodedata.normalize('NFKC',text).lower().replace('ё','е')
    return re.findall(r'[\w]+',text)


class Snapshot:
    def __init__(self, path):
        self.data = json.loads(path.read_text())
        self.addresses = {r['id']:r for r in self.data['addresses']}
        self.search_rows = [(r,normalize(r['label'])) for r in self.data['addresses']]
        self.food = [(f,bounds(f['geometry'])) for f in self.data['food']]

    def search(self, query):
        terms = normalize(query)
        # This is a search context only; never overwrite an original settlement.
        terms = [t for t in terms if t not in ('красноярск','ул','улица','г')]
        if not terms:
            return []
        def match(term,words):
            return term in words if term.isdigit() else any(w.startswith(term) for w in words)
        found = [r for r,words in self.search_rows if all(match(t,words) for t in terms)]
        return sorted(found,key=lambda r:(r['label'],r['id']))[:20]

    def analyze(self, address_id, radius):
        address = self.addresses[address_id]
        origin = address['point']
        area = circle(origin,radius)
        bb = bounds(area)
        # Conservative prefilter (the exact test below uses the metric geometry).
        bb = [bb[0]-.00002,bb[1]-.00002,bb[2]+.00002,bb[3]+.00002]
        selected = []
        for row, box in self.food:
            if not overlaps(box,bb):
                continue
            metres = distance(origin,row['geometry'])
            if metres > radius:
                continue
            raw = row['properties']; tags = raw['tags']
            street = tags.get('addr:street') or tags.get('addr:place')
            text_address = f"{street}, {tags['addr:housenumber']}" if street and tags.get('addr:housenumber') else None
            props = {'id':raw['id'],'name':tags.get('name'),'shop':tags['shop'],
                     'address':text_address,'version':raw['version'],'edited_at':raw['edited_at'],
                     'distance_m':metres,'geometry_type':row['geometry']['type'],
                     'point':raw['point'],'bounds':box,
                     'source_url':'https://www.openstreetmap.org/'+raw['id'],
                     'version_url':'https://www.openstreetmap.org/'+raw['id']+'/history/'+str(raw['version'])}
            selected.append({'type':'Feature','id':raw['id'],'properties':props,'geometry':row['geometry']})
        selected.sort(key=lambda f:(f['properties']['distance_m'],f['id']))
        for i,f in enumerate(selected,1):
            f['properties']['ordinal'] = i
        return {'address':address,'radius_m':radius,'notice':NOTICE,
                'collection':{'type':'FeatureCollection','features':selected},
                'area':{'type':'Feature','properties':{},'geometry':area},'view_bounds':bounds(area)}

    def compare(self, left, right, radius):
        if radius not in (300,500):
            raise ValueError('Допустим только общий радиус 300 или 500 м')
        if left not in self.addresses or right not in self.addresses:
            raise ValueError('Выберите два адресных объекта из локального списка')
        return {'left':self.analyze(left,radius),'right':self.analyze(right,radius),
                'snapshot':self.data['metadata']['osm_base_timestamp'],'radius_m':radius}


def handler_for(snapshot):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query,keep_blank_values=True)
            def one(key,default=''):
                values = query.get(key,[default])
                if len(values)!=1:
                    raise ValueError('Повтор параметра '+key)
                return values[0]
            try:
                if parsed.path=='/api/meta':
                    m = snapshot.data['metadata']
                    return self.send_json({'snapshot':m['osm_base_timestamp'],'notice':NOTICE,
                        'counts':m['counts'],'metric':m['metric'],'freshness':m['freshness'],
                        'pbf_sha256':m['pbf_sha256'],'relation_failures':len(m['relation_failures'])})
                if parsed.path=='/api/search':
                    return self.send_json({'items':snapshot.search(one('q')[:160])})
                if parsed.path=='/api/compare':
                    return self.send_json(snapshot.compare(one('left'),one('right'),int(one('radius_m','500'))))
                if parsed.path=='/api/roads':
                    return self.send_json({'type':'FeatureCollection','features':snapshot.data['roads']})
                static = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'}
                if parsed.path in static:
                    path = ROOT/static[parsed.path]
                elif parsed.path.startswith('/vendor/') and parsed.path.count('/')==2:
                    path = ROOT/'.runtime/vendor'/parsed.path.removeprefix('/vendor/')
                else:
                    return self.send_json({'message':'Не найдено'},404)
                if not path.is_file():
                    return self.send_json({'message':'Нет локального файла: '+path.name},404)
                self.send_bytes(path.read_bytes(),mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
            except (ValueError,KeyError) as exc:
                self.send_json({'message':str(exc)},400)

        def send_json(self,value,status=200):
            self.send_bytes(json.dumps(value,ensure_ascii=False,allow_nan=False).encode(),'application/json; charset=utf-8',status)

        def send_bytes(self,body,content_type,status=200):
            self.send_response(status)
            self.send_header('Content-Type',content_type)
            self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)
    return Handler


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--dataset',type=pathlib.Path,default=ROOT/'.runtime/data/dataset.json')
    args = parser.parse_args()
    snapshot = Snapshot(args.dataset)
    print(f'Isolated PoC: http://127.0.0.1:{args.port} (no DB; Ctrl+C to stop)',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),handler_for(snapshot)).serve_forever()
