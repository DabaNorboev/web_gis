#!/usr/bin/env python3
"""G1: isolated, interactive geocoder evaluation. Stdlib, no app/DB/.env access."""
import argparse
import contextlib
from collections import Counter
from datetime import datetime, timezone
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from evaluate import evaluate

ROOT = Path(__file__).resolve().parent
KEYS = {'dadata': 'DADATA_API_KEY', 'geoapify': 'GEOAPIFY_API_KEY', 'locationiq': 'LOCATIONIQ_API_KEY'}
# 200 requests reserved for conditions/reference discovery; no retries or redirects.
API_CAP = 400
BOX = '92.55,56.20,93.20,55.85'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_corpus(path):
    data = json.loads(Path(path).read_text())
    rows = data['addresses']
    counts = Counter(r['group'] for r in rows)
    assert 48 <= len(rows) <= 60 and len(counts) == 6
    assert all(8 <= n <= 10 for n in counts.values())
    assert len({r['id'] for r in rows}) == len(rows)
    assert len({r['query'] for r in rows}) == len(rows)
    for r in rows:
        assert r['reference']['source'] in data['sources']
        assert r['reference']['confidence'] in ('medium', 'low', 'high')
        # No distance evaluation without independent geometry and method.
        assert r['reference']['coordinate'] is None
    return data


def request_spec(provider, stage, query, selected=None):
    """Return URL, method, body, headers; called only in memory with owner keys."""
    key = os.environ[KEYS[provider]]
    if provider == 'dadata':
        body = {'query': query, 'count': 5, 'locations': [{'city': 'Красноярск'}], 'restrict_value': True}
        method = 'suggest'
        if stage == 'selected':
            body = {'query': selected['unrestricted_value'], 'count': 1}
        elif stage == 'reverse':
            method = 'geolocate'
            body = {'lon': query[0], 'lat': query[1], 'count': 5, 'radius_meters': 100}
        return (f'https://suggestions.dadata.ru/suggestions/api/4_1/rs/{method}/address',
                'POST', json.dumps(body).encode(), {'Authorization': 'Token ' + key})
    if provider == 'geoapify':
        method = 'autocomplete' if stage == 'autocomplete' else 'search'
        params = {'text': query, 'lang': 'ru', 'limit': 5, 'format': 'json',
                  'filter': 'countrycode:ru', 'bias': 'proximity:92.852,56.010', 'apiKey': key}
        if stage == 'reverse':
            method = 'reverse'
            params = {'lon': query[0], 'lat': query[1], 'lang': 'ru', 'format': 'json', 'apiKey': key}
        return ('https://api.geoapify.com/v1/geocode/' + method + '?' + urllib.parse.urlencode(params),
                'GET', None, {})
    method = 'autocomplete' if stage == 'autocomplete' else ('reverse' if stage == 'reverse' else 'search')
    host = 'api.locationiq.com' if method == 'autocomplete' else 'eu1.locationiq.com'
    params = {'key': key, 'q': query, 'format': 'json', 'limit': 5,
              'accept-language': 'ru', 'countrycodes': 'ru', 'addressdetails': 1,
              'viewbox': BOX, 'bounded': 0}
    if stage == 'reverse':
        params = {'key': key, 'lon': query[0], 'lat': query[1], 'format': 'json',
                  'accept-language': 'ru', 'addressdetails': 1}
    return (f'https://{host}/v1/{method}?' + urllib.parse.urlencode(params), 'GET', None, {})


def candidates(provider, payload):
    if provider == 'dadata':
        return payload.get('suggestions', [])
    if provider == 'geoapify':
        return payload.get('results', [])
    return payload if isinstance(payload, list) else [payload] if 'lat' in payload else []


