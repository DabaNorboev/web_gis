<?php

namespace App\Services\Addresses;

use App\Services\Transport\Import\OfficialStopsImporter;
use Carbon\CarbonImmutable;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Support\Facades\DB;

/** Exact local identity lookup, with no environment/map analysis dependency. */
class AddressResolverService
{
    public const CAPABILITIES = ['resolver_version' => 1, 'selected_profile_version' => 1];

    public function validateId(string $id): array
    {
        if (! preg_match('/^osm:(node|way|relation):([1-9][0-9]{0,18})$/D', $id, $parts)
            || (strlen($parts[2]) === 19 && strcmp($parts[2], (string) PHP_INT_MAX) > 0)) {
            $this->notFound('Некорректный ID адресного объекта.');
        }

        return $parts;
    }

    public function snapshots(bool $addressesOnly = false): array
    {
        return DB::table('dataset_imports')->where('status', 'succeeded')->where('is_active', true)
            ->when($addressesOnly, fn ($q) => $q->where('source', 'OpenStreetMap')->where('dataset_key', 'addresses'))
            ->where(fn ($q) => $q->where(fn ($osm) => $osm->where('source', 'OpenStreetMap')->whereIn('dataset_key', ['addresses', 'green_areas', 'water', 'roads', 'railways']))
                ->orWhere(fn ($stops) => $stops->where('source', OfficialStopsImporter::SOURCE)->where('dataset_key', OfficialStopsImporter::DATASET)))
            ->get()->keyBy('dataset_key')->all();
    }

    public function resolve(string $id, ?array $snapshots = null): array
    {
        $parts = $this->validateId($id);
        $snapshots ??= $this->snapshots(true);
        $import = $snapshots['addresses'] ?? null;
        if (! $import) {
            $this->unavailable();
        }
        $row = DB::table('osm_addresses')->where('dataset_import_id', $import->id)->where('osm_type', $parts[1])->where('osm_id', $parts[2])
            ->selectRaw("label,point_method,ST_X(geom) lon,ST_Y(geom) lat,ST_AsGeoJSON(source_geom) geometry,
                ST_XMin(Box3D(source_geom)) west,ST_YMin(Box3D(source_geom)) south,ST_XMax(Box3D(source_geom)) east,ST_YMax(Box3D(source_geom)) north,
                raw_data->'tags'->>'building:levels' levels,
                CASE WHEN coalesce(raw_data->'tags'->>'building','') NOT IN ('','no') THEN 'building'
                    WHEN osm_type='node' THEN 'address_point' ELSE 'address_area' END object_type")->first();
        if (! $row) {
            $this->notFound();
        }
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

        return $address;
    }

    public function notFound(string $message = 'Объект не найден в активном наборе адресов. Это не подтверждает его отсутствие на местности.'): never
    {
        throw new HttpResponseException(response()->json(['code' => 'ADDRESS_NOT_FOUND',
            'message' => $message], 404)
            ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer'));
    }

    public function unavailable(): never
    {
        throw new HttpResponseException(response()->json(['code' => 'ADDRESS_SOURCE_UNAVAILABLE',
            'message' => 'Набор адресов недоступен. Попробуйте позже.'], 503)
            ->header('Cache-Control', 'no-store')->header('Referrer-Policy', 'no-referrer'));
    }
}
