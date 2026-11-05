<?php

namespace App\Services\Osm\Import;

use App\Services\Gis\GeoJsonBoundary;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/** Validate the producer's extraction scope, not a hull inferred from shop locations. */
class OsmGroceryPreparation
{
    protected const DATASET = 'grocery';

    protected const TAG = 'shop';

    protected const VALUES = OsmGroceryReader::SHOPS;

    public function __construct(private GeoJsonBoundary $boundary) {}

    public function validate(array $document, array $coverage): void
    {
        $p = $document['preparation'] ?? null;
        if (! is_array($p) || ($p['schema_version'] ?? null) !== 2 || ($p['dataset_key'] ?? null) !== static::DATASET
            || ($p['method'] ?? null) !== 'complete_source_members_bbox_v2'
            || ($p['categories'] ?? null) !== [static::DATASET]
            || ! $this->sameSet($p['object_types'] ?? null, ['node', 'way', 'relation'])
            || ! is_array($p['rules'] ?? null) || array_keys($p['rules']) !== [static::DATASET]
            || ! is_array($p['rules'][static::DATASET]) || array_keys($p['rules'][static::DATASET]) !== [static::TAG]
            || ! $this->sameSet($p['rules'][static::DATASET][static::TAG], static::VALUES)) {
            throw new RuntimeException('Incompatible or missing grocery preparation scope/version/rules.');
        }
        foreach (['pbf_sha256', 'script_sha256', 'common_script_sha256', 'boundary_sha256'] as $hash) {
            if (! is_string($p[$hash] ?? null) || ! preg_match('/^[0-9a-f]{64}$/D', $p[$hash])) {
                throw new RuntimeException('Missing or invalid grocery preparation provenance.');
            }
        }
        $scope = $this->boundary->geometry(json_encode($p['extraction_geometry'] ?? null, JSON_THROW_ON_ERROR));
        $bbox = $this->bbox($p['bbox'] ?? null);
        // The current producer scans a rectangle. Compare real geometries in PostGIS,
        // including holes/shape and the buffered data boundary, not bbox strings.
        $check = DB::selectOne(<<<'SQL'
            SELECT ST_Equals(g,ST_GeomFromGeoJSON(?)) AS matches_filter,
                ST_Covers(g,ST_GeomFromGeoJSON(?)) AS covers_data
            FROM (SELECT ST_GeomFromGeoJSON(?) g) t
            SQL, [$this->envelope($bbox), $coverage['data_geometry'], $scope]);
        if (! $check->matches_filter || ! $check->covers_data) {
            throw new RuntimeException('Grocery extraction geometry does not match its filter or cover the declared data area.');
        }
        $counts = ['node' => 0, 'way' => 0, 'relation' => 0];
        $relationIds = [];
        foreach ($document['elements'] as $element) {
            if (! in_array($element['tags'][static::TAG] ?? null, static::VALUES, true)) {
                throw new RuntimeException('Input category disagrees with grocery preparation rules.');
            }
            $counts[$element['type']]++;
            if ($element['type'] === 'relation') {
                $relationIds[] = 'osm:relation:'.$element['id'];
            }
        }
        $declared = $p['emitted_counts'] ?? null;
        if (! is_array($declared) || count($declared) !== 3) {
            throw new RuntimeException('Missing grocery preparation counts.');
        }
        foreach ($counts as $type => $count) {
            if (($declared[$type] ?? null) !== $count) {
                throw new RuntimeException('Grocery preparation counts do not reconcile.');
            }
        }
        $audit = $p['relation_audit'] ?? null;
        if (! is_array($audit) || ! is_array($audit['outcomes'] ?? null) || ! array_is_list($audit['outcomes'])
            || ($audit['selected_count'] ?? null) !== count($audit['outcomes'])) {
            throw new RuntimeException('Incomplete grocery relation accounting.');
        }
        $seen = $emitted = [];
        foreach ($audit['outcomes'] as $outcome) {
            $id = $outcome['source_id'] ?? null;
            if (! is_string($id) || ! preg_match('/^osm:relation:[1-9][0-9]*$/D', $id) || isset($seen[$id])) {
                throw new RuntimeException('Invalid grocery relation accounting identity.');
            }
            $seen[$id] = true;
            if (($outcome['status'] ?? null) === 'emitted') {
                $emitted[] = $id;
            } elseif (($outcome['status'] ?? null) === 'outside_extraction'
                && ($outcome['reason'] ?? null) === 'complete_members_bbox_disjoint') {
                $bounds = $this->bbox($outcome['bounds'] ?? null);
                $outside = DB::selectOne('SELECT ST_Disjoint(ST_GeomFromGeoJSON(?),ST_GeomFromGeoJSON(?)) AS ok', [$this->envelope($bounds), $scope]);
                if (! $outside->ok || in_array($id, $relationIds, true)) {
                    throw new RuntimeException('Excluded grocery relation is not proven outside extraction.');
                }
            } else {
                throw new RuntimeException('Unresolved or unsupported selected relation prevents complete grocery publication.');
            }
        }
        if (! $this->sameSet($emitted, $relationIds)) {
            throw new RuntimeException('Emitted grocery relations do not match accounting.');
        }
    }

    private function sameSet(mixed $actual, array $expected): bool
    {
        if (! is_array($actual) || ! array_is_list($actual) || count($actual) !== count($expected)
            || array_filter($actual, fn ($v) => ! is_string($v))) {
            return false;
        }
        sort($actual);
        sort($expected);

        return $actual === $expected;
    }

    private function envelope(array $bounds): string
    {
        [$w, $s, $e, $n] = $bounds;

        return json_encode(['type' => 'Polygon', 'coordinates' => [[[$w, $s], [$e, $s], [$e, $n], [$w, $n], [$w, $s]]]], JSON_THROW_ON_ERROR);
    }

    private function bbox(mixed $bbox): array
    {
        if (! is_array($bbox) || ! array_is_list($bbox) || count($bbox) !== 4
            || array_filter($bbox, fn ($v) => ! is_int($v) && ! is_float($v) || ! is_finite((float) $v))
            || $bbox[0] < -180 || $bbox[2] > 180 || $bbox[1] < -90 || $bbox[3] > 90
            || $bbox[0] >= $bbox[2] || $bbox[1] >= $bbox[3]) {
            throw new RuntimeException('Invalid extraction bounds.');
        }

        return $bbox;
    }
}
