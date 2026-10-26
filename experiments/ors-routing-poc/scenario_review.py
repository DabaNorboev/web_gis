"""Offline review of frozen object inputs and separately selected street inputs.

No router, database, import, or graph mutation is performed. A street result
never establishes the missing connection from an address or a shop to a street.
"""
import argparse
from collections import Counter
from copy import deepcopy
from pathlib import Path
import json

from historical_geometry import distance, utm
from revision_review import RevisionReviewer
from review_support import HERE, digest, read, write
from scenario_probe import validate_scenarios
from scenario_run import graph_hashes, NEW_LOCK_FILES


PRIOR = Path('data/reports/ors-routing-poc-2026-10-26')
SCENARIOS = Path('experiments/ors-routing-poc/scenarios.json')
POLICY = Path('experiments/ors-routing-poc/walking-policy.json')
PBF = Path('data/reports/local-routing-2026-10-21/prepared/pilot.osm.pbf')
INPUTS = {PBF, Path('data/reports/local-routing-2026-10-21/prepared/context.json'),
          Path('data/reports/local-routing-integration-2026-10-21/guard-export/obstacles.jsonl'),
          Path('data/reports/local-routing-integration-2026-10-21/guard-export/guard-sources.json'),
          PRIOR / 'nodes.jsonl', Path('experiments/grocery-poc/.runtime/data/dataset.json')}
SNAP_LIMIT_M = 20


def indexed_rows(cases, response):
    """An incomplete, duplicated, or relabelled experiment is not reviewable."""
    expected = {case['id'] + '-' + variant: (case['id'], variant)
                for case in cases for variant in ('original', 'selected')}
    rows = response.get('rows')
    if (response.get('mode') != 'walking' or response.get('profile') != 'foot-walking'
            or response.get('snap_radius_m') != SNAP_LIMIT_M or not isinstance(rows, list)
            or len(rows) != len(expected)):
        raise ValueError('Expected both walking variants of every frozen scenario')
    indexed = {}
    for row in rows:
        if not isinstance(row, dict) or row.get('id') not in expected or row['id'] in indexed:
            raise ValueError('Unknown or duplicate scenario response ID')
        if (row.get('case_id'), row.get('variant')) != expected[row['id']]:
            raise ValueError('Response scenario metadata differs from its frozen ID')
        indexed[row['id']] = row
    if indexed.keys() != expected.keys():
        raise ValueError('Missing frozen scenario response')
    return indexed


def review_case(case, rows, reviewer):
    results = {}
    for variant in ('original', 'selected'):
        endpoints = {end: case[variant][end]['coordinate'] for end in ('start', 'target')}
        # Protect raw evidence even when a future checker implementation mutates.
        result = deepcopy(reviewer.row_v2(deepcopy(rows[case['id'] + '-' + variant]), deepcopy(endpoints)))
        result['distance_m'] = result['duration_s'] = None
        matched = result.get('checks', {}).get('source_chain', {}).get('status') == 'MATCHED'
        if result['status'] != 'MODEL_GEOMETRY_CONSISTENT' or not matched:
            result['model_consistent_distance_m'] = None
        results[variant] = result
    connectors = []
    for end in ('start', 'target'):
        original, selected = [utm(case[variant][end]['coordinate']) for variant in ('original', 'selected')]
        shift = distance(original, selected)
        check = reviewer.endpoint_v2(original, selected)
        connectors.append({'endpoint': end, 'shift_m': shift, 'within_limit': shift <= SNAP_LIMIT_M,
                           'status': check['status'], 'reasons': list(check['reasons'])})
    different = any(not check['within_limit'] for check in connectors)
    unconfirmed = any(check['status'] != 'SOURCE_CANDIDATE_CONSISTENT' for check in connectors)
    # Never promote the address using a result from a different pair of points.
    address_status = ('NEEDS_REFINEMENT' if different or unconfirmed else results['original']['status'])
    return {'id': case['id'], 'original_result': results['original'], 'selected_result': results['selected'],
            'connector_checks': connectors,
            'selection_kind': 'DIFFERENT_STREET_POINTS' if different else 'WITHIN_ORIGINAL_SNAP_LIMIT',
            'address_route_status': address_status, 'address_distance_m': None, 'address_duration_s': None}


