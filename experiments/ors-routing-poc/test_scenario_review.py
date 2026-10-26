"""Scenario evidence/semantic regressions; synthetic files only, no router or DB."""
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import scenario_review as review
from revision_review import RevisionReviewer


def scenario(start_shift=10, target_shift=10):
    return {'id': 'synthetic',
            'original': {'start': {'coordinate': [0, 0]}, 'target': {'coordinate': [100, 0]}},
            'selected': {'start': {'coordinate': [start_shift, 0]},
                         'target': {'coordinate': [100 + target_shift, 0]}}}


def responses():
    return {'mode': 'walking', 'profile': 'foot-walking', 'snap_radius_m': 20,
            'rows': [{'id': 'synthetic-' + variant, 'case_id': 'synthetic', 'variant': variant}
                     for variant in ('original', 'selected')]}


def passed_row(row, _):
    return {'id': row['id'], 'status': 'MODEL_GEOMETRY_CONSISTENT', 'reasons': [],
            'distance_m': None, 'duration_s': None, 'model_consistent_distance_m': 100,
            'checks': {'source_chain': {'status': 'MATCHED'}}}


class ScenarioSemantics(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(review, 'utm', side_effect=lambda p: tuple(p))
        patcher.start()
        self.addCleanup(patcher.stop)

    def reviewer(self, endpoint=None):
        return SimpleNamespace(row_v2=passed_row,
                               endpoint_v2=endpoint or (lambda a, b: {
                                   'status': 'SOURCE_CANDIDATE_CONSISTENT', 'reasons': []}))

    def evaluate(self, case, reviewer=None):
        return review.review_case(case, review.indexed_rows([case], responses()), reviewer or self.reviewer())

    def test_twenty_metre_boundary_is_inclusive_without_widening(self):
        at_limit = self.evaluate(scenario(20, 0))
        beyond = self.evaluate(scenario(20.000001, 0))
        self.assertEqual(at_limit['selection_kind'], 'WITHIN_ORIGINAL_SNAP_LIMIT')
        self.assertTrue(at_limit['connector_checks'][0]['within_limit'])
        self.assertEqual(beyond['selection_kind'], 'DIFFERENT_STREET_POINTS')
        self.assertEqual(beyond['address_route_status'], 'NEEDS_REFINEMENT')

    def test_original_in_building_under_twenty_remains_unknown_even_when_street_passes(self):
        obj = RevisionReviewer.__new__(RevisionReviewer)
        polygon = [[(-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1)]]
        obj.obstacles = SimpleNamespace(query=lambda a, b: [('way/building', 'building', [polygon])])
        # The second end is independently confirmed, so only one bad connector
        # must suffice to prevent promotion of the whole address pair.
        def endpoint(a, b):
            return obj.endpoint_v2(a, b) if a == (0, 0) else {
                'status': 'SOURCE_CANDIDATE_CONSISTENT', 'reasons': []}
        result = self.evaluate(scenario(10, 0), self.reviewer(endpoint))
        self.assertEqual(result['selected_result']['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertEqual(result['connector_checks'][0]['reasons'], ['ORIGINAL_IN_BUILDING:way/building'])
        self.assertEqual(result['address_route_status'], 'NEEDS_REFINEMENT')
        self.assertIsNone(result['address_distance_m'])
        self.assertIsNone(result['address_duration_s'])
        self.assertEqual(result['connector_checks'][1]['status'], 'SOURCE_CANDIDATE_CONSISTENT')

    def test_far_target_never_becomes_address_route_and_keeps_partial_street_model(self):
        result = self.evaluate(scenario(0, 179))
        self.assertEqual(result['selection_kind'], 'DIFFERENT_STREET_POINTS')
        self.assertEqual(result['address_route_status'], 'NEEDS_REFINEMENT')
        self.assertEqual(result['selected_result']['model_consistent_distance_m'], 100)
        self.assertEqual(result['connector_checks'][1]['shift_m'], 179)
        self.assertIsNone(result['address_distance_m'])
        self.assertIsNone(result['selected_result']['duration_s'])

    def test_unmatched_source_cannot_keep_model_distance(self):
        reviewer = self.reviewer()
        def unmatched(row, endpoints):
            result = passed_row(row, endpoints)
            result['checks']['source_chain']['status'] = 'UNMAPPED'
            return result
        reviewer.row_v2 = unmatched
        result = self.evaluate(scenario(), reviewer)
        self.assertIsNone(result['selected_result']['model_consistent_distance_m'])

    def test_original_and_selected_are_independent_and_inputs_are_not_mutated(self):
        case = scenario()
        rows = review.indexed_rows([case], responses())
        saved_case, saved_rows = deepcopy(case), deepcopy(rows)
        calls = []
        def mutating_checker(row, endpoints):
            calls.append(deepcopy(endpoints))
            result = passed_row(row, endpoints)
            if row['variant'] == 'original':
                result['status'] = 'UNAVAILABLE'
            row['id'] = 'mutated'
            endpoints['start'][0] = -999
            return result
        obj = self.reviewer()
        obj.row_v2 = mutating_checker
        result = review.review_case(case, rows, obj)
        self.assertEqual(case, saved_case)
        self.assertEqual(rows, saved_rows)
        self.assertEqual([c['start'] for c in calls], [[0, 0], [10, 0]])
        self.assertEqual(result['original_result']['status'], 'UNAVAILABLE')
        self.assertEqual(result['selected_result']['status'], 'MODEL_GEOMETRY_CONSISTENT')
        self.assertEqual(result['address_route_status'], 'UNAVAILABLE')

    def test_missing_duplicate_or_relabelled_raw_variants_refuse(self):
        for change in ('missing', 'duplicate', 'metadata', 'unknown'):
            with self.subTest(change=change):
                response = responses()
                if change == 'missing':
                    response['rows'].pop()
                elif change == 'duplicate':
                    response['rows'][1] = deepcopy(response['rows'][0])
                elif change == 'metadata':
                    response['rows'][1]['variant'] = 'original'
                else:
                    response['rows'][1]['id'] = 'another-selected'
                with self.assertRaises(ValueError):
                    review.indexed_rows([scenario()], response)


class EvidencePreservation(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.out = self.root / 'task'
        self.runtime = self.out / 'runtime'
        self.runtime.mkdir(parents=True)
        for path in review.INPUTS | {review.POLICY}:
            self.put(self.root / path, {'synthetic': str(path)})
        self.manifest = {'version': 1, 'status': 'FROZEN_BEFORE_ROUTER_REQUESTS',
                         'snap_limit_m': 20, 'refinement_attempts_per_end': 1,
                         'cases': [scenario()]}
        for path in (self.root / review.SCENARIOS, self.runtime / 'scenarios.json'):
            self.put(path, self.manifest)
        frozen = {'scenarios_sha256': review.digest(self.root / review.SCENARIOS),
                  'pbf_sha256': review.digest(self.root / review.PBF),
                  'policy_sha256': review.digest(self.root / review.POLICY),
                  'no_ors_requests_before_freeze': True, 'refinement_attempts_per_end': 1,
                  'research_head': 'a' * 40,
                  'case_ids': ['synthetic']}
        source_graph = self.root / review.PRIOR / 'walking/home/graphs'
        self.put(source_graph / 'foot-walking/edges', {'saved': 'graph'})
        self.put(self.runtime / 'home/graphs/foot-walking/edges', {'saved': 'graph'})
        frozen['graph_hashes'] = review.graph_hashes(source_graph)
        self.put(self.out / 'scenario-freeze.json', frozen)
        old_code = Path('experiments/ors-routing-poc/preserved.py')
        self.put(self.root / old_code, {'synthetic': 'preserved code'})
        prior = {str(old_code): review.digest(self.root / old_code)}
        self.put(self.out / 'task-start.json', {
            'inputs': {str(p): review.digest(self.root / p) for p in review.INPUTS}, 'prior_research': prior})
        self.put(self.out / 'research-baseline.json', {'head': frozen['research_head'], 'prior_research': prior})
        self.put(self.runtime / 'responses.json', responses())
        self.put(self.out / 'response-freeze.json', {
            'responses_sha256': review.digest(self.runtime / 'responses.json'),
            'scenarios_sha256': frozen['scenarios_sha256']})
        self.put(self.runtime / 'runtime.json', {'outcome': 'PROBED', 'source_graph_unchanged': True,
                                               'copy_graph_verified': True, 'cleanup_errors': []})
        graph = frozen['graph_hashes']
        self.put(self.runtime / 'source-graph-before.json', {
            'source_before': graph, 'copy_before_start': graph, 'source_after_copy': graph,
            'source_unchanged_after_copy': True, 'copy_matches_frozen_source': True})
        self.put(self.runtime / 'source-graph-after.json', {
            'source_after': graph, 'source_unchanged': True, 'copy_verified': True,
            'copy_after_stop': graph, 'copy_changed_or_missing_files': [], 'copy_unexpected_files': []})

    def put(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def verify(self):
        return review.verify_inputs(self.root, self.out)

    def test_review_verification_does_not_modify_any_input(self):
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        cases, rows, _ = self.verify()
        self.assertEqual(len(cases), 1)
        self.assertEqual(len(rows), 2)
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_each_of_six_task_inputs_is_hash_checked(self):
        for relative in review.INPUTS:
            with self.subTest(relative=str(relative)):
                path = self.root / relative
                before = path.read_bytes()
                path.write_bytes(before + b'changed')
                with self.assertRaisesRegex(ValueError, 'Task-start input hash mismatch'):
                    self.verify()
                path.write_bytes(before)

    def test_raw_response_and_runtime_snapshot_are_frozen(self):
        for relative in ('responses.json', 'scenarios.json'):
            with self.subTest(relative=relative):
                path = self.runtime / relative
                before = path.read_bytes()
                path.write_bytes(before + b' ')
                with self.assertRaisesRegex(ValueError, '[Ss]napshot.*mismatch'):
                    self.verify()
                path.write_bytes(before)

    def test_successful_http_is_not_enough_without_graph_preservation(self):
        self.put(self.runtime / 'runtime.json', {'outcome': 'PROBED', 'source_graph_unchanged': False,
                                               'copy_graph_verified': True})
        with self.assertRaisesRegex(ValueError, 'graph preservation'):
            self.verify()

    def test_modified_private_graph_is_not_accepted_using_stale_proof(self):
        self.put(self.runtime / 'home/graphs/foot-walking/edges', {'changed': 'graph'})
        with self.assertRaisesRegex(ValueError, 'differs from preserved evidence'):
            self.verify()

    def test_preserved_checker_change_requires_explicit_baseline_evidence(self):
        baseline_path = self.out / 'research-baseline.json'
        baseline = review.read(baseline_path)
        relative, before = next(iter(baseline['prior_research'].items()))
        self.put(self.root / relative, {'synthetic': 'changed code'})
        with self.assertRaisesRegex(ValueError, 'Preserved research hash mismatch'):
            self.verify()
        baseline['prior_research'][relative] = review.digest(self.root / relative)
        self.put(baseline_path, baseline)
        with self.assertRaisesRegex(ValueError, 'explicit before/after evidence'):
            self.verify()
        baseline['change_from_task_start'] = {'path': relative, 'before': before,
                                             'after': baseline['prior_research'][relative],
                                             'reason': 'Explicit synthetic baseline correction'}
        self.put(baseline_path, baseline)
        self.verify()


if __name__ == '__main__':
    unittest.main()
