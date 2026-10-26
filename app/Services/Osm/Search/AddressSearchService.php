<?php

namespace App\Services\Osm\Search;

use App\Services\Osm\Import\OsmAddressImporter;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

class AddressSearchService
{
    public function search(string $query): array
    {
        return DB::transaction(function () use ($query) {
            DB::statement('SET LOCAL pg_trgm.word_similarity_threshold = 0.6');

            return $this->find($query);
        });
    }

    private function find(string $query): array
    {
        $import = DB::table('dataset_imports')->where('source', OsmAddressImporter::SOURCE)
            ->where('dataset_key', OsmAddressImporter::DATASET)->where('status', 'succeeded')->where('is_active', true)->first();
        $response = ['data' => [], 'meta' => [
            'source' => OsmAddressImporter::SOURCE, 'dataset_import_id' => $import?->id,
            'unknown_locality_allowed' => false,
            'observed_at' => $import?->observed_at ? CarbonImmutable::parse($import->observed_at)->utc()->toIso8601String() : null,
            'source_updated_at' => $import?->source_updated_at ? CarbonImmutable::parse($import->source_updated_at)->utc()->toIso8601String() : null,
            'calculated_at' => CarbonImmutable::now('UTC')->toIso8601String(),
            'quality' => ['method' => $import ? 'DERIVED' : null, 'availability' => $import ? 'AVAILABLE' : 'UNAVAILABLE',
                'freshness' => 'UNKNOWN', 'reason' => $import
                    ? 'Поиск по локальному снимку OSM; полнота адресов не гарантируется. Точка контура не является входом.'
                    : 'Активный набор адресов отсутствует.'],
        ]];
        if (! $import) {
            return $response;
        }
        $normalized = DB::selectOne('SELECT osm_address_normalize(?) AS text', [$query])->text;
        // City is a search context, not an inferred addr:city. Explicit other localities stay excluded.
        $cityContext = false;
        $normalized = preg_replace('/(?:^|\s)(?:(?:г|город)\s+)?(?:красноярск|krasnoyarsk)(?=\s|$)/u', ' ', $normalized, -1, $cityMentions);
        if ($cityMentions > 0) {
            $cityContext = true;
            $response['meta']['unknown_locality_allowed'] = true;
            $normalized = trim(preg_replace('/\s+/u', ' ', $normalized));
            $response['meta']['quality']['reason'] .= ' Красноярск — контекст локального поиска: записи с неизвестным населённым пунктом включены, их принадлежность городу не подтверждена.';
        }
        if (mb_strlen($normalized) < 3) {
            return $response;
        }
        $house = null;
        $streetQuery = $normalized;
        if (preg_match('/^(.*\p{L}.*?)\s+(\d[\p{L}\p{N}\/\-]*)$/u', $normalized, $parts)) {
            $streetQuery = $parts[1];
            $house = $parts[2];
        }
        $tokens = array_values(array_unique(explode(' ', $streetQuery)));
        $base = DB::table('osm_address_search_entries as e')->where('e.dataset_import_id', $import->id);
        if ($cityContext) {
            $base->whereIn('e.locality_key', ['', 'красноярск']);
        }
        if ($house !== null) {
            $base->where('e.house_key', $house);
        }
        $exact = clone $base;
        foreach ($tokens as $token) {
            $exact->whereRaw('e.search_text ~ ?', ['\\m'.preg_quote($token)]);
        }
        $order = fn ($builder) => $builder->selectRaw('e.group_key, min(e.alias_label) AS label')
            ->selectRaw('max(word_similarity(?,e.search_text)) AS score', [$normalized])
            ->groupBy('e.group_key')->orderByDesc('score')->orderBy('label')->orderBy('e.group_key')->limit(10)->get();
        $rows = $order($exact)->map(function ($row) {
            $row->match_type = 'exact';

            return $row;
        });
        if ($rows->count() < 10) {
            $fuzzy = clone $base;
            foreach ($tokens as $token) {
                $fuzzy->where(function ($part) use ($token) {
                    $part->whereRaw('e.search_text ~ ?', ['\\m'.preg_quote($token)]);
                    if (mb_strlen($token) >= 4) {
                        $part->orWhereRaw('? <% e.search_text', [$token]);
                    }
                });
            }
            $approximations = $order($fuzzy)->map(function ($row) {
                $row->match_type = 'approximate';

                return $row;
            });
            $rows = $rows->concat($approximations)->unique('group_key')->take(10);
        }
        if ($rows->isEmpty()) {
            return $response;
        }
        // Fetch all selectable objects after limiting address groups, never limit members to ten.
        $members = (clone $base)->whereIn('e.group_key', $rows->pluck('group_key')->all())
            ->join('osm_addresses as a', 'a.id', '=', 'e.object_id')
            ->distinct()->selectRaw("e.group_key, a.osm_type, a.osm_id, a.point_method,
                ST_X(a.geom) AS lon, ST_Y(a.geom) AS lat, ST_AsGeoJSON(a.source_geom) AS geometry,
                ST_XMin(Box3D(a.source_geom)) AS xmin, ST_YMin(Box3D(a.source_geom)) AS ymin,
                ST_XMax(Box3D(a.source_geom)) AS xmax, ST_YMax(Box3D(a.source_geom)) AS ymax,
                a.raw_data->'tags'->>'building:levels' AS levels,
                CASE WHEN coalesce(a.raw_data->'tags'->>'building','') NOT IN ('','no') THEN 'building'
                    WHEN a.osm_type='node' THEN 'address_point' ELSE 'address_area' END AS object_type")
            ->orderBy('a.osm_type')->orderBy('a.osm_id')->get()->groupBy('group_key');
        $response['data'] = $rows->map(function ($row) use ($members) {
            $objects = $members[$row->group_key];

            return [
                'id' => 'address:'.hash('sha256', $row->group_key), 'label' => $row->label,
                'match_type' => $row->match_type, 'object_count' => $objects->count(),
                'bounds' => [(float) $objects->min('xmin'), (float) $objects->min('ymin'), (float) $objects->max('xmax'), (float) $objects->max('ymax')],
                'objects' => $objects->map(fn ($object) => [
                    'id' => 'osm:'.$object->osm_type.':'.$object->osm_id,
                    'lon' => (float) $object->lon, 'lat' => (float) $object->lat,
                    'geometry' => json_decode($object->geometry, true),
                    'point_method' => $object->point_method, 'object_type' => $object->object_type, 'levels' => $object->levels,
                ])->all(),
            ];
        })->values()->all();

        return $response;
    }
}
