<?php

namespace App\Services\Addresses;

use App\Services\Gis\DatasetCoverage;
use App\Services\Osm\Import\OsmAddressImporter;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/** A label for an unchanged user point, never a replacement analysis location. */
class PointAddressService
{
    public const NEARBY_RADIUS_M = 100;
    public const TIE_TOLERANCE_M = 1;

    public function __construct(private DatasetCoverage $coverage) {}

    public function resolve(float $lon, float $lat): array
    {
        $import = DB::table('dataset_imports')->where('source', OsmAddressImporter::SOURCE)
            ->where('dataset_key', OsmAddressImporter::DATASET)->where('status', 'succeeded')->where('is_active', true)->first();
        $response = ['data' => ['match' => 'NONE', 'candidates' => [], 'requires_choice' => false], 'meta' => [
            'source' => OsmAddressImporter::SOURCE, 'dataset_import_id' => $import?->id,
            'observed_at' => $import?->observed_at ? CarbonImmutable::parse($import->observed_at)->utc()->toIso8601String() : null,
            'source_updated_at' => $import?->source_updated_at ? CarbonImmutable::parse($import->source_updated_at)->utc()->toIso8601String() : null,
            'calculated_at' => CarbonImmutable::now('UTC')->toIso8601String(),
            'nearby_radius_m' => self::NEARBY_RADIUS_M,
            'coverage' => $this->coverage->assess($import?->id, $lon, $lat, self::NEARBY_RADIUS_M),
            'quality' => ['method' => null, 'availability' => $import ? 'INSUFFICIENT_DATA' : 'UNAVAILABLE',
                'freshness' => 'UNKNOWN', 'reason' => $import
                    ? 'Подходящий адрес не найден в локальных данных в пределах 100 м. Полнота набора не гарантируется.'
                    : 'Активный локальный набор адресов отсутствует.'],
        ]];
        if (! $import || $response['meta']['coverage']['status'] === 'OUTSIDE_SERVICE_AREA') {
            if ($import) {
                $response['meta']['quality']['reason'] = $response['meta']['coverage']['reason'];
            }

            return $response;
        }

        // Reuse the prepared search identity: aliases already mapped to a building are not separate candidates.
        // ST_Covers uses the existing source_geom GiST; all overlapping objects remain explicit.
        $base = <<<'SQL'
            WITH p AS (SELECT ST_SetSRID(ST_MakePoint(?,?),4326) AS geom)
            SELECT a.osm_type,a.osm_id,a.label,GeometryType(a.source_geom) AS geometry_type,
                CASE WHEN coalesce(a.raw_data->'tags'->>'building','') NOT IN ('','no') THEN 'building'
                    WHEN a.osm_type='node' THEN 'address_point' ELSE 'address_area' END AS object_type,
                ST_Distance(a.source_geom::geography,p.geom::geography) AS distance_m
            FROM osm_addresses a CROSS JOIN p
            WHERE a.dataset_import_id=?
                AND EXISTS (SELECT 1 FROM osm_address_search_entries e WHERE e.object_id=a.id AND e.dataset_import_id=a.dataset_import_id)
            SQL;
        $rows = DB::select($base.' AND ST_Covers(a.source_geom,p.geom) ORDER BY a.osm_type,a.osm_id', [$lon, $lat, $import->id]);
        $match = 'CONTAINING';
        if (! $rows) {
            // Bounded spatial prefilter uses the existing geometry index, without a new index/migration.
            $rows = DB::select($base.<<<'SQL'
                 AND a.source_geom && ST_Envelope(ST_Buffer(p.geom::geography,?)::geometry)
                 AND ST_DWithin(a.source_geom::geography,p.geom::geography,?)
                 ORDER BY distance_m,a.osm_type,a.osm_id
                SQL, [$lon, $lat, $import->id, self::NEARBY_RADIUS_M + 1, self::NEARBY_RADIUS_M]);
            $match = 'NEARBY';
            if ($rows) {
                $nearest = (float) $rows[0]->distance_m;
                // Do not silently break equal-distance ties by ID, label or row ordering.
                $rows = array_values(array_filter($rows, fn ($row) => (float) $row->distance_m <= $nearest + self::TIE_TOLERANCE_M));
            }
        }
        if (! $rows) {
            return $response;
        }
        $response['data'] = ['match' => $match, 'requires_choice' => count($rows) > 1,
            'candidates' => array_map(fn ($row) => [
                'id' => 'osm:'.$row->osm_type.':'.$row->osm_id, 'label' => $row->label,
                'object_type' => $row->object_type, 'geometry_type' => $row->geometry_type,
                'distance_m' => (float) $row->distance_m,
            ], $rows)];
        $response['meta']['quality'] = ['method' => $match === 'NEARBY' ? 'PROXY' : 'DERIVED', 'availability' => 'AVAILABLE', 'freshness' => 'UNKNOWN',
            'reason' => ($match === 'NEARBY' ? 'Ближайший адресный объект в пределах 100 м; расстояние по прямой до исходной геометрии. Это не адрес выбранной точки.'
                : 'Совпадение с исходной геометрией адресного объекта OSM, включая границу контура; это не подтверждение адреса на местности.')
                .' Полнота набора, вход и разрешённый доступ не подтверждены. Исходная точка анализа сохраняется.'];

        return $response;
    }
}
