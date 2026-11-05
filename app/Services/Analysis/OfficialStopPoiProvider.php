<?php

namespace App\Services\Analysis;

use App\Services\Gis\DatasetCoverage;
use App\Services\Transport\Import\OfficialStopsImporter;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/** Adapter of the existing official snapshot; no OSM or route inference. */
class OfficialStopPoiProvider
{
    public const LIMITATIONS = 'Точки официального набора: полнота действующей сети и актуальность не подтверждены. Наличие остановки не подтверждает удобный подход, нужные маршруты или расписание. Стабильность исходного ID между версиями не подтверждена.';

    public function __construct(private DatasetCoverage $coverage) {}

    public function analyze(array $point, int $radius): array
    {
        if (! config('place_analysis.official_stops_enabled')) {
            return $this->unavailable('OFFICIAL_STOP_NOT_ENABLED', 'Подключение официальных остановок к анализу места ожидает отдельной активации.');
        }

        return DB::transaction(function () use ($point, $radius) {
            DB::statement("SET LOCAL statement_timeout = '2s'");
            DB::statement("SET LOCAL lock_timeout = '500ms'");
            $snapshot = DB::table('dataset_imports')->where('source', OfficialStopsImporter::SOURCE)
                ->where('dataset_key', OfficialStopsImporter::DATASET)->where('status', 'succeeded')->where('is_active', true)->first();
            if (! $snapshot) {
                return $this->unavailable('OFFICIAL_STOP_SNAPSHOT_UNAVAILABLE', 'Активный официальный набор остановок 24bpd отсутствует.');
            }
            $coverage = $this->coverage->assess($snapshot->id, $point['lon'], $point['lat'], $radius);
            if ($coverage['status'] === 'UNKNOWN') {
                return $this->unavailable('OFFICIAL_STOP_COVERAGE_UNAVAILABLE', $coverage['reason']);
            }
            $report = json_decode($snapshot->result ?? '{}', true);
            $invalid = $report['invalid_coordinates'] ?? null;
            $partial = is_array($invalid) && $invalid !== [];
            $reason = self::LIMITATIONS;
            if ($partial) {
                $reason .= ' В исходном наборе есть записи без координат; полный итог неизвестен.';
            }
            $items = [];
            $foundCount = null;
            if ($coverage['status'] !== 'OUTSIDE_SERVICE_AREA') {
                $rows = DB::select(<<<'SQL'
                    WITH p AS (SELECT ST_SetSRID(ST_MakePoint(?,?),4326) geom)
                    SELECT s.source_id,s.name,s.address,ST_X(s.geom) lon,ST_Y(s.geom) lat,
                        ST_Distance(s.geom::geography,p.geom::geography) distance_m,COUNT(*) OVER() found_count
                    FROM transport_stops s CROSS JOIN p
                    WHERE s.dataset_import_id=? AND ST_DWithin(s.geom::geography,p.geom::geography,? + 0.001)
                        AND ST_Distance(s.geom::geography,p.geom::geography)<=?
                    ORDER BY distance_m,s.source_id
                    SQL, [$point['lon'], $point['lat'], $snapshot->id, $radius, $radius]);
                $foundCount = $rows ? (int) $rows[0]->found_count : 0;
                foreach ($rows as $row) {
                    $items[] = ['id' => 'official-stop:'.$row->source_id, 'category' => 'official_stop', 'name' => $row->name, 'address' => $row->address,
                        'point' => ['lon' => (float) $row->lon, 'lat' => (float) $row->lat],
                        'geometry' => ['type' => 'Point', 'coordinates' => [(float) $row->lon, (float) $row->lat]],
                        'distance_m' => (float) $row->distance_m, 'identity_note' => null, 'access' => null,
                        'source' => 'official-stops', 'source_version' => $snapshot->source_version,
                        'source_url' => 'https://www.24bpd.ru/opendata/2466231215-stoppingpoints/',
                        'limitations' => self::LIMITATIONS, 'dataset_import_id' => $snapshot->id,
                        'observed_at' => $snapshot->observed_at === null ? null : CarbonImmutable::parse($snapshot->observed_at)->toISOString(),
                        'source_updated_at' => $snapshot->source_updated_at === null ? null : CarbonImmutable::parse($snapshot->source_updated_at)->toISOString()];
                }
            }

            return ['status' => 'READY', 'code' => null, 'coverage' => ['by_category' => ['official_stop' => $coverage]],
                'completeness' => ['by_category' => ['official_stop' => ['status' => $partial ? 'PARTIAL' : 'UNKNOWN', 'reason' => $reason]]],
                'data' => ['official_stop_summary' => ['found_count' => $foundCount, 'source_without_coordinates' => is_array($invalid) ? count($invalid) : null], 'items' => $items, 'counts_by_category' => ['official_stop' => $coverage['status'] === 'COVERED' && ! $partial ? count($items) : null]]];
        });
    }

    private function unavailable(string $code, string $reason): array
    {
        return ['status' => 'UNAVAILABLE', 'code' => $code,
            'coverage' => ['by_category' => ['official_stop' => ['status' => 'UNKNOWN', 'reason' => $reason, 'available_radius_m' => null]]],
            'completeness' => ['by_category' => ['official_stop' => ['status' => 'UNKNOWN', 'reason' => $reason]]], 'data' => null];
    }
}
