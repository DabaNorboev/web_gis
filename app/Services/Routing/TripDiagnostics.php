<?php

namespace App\Services\Routing;

/** Additive machine-readable reasons. Never infer an endpoint from prose or proximity. */
final class TripDiagnostics
{
    public static function issue(string $code, string $location = 'unknown', string $stage = 'route'): array
    {
        $category = match (true) {
            in_array($code, ['SNAP_RADIUS_EXCEEDED', 'SNAP_HINT_OUTSIDE_RADIUS', 'SNAP_LIMIT_EXCEEDED']) => 'distance',
            $code === 'SNAP_CHOICE_REQUIRED' => 'ambiguity',
            str_contains($code, 'ACCESS'), str_contains($code, 'CONDITION') => 'access',
            str_contains($code, 'BARRIER'), str_contains($code, 'BUILDING'), str_contains($code, 'WATER'),
            str_contains($code, 'RAILWAY'), $code === 'SNAP_CROSSES_ROAD', $code === 'INDOOR_ROUTE' => 'obstacle',
            $code === 'OUTSIDE_CONFIRMED_COVERAGE' => 'coverage',
            $code === 'ROUTER_UNAVAILABLE' => 'service',
            $code === 'ROUTE_CHECK_FAILED', $code === 'SNAP_CHECK_FAILED' => 'check_failure',
            default => 'insufficient_data',
        };

        return compact('code', 'category', 'stage', 'location');
    }

    public static function envelope(array $issues, int $targetIndex): array
    {
        $grouped = [];
        foreach ($issues as $issue) {
            $key = $issue['stage'].':'.$issue['code'];
            if (isset($grouped[$key]) && in_array($grouped[$key]['location'], ['start', 'target', 'both_endpoints'], true)
                && in_array($issue['location'], ['start', 'target', 'both_endpoints'], true)
                && $grouped[$key]['location'] !== $issue['location']) {
                $grouped[$key]['location'] = 'both_endpoints';
            } else {
                // Keep independent route/unknown evidence even when codes coincide.
                $key = isset($grouped[$key]) && $grouped[$key]['location'] !== $issue['location'] ? $key.':'.$issue['location'] : $key;
                $grouped[$key] = $issue;
            }
        }
        foreach ($grouped as &$issue) {
            $issue['target_index'] = in_array($issue['location'], ['target', 'both_endpoints'], true) ? $targetIndex : null;
        }

        return ['version' => 1, 'issues' => array_values($grouped)];
    }
}
