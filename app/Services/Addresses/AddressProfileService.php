<?php

namespace App\Services\Addresses;

use App\Services\Gis\AnalysisArea;
use App\Services\Osm\Analysis\OsmAreaAnalysisService;
use App\Services\Osm\Analysis\OsmAreaKind;
use App\Services\Osm\Analysis\OsmAreaMapService;
use App\Services\Osm\Analysis\OsmLinearAnalysisService;
use App\Services\Osm\Analysis\OsmLinearMapService;
use App\Services\Osm\Import\OsmLinearDataset;
use App\Services\Transport\Import\OfficialStopsImporter;
use App\Services\Transport\TransportAnalysisService;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Throwable;

class AddressProfileService
{
    public function __construct(private AnalysisArea $area, private TransportAnalysisService $transport,
        private OsmAreaAnalysisService $areas, private OsmLinearAnalysisService $linear, private OsmAreaMapService $areaMap, private OsmLinearMapService $linearMap) {}

    public function profile(string $id, int $radiusM = 500): array
    {
        abort_unless(preg_match('/^osm:(node|way|relation):([1-9][0-9]{0,18})$/D', $id, $parts), 404, 'Некорректный ID адресного объекта.');
        abort_if(strlen($parts[2]) === 19 && strcmp($parts[2], (string) PHP_INT_MAX) > 0, 404, 'Некорректный ID адресного объекта.');
        $snapshots = DB::table('dataset_imports')->where('status', 'succeeded')->where('is_active', true)
            ->where(fn ($q) => $q->where(fn ($osm) => $osm->where('source', 'OpenStreetMap')->whereIn('dataset_key', ['addresses', 'green_areas', 'water', 'roads', 'railways']))
                ->orWhere(fn ($stops) => $stops->where('source', OfficialStopsImporter::SOURCE)->where('dataset_key', OfficialStopsImporter::DATASET)))
            ->get()->keyBy('dataset_key')->all();
        $import = $snapshots['addresses'] ?? null;
        abort_unless($import, 503, 'Набор адресов недоступен. Попробуйте позже.');
        $row = DB::table('osm_addresses')->where('dataset_import_id', $import->id)->where('osm_type', $parts[1])->where('osm_id', $parts[2])
            ->selectRaw("label,point_method,ST_X(geom) lon,ST_Y(geom) lat,ST_AsGeoJSON(source_geom) geometry,
                ST_XMin(Box3D(source_geom)) west,ST_YMin(Box3D(source_geom)) south,ST_XMax(Box3D(source_geom)) east,ST_YMax(Box3D(source_geom)) north,
                raw_data->'tags'->>'building:levels' levels,
                CASE WHEN coalesce(raw_data->'tags'->>'building','') NOT IN ('','no') THEN 'building'
                    WHEN osm_type='node' THEN 'address_point' ELSE 'address_area' END object_type")->first();
        abort_unless($row, 404, 'Объект не найден в активном наборе адресов. Это не подтверждает его отсутствие на местности.');
        $lon = (float) $row->lon;
        $lat = (float) $row->lat;
        $object = ['id' => $id, 'lon' => $lon, 'lat' => $lat, 'geometry' => json_decode($row->geometry, true),
            'point_method' => $row->point_method, 'object_type' => $row->object_type, 'levels' => $row->levels];
        $address = ['id' => $id, 'label' => $row->label, 'object' => $object,
            'bounds' => [(float) $row->west, (float) $row->south, (float) $row->east, (float) $row->north],
            'source' => 'OpenStreetMap', 'dataset_import_id' => $import->id,
            'observed_at' => $import->observed_at ? CarbonImmutable::parse($import->observed_at)->utc()->toIso8601String() : null,
            'source_updated_at' => $import->source_updated_at ? CarbonImmutable::parse($import->source_updated_at)->utc()->toIso8601String() : null,
            'reason' => 'Подпись и точка из локального OSM. Точка контура не является подтверждённым входом; полнота адресного набора не гарантируется.'];
        $blocks = [];
        $calculations = ['transport' => fn () => $this->transport->analyze($lon, $lat, $radiusM, $snapshots)];
        foreach (OsmAreaKind::cases() as $kind) {
            $calculations[$kind->value] = fn () => $this->areas->forKind($kind, $snapshots[$kind->dataset()] ?? null, $lon, $lat, $radiusM);
        }
        foreach (OsmLinearDataset::cases() as $dataset) {
            $calculations[$dataset->value] = fn () => $this->linear->forDataset($dataset, $snapshots[$dataset->value] ?? null, $lon, $lat, $radiusM);
        }
        foreach ($calculations as $key => $calculation) {
            try {
                // A savepoint isolates a failed SQL block even when a caller already has a transaction.
                $data = DB::transaction($calculation);
                $blocks[$key] = ['status' => 'READY', 'data' => $data, 'message' => null];
            } catch (Throwable $error) {
                report($error);
                $blocks[$key] = ['status' => 'ERROR', 'data' => null, 'message' => 'Не удалось рассчитать блок. Остальные доступные показатели сохранены.'];
            }
        }
        $map = $this->area->forPoint($lon, $lat, $radiusM);
        $map['stops_in_radius'] = $blocks['transport']['data']['stops_in_radius'] ?? [];
        foreach (OsmAreaKind::cases() as $kind) {
            $block = $blocks[$kind->value];
            try {
                $map['area_layers'][$kind->value] = $block['status'] === 'ERROR' ? $block : [
                    'status' => 'READY', 'message' => null,
                    'data' => DB::transaction(fn () => $this->areaMap->forKind($kind, $snapshots[$kind->dataset()] ?? null, $block['data'], $lon, $lat, $radiusM)),
                ];
            } catch (Throwable $error) {
                report($error);
                $map['area_layers'][$kind->value] = ['status' => 'ERROR', 'data' => null, 'message' => 'Геометрия слоя недоступна. Показатели профиля сохранены.'];
            }
        }

        foreach (OsmLinearDataset::cases() as $dataset) {
            $block = $blocks[$dataset->value];
            try {
                $map['linear_layers'][$dataset->value] = $block['status'] === 'ERROR' ? $block : [
                    'status' => 'READY', 'message' => null,
                    'data' => DB::transaction(fn () => $this->linearMap->forDataset($dataset, $snapshots[$dataset->value] ?? null, $block['data'], $lon, $lat, $radiusM)),
                ];
            } catch (Throwable $error) {
                report($error);
                $map['linear_layers'][$dataset->value] = ['status' => 'ERROR', 'data' => null, 'message' => 'Линии слоя недоступны. Показатели профиля сохранены.'];
            }
        }

        return ['address' => $address, 'point' => ['lon' => $lon, 'lat' => $lat], 'radius_m' => $radiusM,
            'calculated_at' => CarbonImmutable::now('UTC')->toIso8601String(), 'map' => $map, 'blocks' => $blocks];
    }
}
