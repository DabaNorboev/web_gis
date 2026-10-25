<?php

namespace App\Services\Osm\Analysis;

use App\Services\Gis\DatasetCoverage;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;

/** Independent cartographic areas; this service performs no imagery or routing work. */
class OsmAreaAnalysisService
{
    public const METHOD_VERSION = 'osm_area_union_utm46_flags_v1';

    public function __construct(private DatasetCoverage $coverage) {}

    public function analyze(float $lon, float $lat, int $radiusM = 500, ?array $snapshots = null): array
    {
        if (! is_finite($lon) || ! is_finite($lat) || abs($lon) > 180 || abs($lat) > 90 || ! in_array($radiusM, [300, 500], true)) {
            throw new InvalidArgumentException('Use WGS84 coordinates and a 300 or 500 metre radius.');
        }
        // Freeze both snapshot IDs once; parks and vegetation cannot switch snapshots mid-response.
        $imports = $snapshots === null ? DB::table('dataset_imports')->where('source', 'OpenStreetMap')->whereIn('dataset_key', ['green_areas', 'water'])
            ->where('status', 'succeeded')->where('is_active', true)->get()->keyBy('dataset_key') : collect($snapshots);
        $calculatedAt = CarbonImmutable::now('UTC')->toIso8601String();
        $categories = [];
        foreach (OsmAreaKind::cases() as $kind) {
            $categories[$kind->value] = $this->category($kind, $imports->get($kind->dataset()), $lon, $lat, $radiusM, $calculatedAt);
        }

        return ['point' => ['lon' => $lon, 'lat' => $lat], 'radius_m' => $radiusM, 'method_version' => self::METHOD_VERSION, 'categories' => $categories];
    }

    private function category(OsmAreaKind $kind, ?object $import, float $lon, float $lat, int $radiusM, string $calculatedAt): array
    {
        $coverage = $this->coverage->assess($import?->id, $lon, $lat, $radiusM);
        $base = ['source' => 'OpenStreetMap', 'dataset_import_id' => $import?->id,
            'observed_at' => $import?->observed_at ? CarbonImmutable::parse($import->observed_at)->utc()->toIso8601String() : null,
            'source_updated_at' => $import?->source_updated_at ? CarbonImmutable::parse($import->source_updated_at)->utc()->toIso8601String() : null,
            'calculated_at' => $calculatedAt, 'method_version' => self::METHOD_VERSION];
        $metric = fn (string $key, ?float $value, string $unit, string $availability, string $reason) => ['key' => $kind->value.'_'.$key, 'value' => $value, 'unit' => $unit] + $base + ['quality' => [
            'method' => $value === null ? null : 'DERIVED', 'availability' => $availability,
            'freshness' => 'UNKNOWN', 'reason' => $reason.' '.$kind->limitation(),
        ]];
        $result = ['coverage' => $coverage, 'nearest' => null, 'metrics' => []];
        if (! $import || in_array($coverage['status'], ['UNKNOWN', 'OUTSIDE_SERVICE_AREA'], true)) {
            foreach (['area' => 'm2', 'share' => '%', 'nearest_distance' => 'm'] as $key => $unit) {
                $result['metrics'][$key] = $metric($key, null, $unit, 'UNAVAILABLE', ! $import ? 'Активный набор отсутствует.' : $coverage['reason']);
            }

            return $result;
        }
        // Identifiers and the semantic predicate come from an enum, never from request input.
        $table = $kind->table();
        $predicate = $kind->predicate();
        if ($coverage['status'] === 'COVERED') {
            $area = DB::selectOne(<<<SQL
                WITH circle AS (
                    SELECT ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646),?, 'quad_segs=64') AS geom
                ), clipped AS (
                    SELECT ST_CollectionExtract(ST_Intersection(ST_Transform(a.geom,32646),c.geom),3) AS geom
                    FROM {$table} a CROSS JOIN circle c
                    WHERE a.dataset_import_id=? AND {$predicate} AND a.geom && ST_Transform(c.geom,4326)
                ), merged AS (SELECT ST_UnaryUnion(ST_Collect(geom)) AS geom FROM clipped)
                SELECT coalesce(ST_Area(m.geom),0) AS area_m2,ST_Area(c.geom) AS circle_m2
                FROM merged m CROSS JOIN circle c
                SQL, [$lon, $lat, $radiusM, $import->id]);
            $result['metrics']['area'] = $metric('area', round((float) $area->area_m2, 2), 'm2', 'AVAILABLE', 'Площадь объединения пересечений с радиусом в EPSG:32646. Наложения и дубли учитываются один раз, отверстия сохраняются.');
            // Preserve positive intersections below display precision; the UI formats them as <0.1%.
            $result['metrics']['share'] = $metric('share', 100 * (float) $area->area_m2 / (float) $area->circle_m2, '%', 'AVAILABLE', 'Доля площади круга в EPSG:32646, отдельно для этой категории. Не складывать доли разных категорий.');
        } else {
            foreach (['area' => 'm2', 'share' => '%'] as $key => $unit) {
                $result['metrics'][$key] = $metric($key, null, $unit, 'INSUFFICIENT_DATA', $coverage['reason']);
            }
        }
        $nearest = DB::selectOne(<<<SQL
            SELECT a.osm_type,a.osm_id,a.name,a.raw_data->'tags'->>'access' AS access,
                ST_Distance(a.geom::geography,ST_SetSRID(ST_MakePoint(?,?),4326)::geography) AS distance_m
            FROM {$table} a
            WHERE a.dataset_import_id=? AND {$predicate}
                AND ST_DWithin(a.geom::geography,ST_SetSRID(ST_MakePoint(?,?),4326)::geography,?)
            ORDER BY distance_m,a.osm_type,a.osm_id LIMIT 1
            SQL, [$lon, $lat, $import->id, $lon, $lat, $coverage['available_radius_m']]);
        if ($nearest) {
            $result['nearest'] = ['id' => 'osm:'.$nearest->osm_type.':'.$nearest->osm_id, 'name' => $nearest->name, 'access' => $nearest->access];
        }
        $result['metrics']['nearest_distance'] = $metric('nearest_distance', $nearest ? round((float) $nearest->distance_m, 2) : null, 'm',
            $nearest ? 'AVAILABLE' : 'INSUFFICIENT_DATA', $nearest ? 'Расстояние по прямой до геометрии ближайшего объекта в подтверждённой области поиска; внутри контура — ноль. Это не маршрут до входа.' : 'Ближайший объект в подтверждённой области поиска не определён; отсутствие результата не означает отсутствие объекта.');

        return $result;
    }

    public function forKind(OsmAreaKind $kind, ?object $import, float $lon, float $lat, int $radiusM): array
    {
        return $this->category($kind, $import, $lon, $lat, $radiusM, CarbonImmutable::now('UTC')->toIso8601String());
    }
}
