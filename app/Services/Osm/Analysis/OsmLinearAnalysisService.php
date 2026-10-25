<?php

namespace App\Services\Osm\Analysis;

use App\Services\Gis\DatasetCoverage;
use App\Services\Osm\Import\OsmLinearDataset;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

class OsmLinearAnalysisService
{
    public function __construct(private DatasetCoverage $coverage) {}

    public function analyze(float $lon, float $lat, int $radiusM = 500, ?array $snapshots = null): array
    {
        $imports = $snapshots === null ? DB::table('dataset_imports')->where('source', 'OpenStreetMap')->whereIn('dataset_key', ['roads', 'railways'])
            ->where('status', 'succeeded')->where('is_active', true)->get()->keyBy('dataset_key')->all() : $snapshots;
        $result = [];
        foreach (OsmLinearDataset::cases() as $dataset) {
            $result[$dataset->value] = $this->category($dataset, $imports[$dataset->value] ?? null, $lon, $lat, $radiusM);
        }

        return ['point' => ['lon' => $lon, 'lat' => $lat], 'radius_m' => $radiusM, 'categories' => $result];
    }

    private function category(OsmLinearDataset $dataset, ?object $import, float $lon, float $lat, int $radiusM): array
    {
        $coverage = $this->coverage->assess($import?->id, $lon, $lat, $radiusM);
        $base = ['source' => 'OpenStreetMap', 'dataset_import_id' => $import?->id,
            'observed_at' => $import?->observed_at ? CarbonImmutable::parse($import->observed_at)->utc()->toIso8601String() : null,
            'source_updated_at' => $import?->source_updated_at ? CarbonImmutable::parse($import->source_updated_at)->utc()->toIso8601String() : null,
            'calculated_at' => CarbonImmutable::now('UTC')->toIso8601String(), 'method_version' => 'osm_linear_geography_length_utm46_v1'];
        $limitation = $dataset === OsmLinearDataset::Roads
            ? 'Только линии motorway/trunk/primary/secondary по OSM. Близость не является измерением шума или загрязнения; отдельные проезжие части остаются отдельными линиями.'
            : 'Линии rail/narrow_gauge по OSM, без трамвая. Эксплуатация, движение поездов, шум и загрязнение не подтверждены.';
        $metric = fn (string $key, ?float $value, string $availability, string $reason) => ['key' => $dataset->value.'_'.$key, 'value' => $value, 'unit' => 'm'] + $base + ['quality' => [
            'method' => $value === null ? null : 'DERIVED', 'availability' => $availability, 'freshness' => 'UNKNOWN',
            'reason' => $reason.' '.$limitation,
        ]];
        $result = ['coverage' => $coverage, 'nearest' => null, 'metrics' => []];
        if (! $import || in_array($coverage['status'], ['UNKNOWN', 'OUTSIDE_SERVICE_AREA'], true)) {
            foreach (['nearest_distance', 'length'] as $key) {
                $result['metrics'][$key] = $metric($key, null, 'UNAVAILABLE', ! $import ? 'Активный набор отсутствует.' : $coverage['reason']);
            }

            return $result;
        }
        $table = $dataset->table();
        $nearest = DB::selectOne(<<<SQL
            SELECT a.osm_id,a.name,a.ref,a.feature_type,
                ST_Distance(a.geom::geography,ST_SetSRID(ST_MakePoint(?,?),4326)::geography) distance_m
            FROM {$table} a WHERE a.dataset_import_id=?
                AND ST_DWithin(a.geom::geography,ST_SetSRID(ST_MakePoint(?,?),4326)::geography,?)
            ORDER BY distance_m,a.osm_id LIMIT 1
            SQL, [$lon, $lat, $import->id, $lon, $lat, $coverage['available_radius_m']]);
        if ($nearest) {
            $result['nearest'] = ['id' => 'osm:way:'.$nearest->osm_id, 'name' => $nearest->name, 'ref' => $nearest->ref, 'feature_type' => $nearest->feature_type];
        }
        $result['metrics']['nearest_distance'] = $metric('nearest_distance', $nearest ? round((float) $nearest->distance_m, 2) : null,
            $nearest ? 'AVAILABLE' : 'INSUFFICIENT_DATA', $nearest ? 'Расстояние по прямой до ближайшей линии в подтверждённой области поиска.' : 'В подтверждённой области поиска ближайшая линия не определена.');
        if ($coverage['status'] !== 'COVERED') {
            $result['metrics']['length'] = $metric('length', null, 'INSUFFICIENT_DATA', $coverage['reason']);
        } else {
            $length = DB::selectOne(<<<SQL
                WITH c AS (SELECT ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646),?,'quad_segs=64') geom),
                clipped AS (SELECT ST_CollectionExtract(ST_Intersection(ST_Transform(a.geom,32646),c.geom),2) geom
                    FROM {$table} a CROSS JOIN c WHERE a.dataset_import_id=? AND a.geom && ST_Transform(c.geom,4326))
                SELECT coalesce(ST_Length(ST_UnaryUnion(ST_Collect(geom))),0) length_m FROM clipped
                SQL, [$lon, $lat, $radiusM, $import->id]);
            $result['metrics']['length'] = $metric('length', round((float) $length->length_m, 2), 'AVAILABLE', 'Длина объединения линий внутри круга в EPSG:32646; совпадающие отрезки считаются один раз. Это длина картографических линий, не число улиц или маршрутов.');
        }

        return $result;
    }

    public function forDataset(OsmLinearDataset $dataset, ?object $import, float $lon, float $lat, int $radiusM): array
    {
        return $this->category($dataset, $import, $lon, $lat, $radiusM);
    }
}
