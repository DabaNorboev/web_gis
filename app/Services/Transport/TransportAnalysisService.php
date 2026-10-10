<?php

namespace App\Services\Transport;

use App\Services\Transport\Import\OfficialStopsImporter;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

class TransportAnalysisService
{
    public const RADIUS_M = 500;

    public function analyze(float $lon, float $lat): array
    {
        // Capture one snapshot ID for every subsequent query. Historical rows remain available during publication.
        $import = DB::table('dataset_imports')->where('source', OfficialStopsImporter::SOURCE)
            ->where('dataset_key', OfficialStopsImporter::DATASET)->where('status', 'succeeded')->where('is_active', true)->first();
        $calculatedAt = CarbonImmutable::now('UTC')->toIso8601String();
        $observedAt = $import?->observed_at ? CarbonImmutable::parse($import->observed_at)->utc()->toIso8601String() : null;
        $base = [
            'source' => OfficialStopsImporter::SOURCE,
            'dataset_import_id' => $import?->id,
            'observed_at' => $observedAt,
            'calculated_at' => $calculatedAt,
        ];
        $metric = function (string $key, mixed $value, string $unit, string $availability, string $reason) use ($base): array {
            return ['key' => $key, 'value' => $value, 'unit' => $unit] + $base + [
                'quality' => [
                    'method' => $value === null ? null : 'DERIVED',
                    'availability' => $availability,
                    // No source-specific freshness threshold has been approved yet.
                    'freshness' => 'UNKNOWN', 'reason' => $reason,
                ],
            ];
        };
        $response = [
            'point' => ['lon' => $lon, 'lat' => $lat], 'radius_m' => self::RADIUS_M,
            'scope' => 'imported_stops', 'nearest_stop' => null,
            'route_details' => null, 'metrics' => [],
        ];
        if (! $import) {
            foreach (['nearest_stop_distance' => 'm', 'stops_count' => 'count', 'unique_routes_count' => 'count', 'identified_routes_count' => 'count'] as $key => $unit) {
                $response['metrics'][$key] = $metric($key, null, $unit, 'UNAVAILABLE', 'Активный набор остановок отсутствует.');
            }

            return $response;
        }
        $nearest = DB::selectOne(<<<'SQL'
            SELECT id, source_id, name, address, ST_X(geom) AS lon, ST_Y(geom) AS lat,
                ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS distance_m
            FROM transport_stops WHERE dataset_import_id = ?
            ORDER BY distance_m, id LIMIT 1
            SQL, [$lon, $lat, $import->id]);
        $stops = DB::select(<<<'SQL'
            SELECT id FROM transport_stops
            WHERE dataset_import_id = ?
                AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)
            SQL, [$import->id, $lon, $lat, self::RADIUS_M]);
        $stopIds = array_column($stops, 'id');
        $routes = $stopIds ? DB::table('transport_routes as r')
            ->join('transport_stop_routes as link', 'link.transport_route_id', '=', 'r.id')
            ->where('r.dataset_import_id', $import->id)->whereIn('link.transport_stop_id', $stopIds)
            ->select('r.id', 'r.source_id', 'r.mode', 'r.ref')->distinct()->orderBy('r.source_id')->get() : collect();
        $identified = $routes->where('mode', '!=', 'unknown')->values();
        $unresolved = $routes->where('mode', 'unknown')->values();
        $warnings = json_decode($import->result ?? '{}', true)['warnings'] ?? [];
        $incompleteStopIds = [];
        $sourceStopIds = $stopIds ? DB::table('transport_stops')->whereIn('id', $stopIds)->pluck('source_id')->all() : [];
        foreach ($warnings as $warning) {
            if (! in_array($warning['source_id'], $sourceStopIds, true)) {
                continue;
            }
            foreach ($warning['issues'] as $issue) {
                if ($issue === 'missing_routes' || str_starts_with($issue, 'unparsed_route:') || str_starts_with($issue, 'source_type_conflict:')) {
                    $incompleteStopIds[] = $warning['source_id'];
                    break;
                }
            }
        }
        // Imports without route warnings cannot establish completeness for stops with no links.
        if ($stopIds) {
            $withoutLinks = DB::table('transport_stops as s')->whereIn('s.id', $stopIds)
                ->whereNotExists(fn ($query) => $query->selectRaw('1')->from('transport_stop_routes as link')->whereColumn('link.transport_stop_id', 's.id'))
                ->pluck('s.source_id')->all();
            $incompleteStopIds = array_values(array_unique(array_merge($incompleteStopIds, $withoutLinks)));
        }
        $incomplete = $unresolved->isNotEmpty() || $incompleteStopIds !== [];
        if ($nearest) {
            $response['nearest_stop'] = [
                'id' => $nearest->id, 'source_id' => $nearest->source_id, 'dataset_import_id' => $import->id,
                'name' => $nearest->name, 'address' => $nearest->address,
                'lon' => (float) $nearest->lon, 'lat' => (float) $nearest->lat,
            ];
        }
        $response['route_details'] = [
            'identified' => $identified->map(fn ($r) => ['source_id' => $r->source_id, 'mode' => $r->mode, 'ref' => $r->ref])->all(),
            'unresolved_keys' => $unresolved->pluck('source_id')->all(),
            'incomplete_stop_source_ids' => $incompleteStopIds,
            'catalog' => json_decode($import->configuration, true)['route_catalog'] ?? null,
        ];
        $response['metrics'] = [
            'nearest_stop_distance' => $metric('nearest_stop_distance', $nearest ? round((float) $nearest->distance_m, 2) : null, 'm', $nearest ? 'AVAILABLE' : 'INSUFFICIENT_DATA', 'Расстояние по прямой до ближайшей остановки импортированного набора, не пеший маршрут.'),
            'stops_count' => $metric('stops_count', count($stops), 'count', 'AVAILABLE', 'Число точек остановок импортированного набора в радиусе 500 м; полнота реальной сети не подтверждена.'),
            'unique_routes_count' => $metric('unique_routes_count', $incomplete ? null : $identified->count(), 'count', $incomplete ? 'INSUFFICIENT_DATA' : 'AVAILABLE', $incomplete ? 'Есть неопределённые маршруты, пропуски или конфликты исходных сведений.' : 'Уникальные ключи маршрутов из импортированного набора, по одному на вид и номер; действующая сеть не подтверждена.'),
            'identified_routes_count' => $metric('identified_routes_count', $identified->count(), 'count', 'AVAILABLE', 'Количество ключей с определённым видом транспорта; частичный результат при неполных сведениях.'),
        ];

        return $response;
    }
}
