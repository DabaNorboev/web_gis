<?php

namespace App\Services\Analysis;

use App\Services\Gis\DatasetCoverage;
use App\Services\Osm\Import\OsmGroceryReader;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

class GroceryPoiProvider
{
    protected const DATASET = 'grocery';

    protected const METHOD = OsmGroceryReader::METHOD;

    public function __construct(private DatasetCoverage $coverage) {}

    public function analyze(array $point, int $radius): array
    {
        $categoryKey = static::DATASET;
        $table = 'osm_'.$categoryKey;

        return DB::transaction(function () use ($point, $radius, $categoryKey, $table) {
            if (DB::getDriverName() === 'pgsql') {
                DB::statement("SET LOCAL statement_timeout = '2s'");
                DB::statement("SET LOCAL lock_timeout = '500ms'");
            }
            $missing = 'Подготовленный OSM-набор '.$categoryKey.' не активирован в этом окружении (А8).';
            $snapshot = Schema::hasTable($table) ? DB::table('dataset_imports')
                ->where('source', 'OpenStreetMap')->where('dataset_key', $categoryKey)->where('status', 'succeeded')->where('is_active', true)->first() : null;
            $coverage = $completeness = [];
            foreach (['grocery', 'pharmacy', 'official_stop', 'park'] as $category) {
                $reason = $category === $categoryKey ? $missing : 'Provider категории '.$category.' ещё не подключён (А8).';
                $coverage[$category] = ['status' => 'UNKNOWN', 'reason' => $reason, 'available_radius_m' => null];
                $completeness[$category] = ['status' => 'UNKNOWN', 'reason' => $reason];
            }
            $items = [];
            $possibleDuplicates = [];
            foreach ($snapshot ? (json_decode($snapshot->result, true)['possible_duplicates'] ?? []) : [] as $pair) {
                $possibleDuplicates[$pair['first_id']] = true;
                $possibleDuplicates[$pair['second_id']] = true;
            }
            if ($snapshot) {
                $coverage[$categoryKey] = $this->coverage->assess($snapshot->id, $point['lon'], $point['lat'], $radius);
                $completeness[$categoryKey] = ['status' => 'UNKNOWN', 'reason' => 'Полнота OSM и фактическая работа магазинов не подтверждены.'];
                if ($coverage[$categoryKey]['status'] !== 'OUTSIDE_SERVICE_AREA') {
                    $rows = DB::select(<<<SQL
                        WITH p AS (SELECT ST_SetSRID(ST_MakePoint(?,?),4326) AS geom)
                        SELECT g.source_id,g.name,g.address,g.access,ST_AsGeoJSON(g.geom,15) AS geometry,
                            ST_X(ST_PointOnSurface(g.geom)) AS lon,ST_Y(ST_PointOnSurface(g.geom)) AS lat,
                            ST_Distance(g.geom::geography,p.geom::geography) AS distance_m
                        FROM {$table} g CROSS JOIN p
                        WHERE g.dataset_import_id=?
                            -- Conservative indexed candidate filter, never the final analysis radius.
                            AND ST_DWithin(g.geom::geography,p.geom::geography,? + 0.001)
                            AND ST_Distance(g.geom::geography,p.geom::geography)<=?
                        ORDER BY distance_m,g.source_id
                        SQL, [$point['lon'], $point['lat'], $snapshot->id, $radius, $radius]);
                    foreach ($rows as $row) {
                        $items[] = ['id' => $row->source_id, 'category' => $categoryKey, 'name' => $row->name, 'address' => $row->address,
                            'geometry' => json_decode($row->geometry, true), 'point' => ['lon' => (float) $row->lon, 'lat' => (float) $row->lat],
                            'identity_note' => isset($possibleDuplicates[$row->source_id]) ? 'Возможное повторное представление магазина в OSM; общая идентичность не подтверждена, автоматического слияния нет.' : null,
                            'distance_m' => (float) $row->distance_m, 'access' => $row->access, 'source' => 'OpenStreetMap',
                            'dataset_import_id' => $snapshot->id, 'observed_at' => null,
                            'source_updated_at' => $snapshot->source_updated_at === null ? null : CarbonImmutable::parse($snapshot->source_updated_at)->toISOString()];
                    }
                }
            }
            $statuses = array_column($coverage, 'status');
            $summary = in_array('PARTIAL', $statuses, true) || in_array('OUTSIDE_SERVICE_AREA', $statuses, true) ? 'PARTIAL' : 'UNKNOWN';
            $counts = array_fill_keys(array_keys($coverage), null);
            if ($snapshot && $coverage[$categoryKey]['status'] === 'COVERED') {
                $counts[$categoryKey] = count($items);
            }

            return ['status' => $snapshot ? 'READY' : 'UNAVAILABLE', 'code' => $snapshot ? null : strtoupper($categoryKey).'_SNAPSHOT_UNAVAILABLE',
                'message' => $snapshot ? 'Результат категории '.$categoryKey.'. Расстояния прямые, не пешая доступность.' : $missing,
                'calculated_at' => CarbonImmutable::now('UTC')->toISOString(), 'method_version' => static::METHOD,
                'coverage' => ['status' => $summary, 'reason' => 'Покрытие определяется отдельно по категориям.', 'available_radius_m' => null, 'by_category' => $coverage],
                'completeness' => ['status' => 'UNKNOWN', 'reason' => 'Полнота источников относительно реального мира неизвестна.', 'by_category' => $completeness],
                'data' => $snapshot ? ['items' => $items, 'count' => null, 'counts_by_category' => $counts] : null];
        });
    }
}
