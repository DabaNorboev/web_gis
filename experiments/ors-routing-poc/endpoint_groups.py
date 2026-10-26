"""Group equivalent endpoint projections using retained source-node identity.

``group_candidates(candidates, node_points)`` accepts Network.candidates records
and a mapping of actual OSM node IDs to UTM points. It returns maximal groups;
groups can overlap when different junction anchors compete. Callers must retain
that ambiguity. This helper does not choose a candidate or increase snap limits.

Different source edges require one *common* actual node ID, with every projected
point within the existing 1 m junction band of that node. Same-edge duplicates
require pairwise position agreement within 0.25 m. Pairwise connected components
would incorrectly merge nearby but distinct junctions or drifting projections.
"""
from collections import defaultdict

from historical_geometry import distance


def _cliques(indices, candidates, precision_m):
    """Maximal pairwise-equivalent groups, without distance transitivity."""
    neighbors = {i: {j for j in indices if j != i and
                     distance(candidates[i]['point'], candidates[j]['point']) <= precision_m + 1e-9}
                 for i in indices}
    result = []

    def visit(chosen, possible, excluded):
        if not possible and not excluded:
            result.append(frozenset(chosen))
            return
        # Candidate sets are small local endpoint neighborhoods. Pivoting also
        # keeps a large collection of identical edge projections inexpensive.
        union = possible | excluded
        pivot = max(union, key=lambda i: len(possible & neighbors[i])) if union else None
        for index in sorted(possible - (neighbors[pivot] if pivot is not None else set())):
            visit(chosen | {index}, possible & neighbors[index], excluded & neighbors[index])
            possible.remove(index)
            excluded.add(index)

    visit(set(), set(indices), set())
    return result


def group_candidates(candidates, node_points, junction_band_m=1, precision_m=.25):
    if not (0 <= junction_band_m <= 1 and 0 <= precision_m <= .25):
        raise ValueError('Endpoint grouping allowances exceed the fixed contract')
    candidates = list(candidates)
    by_edge, by_node = defaultdict(list), defaultdict(set)
    for index, candidate in enumerate(candidates):
        # Reversed endpoint order describes the same original undirected edge;
        # directional access remains the responsibility of the existing policy.
        edge = candidate['way'], frozenset((candidate['u'], candidate['v']))
        by_edge[edge].append(index)
        for node in {candidate['u'], candidate['v']}:
            if node in node_points and distance(candidate['point'], node_points[node]) <= junction_band_m + 1e-9:
                by_node[node].add(index)
    groups = {frozenset(indices) for indices in by_node.values()}
    for indices in by_edge.values():
        groups.update(_cliques(indices, candidates, precision_m))
    maximal = [group for group in groups if not any(group < other for other in groups)]
    maximal.sort(key=lambda group: tuple(sorted(group)))
    return [[candidates[index] for index in sorted(group)] for group in maximal]
