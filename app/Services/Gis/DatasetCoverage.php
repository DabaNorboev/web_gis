<?php

namespace App\Services\Gis;

use Illuminate\Support\Facades\DB;
use RuntimeException;

/** Spatial selection coverage, never a claim that the source describes every real-world object. */
class DatasetCoverage
{
    public function __construct(private GeoJsonBoundary $boundary) {}

    public function prepare(string $boundaryContents, mixed $bufferM = 0): array
    {
        $bufferM = filter_var($bufferM, FILTER_VALIDATE_INT);
        if ($bufferM === false || $bufferM < 0 || $bufferM > 5000) {
            throw new RuntimeException('Buffer must be an integer from 0 to 5000 metres.');
        }
        $service = $this->boundary->geometry($boundaryContents);
        // Krasnoyarsk: UTM 46N. An extra kilometre is used for 500 m queries; exact clearance is checked at runtime.
        $data = $bufferM === 0 ? $service : DB::selectOne(<<<'SQL'
            SELECT ST_AsGeoJSON(ST_Transform(ST_Buffer(ST_Transform(ST_GeomFromGeoJSON(?),32646),?, 'quad_segs=16'),4326),15) AS geom
            SQL, [$service, $bufferM])->geom;
        $data = $this->boundary->geometry($data);
        $covered = DB::selectOne('SELECT ST_Covers(ST_GeomFromGeoJSON(?),ST_GeomFromGeoJSON(?)) AS ok', [$data, $service])->ok;
        if (! $covered) {
            throw new RuntimeException('Selection boundary must cover the service territory.');
        }

        return [
            'service_geometry' => $service, 'data_geometry' => $data,
            'buffer_m' => $bufferM, 'service_boundary_sha256' => hash('sha256', $boundaryContents),
            'data_boundary_sha256' => hash('sha256', $data),
            'method' => 'buffer_in_epsg32646_runtime_geography_clearance',
        ];
    }

    public function validatePreparation(array $document, array $coverage): void
    {
        $hash = $document['preparation']['boundary_sha256'] ?? null;
        if ($hash === null && $coverage['buffer_m'] === 0) {
            return;
        }
        // A city-only prepared file cannot be relabelled as a buffered extract.
        $accepted = [$coverage['data_boundary_sha256']];
        if ($coverage['buffer_m'] === 0) {
            $accepted[] = $coverage['service_boundary_sha256'];
        }
        if (! in_array($hash, $accepted, true)) {
            throw new RuntimeException('Prepared OSM file must use the exact selection boundary (including buffer); prepare it again from the saved PBF.');
        }
    }

    public function metadata(array $coverage): array
    {
        return array_diff_key($coverage, array_flip(['service_geometry', 'data_geometry']));
    }

    public function store(int $importId, array $coverage): void
    {
        DB::statement(<<<'SQL'
            INSERT INTO dataset_coverages
                (dataset_import_id,service_geom,data_geom,buffer_m,service_boundary_sha256,data_boundary_sha256)
            VALUES (?,ST_GeomFromGeoJSON(?),ST_GeomFromGeoJSON(?),?,?,?)
            SQL, [$importId, $coverage['service_geometry'], $coverage['data_geometry'], $coverage['buffer_m'],
            $coverage['service_boundary_sha256'], $coverage['data_boundary_sha256']]);
    }

    public function assess(?int $importId, float $lon, float $lat, int $radiusM): array
    {
        $result = $importId === null ? null : DB::selectOne(<<<'SQL'
            WITH p AS (SELECT ST_SetSRID(ST_MakePoint(?,?),4326) AS geom)
            SELECT ST_Covers(c.service_geom,p.geom) AS inside_service,
                ST_Covers(c.data_geom,p.geom) AS inside_data,
                ST_Distance(p.geom::geography,ST_Boundary(c.data_geom)::geography) AS clearance_m,
                c.buffer_m,c.service_boundary_sha256,c.data_boundary_sha256
            FROM dataset_coverages c CROSS JOIN p WHERE c.dataset_import_id=?
            SQL, [$lon, $lat, $importId]);
        $base = ['dataset_import_id' => $importId, 'radius_m' => $radiusM, 'available_radius_m' => null,
            'buffer_m' => $result?->buffer_m, 'service_boundary_sha256' => $result?->service_boundary_sha256,
            'data_boundary_sha256' => $result?->data_boundary_sha256];
        if (! $result) {
            return $base + ['status' => 'UNKNOWN', 'reason' => 'Подтверждённая область отбора данных отсутствует.'];
        }
        if (! $result->inside_service) {
            return $base + ['status' => 'OUTSIDE_SERVICE_AREA', 'reason' => 'Точка вне территории сервиса. Выберите место в Красноярске.'];
        }
        $clearance = $result->inside_data ? max(0, (float) $result->clearance_m) : 0.0;
        $base['available_radius_m'] = $clearance;

        return $base + ['status' => $clearance >= $radiusM ? 'COVERED' : 'PARTIAL',
            'reason' => $clearance >= $radiusM
                ? 'Область отбора покрывает выбранный радиус; полнота исходного набора относительно реального мира не подтверждена.'
                : 'Область отбора не покрывает весь радиус. Пустой или частичный результат не подтверждает отсутствие объектов.'];
    }
}
