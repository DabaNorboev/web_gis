<?php

namespace Tests\Integration;

use App\Services\Analysis\GroceryPoiProvider;
use App\Services\Osm\Import\OsmGroceryImporter;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase;

class GroceryPoiTest extends PostgisTestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        // This transaction isolates active snapshots from all prior test contents.
        DB::table('dataset_imports')->where('dataset_key', 'grocery')->update(['is_active' => false]);
        $this->directory = sys_get_temp_dir().'/grocery-test-'.bin2hex(random_bytes(6));
        mkdir($this->directory);
        file_put_contents($this->directory.'/boundary.json', json_encode(['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]]));
    }

    protected function tearDown(): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        if (isset($this->directory)) {
            foreach (glob($this->directory.'/*') as $file) {
                unlink($file);
            }
            rmdir($this->directory);
        }
        parent::tearDown();
    }

    private function node(int $id, array $tags = [], float $lon = 93, float $lat = 56): array
    {
        return ['type' => 'node', 'id' => $id, 'version' => 1, 'timestamp' => '2026-10-18T20:25:06Z', 'lon' => $lon, 'lat' => $lat, 'tags' => $tags + ['shop' => 'convenience']];
    }

    private function way(int $id, array $ring, array $tags = []): array
    {
        return ['type' => 'way', 'id' => $id, 'version' => 1, 'tags' => $tags + ['shop' => 'supermarket'], 'geometry' => array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], $ring)];
    }

    private function preparation(array $rows): array
    {
        $shape = DB::selectOne('SELECT ST_AsGeoJSON(ST_Envelope(ST_GeomFromGeoJSON(?)),15) AS geometry', [file_get_contents($this->directory.'/boundary.json')]);
        $geometry = json_decode($shape->geometry, true);
        $points = $geometry['coordinates'][0];
        $counts = ['node' => 0, 'way' => 0, 'relation' => 0];
        $outcomes = [];
        foreach ($rows as $row) {
            $counts[$row['type']]++;
            if ($row['type'] === 'relation') {
                $outcomes[] = ['source_id' => 'osm:relation:'.$row['id'], 'status' => 'emitted'];
            }
        }

        return ['schema_version' => 2, 'dataset_key' => 'grocery', 'categories' => ['grocery'],
            'method' => 'complete_source_members_bbox_v2', 'object_types' => ['node', 'way', 'relation'],
            'rules' => ['grocery' => ['shop' => ['supermarket', 'convenience']]],
            'pbf_sha256' => hash('sha256', 'synthetic-source'), 'script_sha256' => hash_file('sha256', base_path('scripts/prepare-osm-grocery.py')),
            'common_script_sha256' => hash_file('sha256', base_path('scripts/prepare-osm-linear.py')),
            'boundary_sha256' => hash_file('sha256', $this->directory.'/boundary.json'),
            'extraction_geometry' => $geometry,
            'bbox' => [min(array_column($points, 0)), min(array_column($points, 1)), max(array_column($points, 0)), max(array_column($points, 1))],
            'emitted_counts' => $counts, 'relation_audit' => ['selected_count' => count($outcomes), 'outcomes' => $outcomes]];
    }

    private function import(array $rows, ?array $preparation = null): array
    {
        file_put_contents($this->directory.'/grocery.json', json_encode(['osm3s' => ['timestamp_osm_base' => '2026-10-18T20:25:06Z'],
            'preparation' => $preparation ?? $this->preparation($rows), 'elements' => $rows]));

        return app(OsmGroceryImporter::class)->import($this->directory.'/grocery.json', $this->directory.'/boundary.json');
    }

    private function analyze(float $lon = 93, float $lat = 56, int $radius = 200): array
    {
        return $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'point', 'lon' => $lon, 'lat' => $lat], 'radius_m' => $radius, 'blocks' => ['poi']])
            ->assertOk()->assertHeader('Cache-Control', 'no-store, private')->json('blocks.poi');
    }

    public function test_scope_identity_unknown_fields_zero_and_atomic_retry(): void
    {
        $rows = [$this->node(1),
            $this->node(4, ['disused:shop' => 'convenience']), $this->node(5, ['closed' => 'yes']),
            $this->node(6, ['name' => 'Same'], 93.001), $this->node(7, ['name' => 'Same'], 93.0011)];
        $r = $this->import($rows);
        $this->assertSame(3, $r['report']['accepted_objects']);
        $this->assertSame('skipped', $this->import($rows)['status']);
        $b = $this->analyze();
        $this->assertSame('READY', $b['status']);
        $this->assertCount(3, $b['data']['items']);
        $this->assertSame(3, $b['data']['counts_by_category']['grocery']);
        $this->assertNull($b['data']['count']);
        foreach (['pharmacy', 'official_stop', 'park'] as $category) {
            $this->assertNull($b['data']['counts_by_category'][$category]);
            $this->assertSame('UNKNOWN', $b['coverage']['by_category'][$category]['status']);
        }
        $item = $b['data']['items'][0];
        foreach (['name', 'address', 'access', 'observed_at'] as $field) {
            $this->assertNull($item[$field]);
        }
        $this->assertSame(0.0, (float) $item['distance_m']);
        $zero = $this->analyze(93.5);
        $this->assertSame(0, $zero['data']['counts_by_category']['grocery']);
        $this->assertSame([], $zero['data']['items']);
        $bad = $this->way(9, [[93, 56], [93.01, 56], [93, 56.01]]);
        try {
            $this->import([$bad]);
            $this->fail('Broken geometry was accepted.');
        } catch (RuntimeException $error) {
            $this->assertNotEmpty($error->getMessage());
        }
        $this->assertSame($r['import_id'], DB::table('dataset_imports')->where('dataset_key', 'grocery')->where('is_active', true)->value('id'));
        $this->assertSame(3, $this->analyze()['data']['counts_by_category']['grocery']);
        try {
            $this->import([$this->node(1), $this->node(1)]);
            $this->fail('Duplicate identity accepted.');
        } catch (RuntimeException $error) {
            $this->assertStringContainsString('Duplicate OSM object', $error->getMessage());
        }
    }

    public function test_radius_boundary_polygon_intersection_and_distance_to_source_geometry(): void
    {
        $rows = [$this->node(1)];
        foreach ([199.99, 200.01, 999.99, 1000.01] as $i => $distance) {
            $p = DB::selectOne('SELECT ST_X(g) lon,ST_Y(g) lat FROM (SELECT ST_Project(ST_SetSRID(ST_MakePoint(93,56),4326)::geography,?::double precision,pi()/2)::geometry g) t', [$distance]);
            $rows[] = $this->node(2 + $i, [], $p->lon, $p->lat);
        }
        // Marker is more than 200m away; western edge intersects the circle.
        $ring = [[93.001, 55.9999], [93.02, 55.9999], [93.02, 56.0001], [93.001, 56.0001], [93.001, 55.9999]];
        $rows[] = $this->way(10, $ring);

        $this->import($rows);
        $small = $this->analyze();
        $this->assertSame(['osm:node:1', 'osm:way:10', 'osm:node:2'], array_column($small['data']['items'], 'id'));
        $this->assertEqualsWithDelta(199.99, $small['data']['items'][2]['distance_m'], .001);
        $this->assertSame($ring, $small['data']['items'][1]['geometry']['coordinates'][0]);
        $this->assertGreaterThan(93.003, $small['data']['items'][1]['point']['lon']);
        $this->assertCount(5, $this->analyze(radius: 1000)['data']['items']);
    }

    public function test_exact_radius_is_inclusive_without_rounding_distance(): void
    {
        file_put_contents($this->directory.'/boundary.json', json_encode(['type' => 'Polygon', 'coordinates' => [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]]]));
        $p = DB::selectOne('SELECT ST_X(g) lon,ST_Y(g) lat FROM (SELECT ST_Project(ST_SetSRID(ST_MakePoint(0,0),4326)::geography,200::double precision,0::double precision)::geometry g) t');
        $this->import([$this->node(1, [], $p->lon, $p->lat), $this->node(2, [], rad2deg(200.001 / 6378137), 0)]);
        $b = $this->analyze(0, 0);
        $this->assertSame(['osm:node:1'], array_column($b['data']['items'], 'id'));
        $this->assertEqualsWithDelta(200, $b['data']['items'][0]['distance_m'], .000001);
    }

    public function test_structural_alias_is_removed_but_containment_and_same_name_are_not_identity(): void
    {
        $ring = [[92.999, 55.999], [93.001, 55.999], [93.001, 56.001], [92.999, 56.001], [92.999, 55.999]];
        $way = $this->way(10, $ring, ['name' => 'Same']);
        $relation = ['type' => 'relation', 'id' => 20, 'tags' => ['type' => 'multipolygon'] + $way['tags'],
            'members' => [['type' => 'way', 'ref' => 10, 'role' => 'outer', 'geometry' => $way['geometry']]]];
        $r = $this->import([$way, $relation, $this->node(1, ['shop' => 'supermarket', 'name' => 'Same'])]);
        $this->assertSame([['alias' => 'osm:way:10', 'canonical' => 'osm:relation:20']], $r['report']['duplicate_representations']);
        $this->assertCount(1, $r['report']['possible_duplicates']);
        $items = $this->analyze()['data']['items'];
        $this->assertCount(2, $items);
        $this->assertNotNull($items[0]['identity_note']);
        $this->assertNotNull($items[1]['identity_note']);
    }

    public function test_partial_outside_missing_and_provider_error_are_not_zero(): void
    {
        $this->assertSame('UNAVAILABLE', $this->analyze()['status']);
        $this->import([$this->node(1, [], 92.0001)]);
        $partial = $this->analyze(92.0001);
        $this->assertSame('PARTIAL', $partial['coverage']['by_category']['grocery']['status']);
        $this->assertNull($partial['data']['counts_by_category']['grocery']);
        $outside = $this->analyze(0, 0);
        $this->assertSame('OUTSIDE_SERVICE_AREA', $outside['coverage']['by_category']['grocery']['status']);
        $this->assertNull($outside['data']['counts_by_category']['grocery']);
        $this->mock(GroceryPoiProvider::class, fn ($mock) => $mock->shouldReceive('analyze')->andThrow(new RuntimeException('PRIVATE_CANARY')));
        $response = $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'point', 'lon' => 93, 'lat' => 56]])
            ->assertOk()->assertJsonPath('blocks.poi.status', 'ERROR')->assertJsonPath('blocks.satellite.status', 'UNAVAILABLE')->assertDontSee('PRIVATE_CANARY');
        $this->assertNull($response->json('blocks.poi.data'));
    }

    public function test_incompatible_scope_rules_metadata_and_geography_never_publish_or_replace_snapshot(): void
    {
        $first = $this->import([$this->node(1)]);
        $rows = [$this->node(2, ['shop' => 'supermarket'])];
        $valid = $this->preparation($rows);
        $changes = [
            'supermarket_only' => function ($p) {
                $p['rules']['grocery']['shop'] = ['supermarket'];

                return $p;
            },
            'missing_type' => fn ($p) => array_replace($p, ['object_types' => ['node']]),
            'wrong_category' => fn ($p) => array_replace($p, ['categories' => ['pharmacy']]),
            'unknown_version' => fn ($p) => array_replace($p, ['schema_version' => 99]),
            'wrong_boundary_hash' => fn ($p) => array_replace($p, ['boundary_sha256' => str_repeat('f', 64)]),
            'unknown_method' => fn ($p) => array_replace($p, ['method' => 'unknown']),
            'missing_provenance' => function ($p) {
                unset($p['pbf_sha256']);

                return $p;
            },
            'missing_audit' => function ($p) {
                unset($p['relation_audit']);

                return $p;
            },
            'bad_counts' => fn ($p) => array_replace($p, ['emitted_counts' => ['node' => 0, 'way' => 0, 'relation' => 0]]),
            'legacy_metadata' => fn ($p) => ['boundary_sha256' => $p['boundary_sha256'], 'rules' => $p['rules']],
            'absent_metadata' => fn ($p) => [],
            'narrow_area' => function ($p) {
                $p['bbox'] = [93.09, 55.99, 93.11, 56.01];
                $p['extraction_geometry'] = ['type' => 'Polygon', 'coordinates' => [[[93.09, 55.99], [93.11, 55.99], [93.11, 56.01], [93.09, 56.01], [93.09, 55.99]]]];

                return $p;
            },
            // Same bbox and boundary hash, but the scanned geometry has a hole.
            'same_bbox_incomplete_geometry' => function ($p) {
                $p['extraction_geometry']['coordinates'][] = [[92.9, 55.9], [92.9, 56.1], [93.1, 56.1], [93.1, 55.9], [92.9, 55.9]];

                return $p;
            },
            'omitted_emitted_relation' => fn ($p) => array_replace($p, ['relation_audit' => ['selected_count' => 1, 'outcomes' => [['source_id' => 'osm:relation:20', 'status' => 'emitted']]]]),
            'rejected_relation' => fn ($p) => array_replace($p, ['relation_audit' => ['selected_count' => 1, 'outcomes' => [['source_id' => 'osm:relation:20', 'status' => 'rejected', 'reason' => 'unsupported_node_or_nested_member']]]]),
            'false_outside_relation' => fn ($p) => array_replace($p, ['relation_audit' => ['selected_count' => 1, 'outcomes' => [['source_id' => 'osm:relation:20', 'status' => 'outside_extraction', 'reason' => 'complete_members_bbox_disjoint', 'bounds' => [92.9, 55.9, 93.1, 56.1]]]]]),
        ];
        foreach ($changes as $case => $change) {
            try {
                $this->import($rows, $change($valid));
                $this->fail('Accepted incompatible metadata: '.$case);
            } catch (RuntimeException $e) {
                $this->assertNotEmpty($e->getMessage(), $case);
            }
            $this->assertSame($first['import_id'], DB::table('dataset_imports')->where('is_active', true)->where('dataset_key', 'grocery')->value('id'), $case);
            $this->assertSame(1, DB::table('dataset_imports')->where('dataset_key', 'grocery')->count(), $case);
        }
        foreach (['grocery', 'bakery'] as $shop) {
            try {
                $this->import([$this->node(2, ['shop' => $shop])]);
                $this->fail('Accepted incompatible object category.');
            } catch (RuntimeException $e) {
                $this->assertStringContainsString('category', $e->getMessage());
            }
        }
    }

    public function test_geographically_equal_scope_is_accepted_without_bbox_string_comparison(): void
    {
        $rows = [$this->node(1)];
        $p = $this->preparation($rows);
        $p['extraction_geometry']['coordinates'][0] = array_reverse($p['extraction_geometry']['coordinates'][0]);
        $p['rules']['grocery']['shop'] = array_reverse($p['rules']['grocery']['shop']);
        $p['object_types'] = array_reverse($p['object_types']);
        $p['relation_audit'] = ['selected_count' => 1, 'outcomes' => [['source_id' => 'osm:relation:20', 'status' => 'outside_extraction', 'reason' => 'complete_members_bbox_disjoint', 'bounds' => [95, 58, 96, 59]]]];
        $this->assertSame('succeeded', $this->import($rows, $p)['status']);
        $this->assertSame(1, $this->analyze()['data']['counts_by_category']['grocery']);
    }

    public function test_late_activation_failure_preserves_old_rows_coverage_and_active_identity(): void
    {
        $first = $this->import([$this->node(1)]);
        $id = (int) $first['import_id'];
        DB::unprepared("CREATE FUNCTION grocery_test_reject_activation() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.is_active AND NEW.id<>$id AND NEW.dataset_key='grocery' THEN
                    IF EXISTS (SELECT 1 FROM dataset_imports WHERE id=$id AND is_active)
                        OR NOT EXISTS (SELECT 1 FROM osm_grocery WHERE dataset_import_id=NEW.id)
                        OR NOT EXISTS (SELECT 1 FROM dataset_coverages WHERE dataset_import_id=NEW.id) THEN
                        RAISE EXCEPTION 'activation failure was not late';
                    END IF;
                    RAISE EXCEPTION 'synthetic late activation failure';
                END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER grocery_test_activation BEFORE UPDATE ON dataset_imports FOR EACH ROW EXECUTE FUNCTION grocery_test_reject_activation()");
        try {
            $this->import([$this->node(2)]);
            $this->fail('Activation should fail.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('synthetic late activation failure', $e->getMessage());
        }
        $this->assertSame($id, DB::table('dataset_imports')->where('is_active', true)->where('dataset_key', 'grocery')->value('id'));
        $this->assertSame(['osm:node:1'], DB::table('osm_grocery')->where('dataset_import_id', $id)->pluck('source_id')->all());
        $this->assertSame(0, DB::table('osm_grocery')->where('dataset_import_id', '<>', $id)->whereIn('dataset_import_id', DB::table('dataset_imports')->where('dataset_key', 'grocery')->pluck('id'))->count());
        $this->assertSame(1, DB::table('dataset_coverages')->whereIn('dataset_import_id', DB::table('dataset_imports')->where('dataset_key', 'grocery')->pluck('id'))->count());
        $this->assertSame(1, DB::table('dataset_imports')->where('dataset_key', 'grocery')->where('status', 'failed')->count());
    }

    public function test_explicit_saved_legacy_input_is_rejected_without_relabelling_coverage(): void
    {
        $file = getenv('A8_LEGACY_GROCERY_FILE');
        if (! $file) {
            $this->markTestSkipped('Select a legacy input explicitly.');
        }
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('Incompatible or missing grocery preparation');
        app(OsmGroceryImporter::class)->import($file, base_path('data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson'));
    }

    public function test_saved_real_snapshot_only_when_explicitly_selected(): void
    {
        $file = getenv('A8_GROCERY_FILE');
        if (! $file) {
            $this->markTestSkipped('Select an isolated prepared real snapshot explicitly.');
        }
        $r = app(OsmGroceryImporter::class)->import($file, base_path('data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson'));
        $this->assertGreaterThan(0, $r['report']['accepted_objects']);
        $this->assertSame('skipped', app(OsmGroceryImporter::class)->import($file, base_path('data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson'))['status']);
        $point = DB::selectOne('SELECT ST_X(ST_PointOnSurface(geom)) lon,ST_Y(ST_PointOnSurface(geom)) lat FROM osm_grocery WHERE dataset_import_id=? ORDER BY source_id LIMIT 1', [$r['import_id']]);
        foreach ([200, 1000] as $radius) {
            $b = $this->analyze($point->lon, $point->lat, $radius);
            $this->assertSame('READY', $b['status']);
            $this->assertNotEmpty($b['data']['items']);
            $this->assertSame(0.0, (float) $b['data']['items'][0]['distance_m']);
        }
        // Public source-object coordinates only; never a user's analysis point.
        if ($directory = getenv('A8_GROCERY_QA_DIR')) {
            foreach ([200, 1000] as $radius) {
                $request = ['place' => ['kind' => 'point', 'lon' => $point->lon, 'lat' => $point->lat], 'radius_m' => $radius, 'blocks' => ['poi']];
                $response = $this->postJson('/api/v1/place-analysis', $request)->assertOk()->json();
                $stream = fopen($directory.'/test-api-'.$radius.'.json', 'x');
                fwrite($stream, json_encode(['environment' => 'web_gis_test_rolled_back', 'request' => $request, 'response' => $response], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
                fclose($stream);
            }
            $stream = fopen($directory.'/test-import-report.json', 'x');
            fwrite($stream, json_encode($r, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
            fclose($stream);
        }
        fwrite(STDERR, 'Real grocery snapshot checked: '.json_encode($r['report'], JSON_UNESCAPED_UNICODE)."\n");
    }
}