def projection(provider, item):
    """Allowlist for terminal only. Provider fields preserve their own semantics."""
    if provider == 'dadata':
        d = item.get('data', {})
        return {'label': item.get('value'), 'id': d.get('fias_id'), 'lon': d.get('geo_lon'),
                'lat': d.get('geo_lat'), 'accuracy': d.get('qc_geo'), 'level': d.get('fias_level'),
                'street': d.get('street_with_type'), 'house': d.get('house'),
                'block_type': d.get('block_type'), 'block': d.get('block')}
    if provider == 'geoapify':
        return {k: item.get(k) for k in ('formatted', 'place_id', 'lon', 'lat', 'result_type', 'city',
                                        'rank', 'datasource', 'street', 'housenumber')}
    return {k: item.get(k) for k in ('display_name', 'place_id', 'osm_type', 'osm_id',
                                    'lon', 'lat', 'class', 'type', 'address', 'importance')}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Session:
    def __init__(self, ledger, output):
        self.ledger, self.output = ledger, output
        self.last_start = 0
        self.opener = urllib.request.build_opener(NoRedirect)

    def append(self, record):
        with self.output.open('a', encoding='utf-8') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
            f.flush()
            os.fsync(f.fileno())

    def fetch(self, provider, stage, query, case_id, selected=None):
        # Ledger has an exclusive process lock for the entire run. Reserve BEFORE network.
        self.ledger.seek(0)
        count = sum(1 for _ in self.ledger)
        if count >= API_CAP:
            raise RuntimeError('Shared API budget exhausted')
        time.sleep(max(0, 1.2 - (time.monotonic() - self.last_start)))
        self.ledger.write(json.dumps({'n': count + 1, 'provider': provider, 'stage': stage,
                                      'case': case_id, 'at': datetime.now(timezone.utc).isoformat()}) + '\n')
        self.ledger.flush()
        os.fsync(self.ledger.fileno())
        url, method, body, headers = request_spec(provider, stage, query, selected)
        headers.update({'Content-Type': 'application/json', 'Accept': 'application/json',
                        'User-Agent': 'PlaceLens-G1-interactive/1.0'})
        record = {'provider': provider, 'stage': stage, 'case': case_id, 'reservation': count + 1,
                  'at': datetime.now(timezone.utc).isoformat()}
        self.last_start = start = time.monotonic()
        result = []
        stop = False
        try:
            with self.opener.open(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=15) as response:
                record['http'] = response.status
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise ValueError('oversize')
                result = candidates(provider, json.loads(raw))
                record['result_count'] = len(result)
        except urllib.error.HTTPError as e:
            # Never log URL, body, exception text or headers that may echo a key.
            record['http'] = e.code
            record['error'] = 'http_error'
            stop = e.code != 404
            e.close()
        except Exception as e:
            record['error'] = 'transport_or_payload'
            record['error_class'] = type(e).__name__
            stop = True
        record['elapsed_ms'] = round((time.monotonic() - start) * 1000, 2)
        self.append(record)
        self.last_record = record
        print({k: v for k, v in record.items() if k != 'at'})
        if stop:
            raise RuntimeError('Stopped without retry; inspect status and quota before a new authorized run')
        for i, row in enumerate(result):
            text = json.dumps(projection(provider, row), ensure_ascii=False)
            for key_name in KEYS.values():
                if os.environ.get(key_name):
                    text = text.replace(os.environ[key_name], '[redacted]')
            print(i + 1, text)
        return result


def prompt(message, options):
    while True:
        value = input(message + ' [' + '/'.join(options) + ']: ').strip()
        if value in options:
            return value


