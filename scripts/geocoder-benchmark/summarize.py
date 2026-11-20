#!/usr/bin/env python3
"""Summarize metrics/evaluator categories, never reopen provider APIs."""
import argparse
from collections import Counter
import json
from pathlib import Path


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[round((len(ordered) - 1) * fraction)]


def summarize(rows):
    output = {}
    for provider in ('dadata', 'geoapify', 'locationiq'):
        own = [r for r in rows if r['provider'] == provider]
        calls = [r for r in own if 'reservation' in r]
        review = [r for r in own if r.get('kind') == 'review']
        textual = [r for r in own if r.get('kind') == 'text_evaluation']
        stages = {}
        for stage in ('search', 'autocomplete', 'variant', 'selected', 'reverse'):
            reviewed = [r for r in review if r['stage'] == stage]
            measured = [r for r in calls if r['stage'] == stage]
            grades = Counter(r['address_grade'] for r in reviewed)
            eligible = sum(grades[g] for g in ('exact', 'partial', 'wrong'))
            stages[stage] = {'requests': len(measured), 'reviews': len(reviewed),
                'grades': dict(grades), 'known_denominator': eligible,
                'exact_share': grades['exact'] / eligible if eligible else None,
                'top1_exact': sum(r['address_grade'] == 'exact' and r.get('correct_rank') == 1 for r in reviewed),
                'top5_exact': sum(r['address_grade'] == 'exact' and r.get('correct_rank') is not None for r in reviewed),
                'p50_ms': percentile([r['elapsed_ms'] for r in measured], .5),
                'p95_ms': percentile([r['elapsed_ms'] for r in measured], .95),
                'errors': sum('error' in r for r in measured),
                'ambiguous': sum(r['ambiguous'] == 'yes' for r in reviewed),
                'levels': dict(Counter(r['level'] for r in reviewed))}
            auto = [r for r in textual if r['stage'] == stage]
            by_group = {}
            for group in sorted({r['group'] for r in auto}):
                subset = [r for r in auto if r['group'] == group]
                eligible = [r for r in subset if r['reference_confidence'] != 'low' and r['status'] != 'unreviewed_parcel_identity']
                by_group[group] = {'evaluated_responses': len(subset), 'eligible_text_references': len(eligible),
                    'top1_strict_text_match': sum(r['text_match_rank'] == 1 for r in eligible) if eligible else None,
                    'top5_strict_text_match': sum(r['text_match_rank'] is not None for r in eligible) if eligible else None,
                    'other_city_candidates': sum(r['explicit_other_city_count'] for r in subset)}
            stages[stage]['textual_by_group'] = by_group
        output[provider] = {'requests': len(calls), 'stages': stages, 'error_m': None,
                            'error_reason': 'no_independent_geometry'}
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('metrics', type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize([json.loads(line) for line in args.metrics.read_text().splitlines()]), ensure_ascii=False, indent=2))
