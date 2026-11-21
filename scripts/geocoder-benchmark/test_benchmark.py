"""Synthetic/offline regressions: no sockets, app, DB or real tokens."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


b = module('benchmark')
s = module('summarize')


class BenchmarkTest(unittest.TestCase):
    def test_corpus_and_request_budget(self):
        d = b.load_corpus(ROOT / 'corpus.json')
        self.assertEqual(len(d['addresses']), 48)
        self.assertEqual(sum(len(r['variants']) for r in d['addresses']), 12)
        self.assertEqual(48 * 7 + 12 * 3 + 4 * 3, 384)
        self.assertLessEqual(384, b.API_CAP)

    @patch.dict('os.environ', {k: 'synthetic-token' for k in b.KEYS.values()})
    def test_selected_dadata_uses_exact_selected_string(self):
        _, method, body, headers = b.request_spec('dadata', 'selected', None, {'unrestricted_value': 'fixture, 8а, корпус 1'})
        self.assertEqual(json.loads(body), {'query': 'fixture, 8а, корпус 1', 'count': 1})
        self.assertEqual(method, 'POST')
        self.assertIn('Authorization', headers)

    @patch.dict('os.environ', {k: 'synthetic-token' for k in b.KEYS.values()})
    def test_reverse_axis_order(self):
        for provider in b.KEYS:
            url, _, body, _ = b.request_spec(provider, 'reverse', [92.8, 56.0])
            if body:
                self.assertEqual((json.loads(body)['lon'], json.loads(body)['lat']), (92.8, 56.0))
            else:
                self.assertIn('lon=92.8', url)
                self.assertIn('lat=56.0', url)

    def test_no_redirect_to_another_host(self):
        self.assertIsNone(b.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid'))

    def test_budget_blocks_before_transport(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'ledger'
            ledger.write_text('{}\n' * b.API_CAP)
            with ledger.open('a+') as f:
                session = b.Session(f, Path(tmp) / 'metrics')
                with patch.object(session.opener, 'open') as net:
                    with self.assertRaisesRegex(RuntimeError, 'budget'):
                        session.fetch('dadata', 'search', 'fixture', 'A01')
                    net.assert_not_called()

    @patch.dict('os.environ', {k: 'synthetic-token' for k in b.KEYS.values()})
    def test_429_one_reservation_no_retry_no_secret_saved(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'ledger'
            metrics = Path(tmp) / 'metrics'
            with ledger.open('a+') as f:
                session = b.Session(f, metrics)
                error = urllib.error.HTTPError('https://fixture.invalid/?key=synthetic-token', 429, 'synthetic-token', {}, None)
                with patch.object(session.opener, 'open', side_effect=error) as net, patch('sys.stdout', new_callable=io.StringIO):
                    with self.assertRaises(RuntimeError):
                        session.fetch('locationiq', 'search', 'fixture', 'A01')
                    self.assertEqual(net.call_count, 1)
            self.assertEqual(len(ledger.read_text().splitlines()), 1)
            self.assertNotIn('synthetic-token', metrics.read_text() + ledger.read_text())
            self.assertEqual(json.loads(metrics.read_text())['http'], 429)

    def test_empty_unknown_never_becomes_zero_accuracy(self):
        summary = s.summarize([])
        for result in summary.values():
            self.assertIsNone(result['error_m'])
            self.assertIsNone(result['stages']['search']['exact_share'])
            self.assertIsNone(result['stages']['search']['p95_ms'])

    def test_collect_skips_reserved_failure_and_stores_only_response_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = {'addresses': [{'id': 'A01', 'query': 'private-query-fixture',
                                  'prefix': 'private-prefix-fixture', 'variants': [], 'group': 'ordinary',
                                  'reference': {'expected_address': 'Fixture street, 1', 'confidence': 'medium'}}], 'reverse': []}
            from unittest.mock import Mock
            session = Mock()
            session.fetch.return_value = [{'formatted': 'public response fixture', 'lon': 0, 'lat': 0}]
            with patch('sys.stdout', new_callable=io.StringIO):
                result = b.collect(session, data, ['geoapify'], Path(tmp), {('geoapify', 'search', 'A01')})
            self.assertEqual(result, 0)
            self.assertEqual(session.fetch.call_count, 1)
            self.assertEqual(session.fetch.call_args.args[1], 'autocomplete')
            saved = (Path(tmp) / 'geoapify-response-data.json').read_text()
            for forbidden in ('A01', 'private-query-fixture', 'private-prefix-fixture'):
                self.assertNotIn(forbidden, saved)
            self.assertEqual(json.loads(saved)[0]['lon'], 0)

    def test_text_evaluation_preserves_suffix_and_unknown_parcel(self):
        case = {'id': 'A01', 'group': 'suffix', 'reference': {'expected_address': 'улица Тестовая, 70а, корпус 1', 'confidence': 'medium'}}
        rows = [{'street': 'Тестовая улица', 'housenumber': '70а', 'city': 'Красноярск', 'lon': 0, 'lat': 0}]
        self.assertIsNone(b.evaluate('geoapify', rows, case)['text_match_rank'])
        rows[0]['housenumber'] = '70ак1'
        self.assertEqual(b.evaluate('geoapify', rows, case)['text_match_rank'], 1)
        case['group'] = 'private'
        self.assertEqual(b.evaluate('geoapify', rows, case)['status'], 'unreviewed_parcel_identity')

    def test_transport_failure_does_not_become_empty_or_retry(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            case = {'id': 'A01', 'query': 'fixture', 'prefix': 'fixture', 'variants': [],
                    'group': 'ordinary', 'reference': {'expected_address': 'Тестовая улица, 1', 'confidence': 'medium'}}
            session = Mock()
            session.last_record = {'error': 'transport_or_payload'}
            session.fetch.side_effect = [RuntimeError('fixture'), []]
            with patch('sys.stdout', new_callable=io.StringIO):
                b.collect(session, {'addresses': [case], 'reverse': []}, ['geoapify'], Path(tmp))
            self.assertEqual(session.fetch.call_count, 2)
            self.assertEqual(session.append.call_count, 1)
            self.assertEqual(session.append.call_args.args[0]['stage'], 'autocomplete')


if __name__ == '__main__':
    unittest.main()