def verify_inputs(source, output):
    """Fail closed before review/output if any preserved evidence has changed."""
    freeze = read(output / 'scenario-freeze.json')
    task = read(output / 'task-start.json')
    baseline = read(output / 'research-baseline.json')
    if set(task['inputs']) != {str(path) for path in INPUTS}:
        raise ValueError('Expected all six task-start inputs')
    for relative, checksum in task['inputs'].items():
        if digest(source / relative) != checksum:
            raise ValueError('Task-start input hash mismatch: ' + relative)
    if (baseline['head'] != freeze['research_head']
            or baseline['prior_research'].keys() != task['prior_research'].keys()):
        raise ValueError('Research baseline does not identify the frozen research commit')
    differences = {path for path, checksum in baseline['prior_research'].items()
                   if task['prior_research'][path] != checksum}
    if differences:
        change = baseline.get('change_from_task_start', {})
        path = change.get('path')
        if (differences != {path} or change.get('before') != task['prior_research'].get(path)
                or change.get('after') != baseline['prior_research'].get(path) or not change.get('reason')):
            raise ValueError('Research baseline change lacks explicit before/after evidence')
    # Runtime consumes Python and the policy. Documentation preservation belongs
    # to the final task allowlist and may include a new link to this experiment.
    consumed = {path: checksum for path, checksum in baseline['prior_research'].items()
                if Path(path).suffix == '.py' or Path(path).name == 'walking-policy.json'}
    for relative, checksum in consumed.items():
        if digest(source / relative) != checksum:
            raise ValueError('Preserved research hash mismatch: ' + relative)
    for path, key in ((SCENARIOS, 'scenarios_sha256'), (PBF, 'pbf_sha256'), (POLICY, 'policy_sha256')):
        if digest(source / path) != freeze[key]:
            raise ValueError('Frozen input hash mismatch: ' + key)
    if (freeze.get('no_ors_requests_before_freeze') is not True
            or freeze.get('refinement_attempts_per_end') != 1):
        raise ValueError('Expected scenarios frozen before requests and one selected candidate per end')
    manifest = read(source / SCENARIOS)
    if (manifest.get('status') != 'FROZEN_BEFORE_ROUTER_REQUESTS'
            or manifest.get('snap_limit_m') != SNAP_LIMIT_M
            or manifest.get('refinement_attempts_per_end') != 1):
        raise ValueError('Frozen manifest policy mismatch')
    cases = validate_scenarios(manifest)
    if [case['id'] for case in cases] != freeze['case_ids']:
        raise ValueError('Frozen scenario IDs changed')
    runtime = output / 'runtime'
    if digest(runtime / 'scenarios.json') != freeze['scenarios_sha256']:
        raise ValueError('Runtime scenario snapshot mismatch')
    raw_freeze = read(output / 'response-freeze.json')
    raw_sha = digest(runtime / 'responses.json')
    if (raw_freeze['responses_sha256'] != raw_sha
            or raw_freeze['scenarios_sha256'] != freeze['scenarios_sha256']):
        raise ValueError('Raw response snapshot hash mismatch')
    run = read(runtime / 'runtime.json')
    if (run.get('outcome') != 'PROBED' or run.get('source_graph_unchanged') is not True
            or run.get('copy_graph_verified') is not True or run.get('cleanup_errors')):
        raise ValueError('Runtime did not confirm a clean probe and graph preservation')
    before, after = read(runtime / 'source-graph-before.json'), read(runtime / 'source-graph-after.json')
    frozen_graph = freeze['graph_hashes']
    if (before['source_before'] != frozen_graph or before['copy_before_start'] != frozen_graph
            or before['source_after_copy'] != frozen_graph
            or before.get('source_unchanged_after_copy') is not True
            or before.get('copy_matches_frozen_source') is not True
            or after['source_after'] != frozen_graph or after.get('source_unchanged') is not True
            or after.get('copy_verified') is not True or after.get('copy_changed_or_missing_files')
            or after.get('copy_unexpected_files')):
        raise ValueError('Graph preservation records differ from frozen graph')
    source_graph = graph_hashes(source / PRIOR / 'walking/home/graphs')
    copy_graph = graph_hashes(runtime / 'home/graphs')
    if (source_graph != frozen_graph or any(copy_graph.get(path) != checksum for path, checksum in frozen_graph.items())
            or set(copy_graph) - frozen_graph.keys() - NEW_LOCK_FILES
            or copy_graph != after['copy_after_stop']):
        raise ValueError('Current source or copied graph differs from preserved evidence')
    response = read(runtime / 'responses.json')
    rows = indexed_rows(cases, response)
    hashes = {'scenarios_sha256': freeze['scenarios_sha256'], 'raw_response_sha256': raw_sha,
              'input_sha256': task['inputs'], 'task_start_research_sha256': task['prior_research'],
              'preserved_research_sha256': consumed,
              'research_baseline_sha256': digest(output / 'research-baseline.json'),
              'research_head': baseline['head'],
              'baseline_change_from_task_start': baseline.get('change_from_task_start'),
              'checker_sources': {name: digest(HERE / name) for name in
                                  ('scenario_review.py', 'revision_review.py', 'historical_review.py',
                                   'historical_geometry.py', 'source_chain.py', 'endpoint_groups.py',
                                   'review_ors.py', 'review_support.py', 'walking-policy.json')}}
    return cases, rows, hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='Task root containing the frozen runtime')
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    target = output / 'scenario-review.json'
    if target.exists():
        raise FileExistsError('Scenario review already exists; preserve prior output')
    cases, rows, hashes = verify_inputs(source, output)
    reviewer = RevisionReviewer(source, source / PRIOR, 'walking')
    results = [review_case(case, rows, reviewer) for case in cases]
    # Detect unexpected input mutation during computation before writing results.
    _, _, final_hashes = verify_inputs(source, output)
    if hashes != final_hashes:
        raise ValueError('Review evidence changed during computation')
    summary = {'case_count': len(results), 'raw_variant_count': len(rows),
               'original_statuses': dict(Counter(c['original_result']['status'] for c in results)),
               'selected_statuses': dict(Counter(c['selected_result']['status'] for c in results)),
               'address_statuses': dict(Counter(c['address_route_status'] for c in results)),
               'selection_kinds': dict(Counter(c['selection_kind'] for c in results)),
               'evidence': hashes, 'field_access_verified': False, 'user_study_performed': False,
               'user_eta': None, 'product_integration': 'NOT_PERFORMED'}
    limits = {'snap_limit_m': SNAP_LIMIT_M, 'refinement_attempts_per_end': 1,
              'address_metrics': 'ALWAYS_NULL', 'selected_model_distance': 'MATCHED_SOURCE_MODEL_ONLY',
              'observed_at': None, 'freshness': 'UNKNOWN',
              'limitations': ['Illustrative public scenarios; no representative city coverage.',
                              'Street candidates were selected from saved source geometry, not a human usability study.',
                              'Far selected candidates do not establish absence of another allowed street within 20 m.',
                              'Object points and street points are separate inputs, not verified entrances.',
                              'No field access, usual walking time, or user study has been validated.']}
    write(target, {'cases': results, 'summary': summary, 'limits': limits})
    print(json.dumps({'output': str(target), 'address_statuses': summary['address_statuses']}))


if __name__ == '__main__':
    main()