def review(session, provider, stage, case_id, rows):
    # Only evaluator categories, never response fields or free text, are persisted.
    grade = prompt('Адрес: exact / partial / wrong / unknown', ['exact', 'partial', 'wrong', 'unknown'])
    rank = int(prompt('Номер правильного результата (0 = нет/неизвестно)', [str(i) for i in range(len(rows) + 1)]))
    ambiguity = prompt('Неоднозначность', ['yes', 'no', 'unknown'])
    position = prompt('Положение: не оценивать без независимой геометрии', ['unknown'])
    level = prompt('Заявленный уровень', ['house', 'nearby', 'street', 'settlement', 'missing', 'unknown'])
    session.append({'provider': provider, 'stage': stage, 'case': case_id, 'kind': 'review',
                    'address_grade': grade, 'ambiguous': ambiguity, 'position': position,
                    'correct_rank': rank or None,
                    'level': level, 'error_m': None, 'error_reason': 'no_independent_geometry',
                    'empty': not rows})


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--corpus', type=Path, default=ROOT / 'corpus.json')
    p.add_argument('--run', action='store_true', help='real interactive HTTP, requires all owner keys')
    p.add_argument('--out', type=Path)
    p.add_argument('--ledger', type=Path)
    p.add_argument('--keys-file', type=Path, help='owner-authorized KEY=VALUE file, never sourced as shell')
    p.add_argument('--providers', nargs='+', choices=list(KEYS), default=list(KEYS))
    p.add_argument('--collect', action='store_true', help='collect Geoapify/LocationIQ response data without request-response pairs; no automatic quality grades')
    p.add_argument('--continue-unattempted', action='store_true', help='skip ALL ledger reservations, including failed attempts; no retry')
    p.add_argument('--search-only', action='store_true', help='targeted full-address textual evaluation pass; consumes 48 calls/provider')
    args = p.parse_args()
    data = load_corpus(args.corpus)
    variants = sum(len(r['variants']) for r in data['addresses'])
    maximum = sum(len(data['addresses']) * (3 if n == 'dadata' else 2) + variants + len(data['reverse']) for n in args.providers)
    if args.search_only:
        if not args.collect:
            p.error('--search-only requires --collect')
        maximum = len(data['addresses']) * len(args.providers)
    attempted = set()
    if args.continue_unattempted:
        if not args.collect or args.ledger is None:
            p.error('--continue-unattempted requires --collect and the SAME shared --ledger')
        for line in args.ledger.read_text().splitlines():
            r = json.loads(line)
            attempted.add((r['provider'], r['stage'], r['case']))
        maximum -= sum(1 for provider, stage, case in attempted if provider in args.providers and (not args.search_only or stage == 'search'))
    print(json.dumps({'addresses': len(data['addresses']), 'groups': dict(Counter(r['group'] for r in data['addresses'])),
                      'variants': variants, 'reverse_points': len(data['reverse']), 'max_api_requests': maximum,
                      'api_cap': API_CAP, 'corpus_sha256': digest(args.corpus), 'mode': 'run' if args.run else 'offline_plan'}, ensure_ascii=False))
    if not args.run:
        return
    if args.keys_file:
        for line in args.keys_file.read_text().splitlines():
            name, sep, value = line.strip().partition('=')
            name = name.removeprefix('export ').strip()
            if sep and name in KEYS.values():
                os.environ[name] = value.strip().strip('\"\'')
    missing = [KEYS[name] for name in args.providers if not os.environ.get(KEYS[name])]
    if missing:
        p.error('Missing owner credentials: ' + ', '.join(missing))
    if args.collect and 'dadata' in args.providers:
        p.error('DaData automated collection prohibited; use interactive protocol with supplier permission')
    if not args.collect and (not sys.stdin.isatty() or not sys.stdout.isatty()):
        p.error('Run only in a private terminal without transcript/recording; no pipe automation')
    if args.out is None or args.ledger is None or maximum > API_CAP:
        p.error('Need a NEW --out directory and shared --ledger; plan must fit cap')
    if 'dadata' in args.providers:
        print('DaData: интерактивная проверка, не пакетная обработка; без письменного разъяснения поставщика допустимость исследования не установлена.')
        if prompt('Есть разрешение DaData на этот протокол и достаточная остаточная квота всех ключей?', ['yes', 'no']) != 'yes':
            return
    args.ledger.parent.mkdir(parents=True, exist_ok=True)
    with args.ledger.open('a+', encoding='utf-8') as ledger:
        fcntl.flock(ledger, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ledger.seek(0)
        if sum(1 for _ in ledger) + maximum > API_CAP:
            p.error('Shared remaining budget is smaller than complete plan; no requests sent')
        args.out.mkdir(parents=True, exist_ok=False)
        (args.out / 'manifest.json').write_text(json.dumps({'corpus_sha256': digest(args.corpus),
            'runner_sha256': digest(__file__), 'evaluation_sha256': digest(ROOT / 'evaluate.py'),
            'started_at': datetime.now(timezone.utc).isoformat(), 'providers': args.providers,
            'max_requests': maximum, 'search_only': args.search_only, 'raw_responses_stored': False}, indent=2) + '\n')
        # Freeze the small benchmark implementation, not application or keys.
        for filename in ('benchmark.py', 'evaluate.py'):
            (args.out / filename).write_bytes((ROOT / filename).read_bytes())
        session = Session(ledger, args.out / 'metrics.jsonl')
        if args.collect:
            return collect(session, data, args.providers, args.out, attempted, args.search_only)
        try:
            for case in data['addresses']:
                print('\n', case['id'], case['query'], json.dumps(case['reference'], ensure_ascii=False))
                # Rotate order by case; no parallel requests, no warmup quota hidden from totals.
                names = args.providers
                offset = int(case['id'][1:]) % 3
                for provider in names[offset:] + names[:offset]:
                    for stage, query in [('search', case['query']), ('autocomplete', case['prefix'])] + [('variant', v) for v in case['variants']]:
                        input(f'Enter: {provider} {stage}; Ctrl-C завершает без повторов ')
                        rows = session.fetch(provider, stage, query, case['id'])
                        review(session, provider, stage, case['id'], rows)
                        if stage == 'autocomplete' and rows:
                            choice = prompt('Явно выбрать номер (0 = пропустить)', [str(i) for i in range(len(rows) + 1)])
                            if choice != '0':
                                chosen = rows[int(choice) - 1]
                                if provider == 'dadata':
                                    final = session.fetch(provider, 'selected', None, case['id'], chosen)
                                else:
                                    final = [chosen]  # API already supplies selected coordinates; no fake details call.
                                    print('Окончательные поля выбранного снимка:', json.dumps(projection(provider, chosen), ensure_ascii=False))
                                review(session, provider, 'selected', case['id'], final)
            for point in data['reverse']:
                print(point)
                for provider in args.providers:
                    input(f'Enter: {provider} reverse ')
                    rows = session.fetch(provider, 'reverse', point['coordinate'], point['id'])
                    review(session, provider, 'reverse', point['id'], rows)
        except (RuntimeError, KeyboardInterrupt, EOFError):
            print('Stopped. Reservations/metrics saved; no raw responses. No automatic resume/retry.')
            return 2
    return 0


def collect(session, data, providers, out, attempted=(), search_only=False):
    """Permitted providers only. Persist unique response DATA, never pairs/queries.

    LocationIQ ToS permits response data forever, separately from pair caching.
    Quality evaluation is explicitly left unmeasured; final fields are already
    present in search/autocomplete data, not represented as another HTTP request.
    """
    saved = {p: {} for p in providers}
    consecutive_transport_errors = 0
    def fetch(provider, stage, query, case_id):
        nonlocal consecutive_transport_errors
        if (provider, stage, case_id) in attempted:
            return []
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                rows = session.fetch(provider, stage, query, case_id)
        except RuntimeError:
            last = getattr(session, 'last_record', {})
            if last.get('error') != 'transport_or_payload':
                raise
            consecutive_transport_errors += 1
            if consecutive_transport_errors >= 3:
                raise
            print(f'Transport/payload failure: {provider} {case_id} {stage}; no retry, proceeding to a different operation.', flush=True)
            return None
        consecutive_transport_errors = 0
        for row in rows:
            value = projection(provider, row)
            encoded = json.dumps(value, ensure_ascii=False, sort_keys=True)
            # Allowlisted response data must not echo owner credentials.
            if any(os.environ.get(k) and os.environ[k] in encoded for k in KEYS.values()):
                raise RuntimeError('Response echoed a credential; response not stored')
            saved[provider][encoded] = value
        return rows
    try:
        for i, case in enumerate(data['addresses']):
            names = providers[i % len(providers):] + providers[:i % len(providers)]
            for provider in names:
                operations = [('search', case['query'])] if search_only else [('search', case['query']), ('autocomplete', case['prefix'])] + [('variant', v) for v in case['variants']]
                for stage, query in operations:
                    rows = fetch(provider, stage, query, case['id'])
                    if rows is not None and (provider, stage, case['id']) not in attempted:
                        evaluation = evaluate(provider, rows, case)
                        evaluation['stage'] = stage
                        session.append(evaluation)
            if (i + 1) % 8 == 0:
                print(f'Completed address inputs: {i + 1}/48', flush=True)
        for point in ([] if search_only else data['reverse']):
            for provider in providers:
                fetch(provider, 'reverse', point['coordinate'], point['id'])
    except (RuntimeError, KeyboardInterrupt):
        print('Stopped without retries; safe metrics retained.', flush=True)
        return 2
    finally:
        for provider in providers:
            # No case IDs, query text, HTTP envelopes, method or request ordering.
            values = [saved[provider][k] for k in sorted(saved[provider])]
            (out / (provider + '-response-data.json')).write_text(json.dumps(values, ensure_ascii=False, indent=2) + '\n')
    print('Collection finished; quality grades require independent review.', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
