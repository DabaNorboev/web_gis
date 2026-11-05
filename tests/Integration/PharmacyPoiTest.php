<?php

namespace Tests\Integration;

use App\Services\Analysis\GroceryPoiProvider;
use App\Services\Analysis\PharmacyPoiProvider;
use App\Services\Osm\Import\OsmGroceryImporter;
use App\Services\Osm\Import\OsmPharmacyImporter;
use App\Services\Osm\Import\OsmPharmacyReader;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\PostgisTestCase;

class PharmacyPoiTest extends PostgisTestCase
{
    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();
        $this->artisan('migrate', ['--force' => true])->assertSuccessful();
        DB::beginTransaction();
        DB::table('dataset_imports')->whereIn('dataset_key', ['grocery', 'pharmacy'])->update(['is_active' => false]);
        $this->directory = sys_get_temp_dir().'/pharmacy-test-'.bin2hex(random_bytes(6));
        mkdir($this->directory);
        file_put_contents($this->directory.'/boundary.json', json_encode(['type' => 'Polygon', 'coordinates' => [[[92, 55], [94, 55], [94, 57], [92, 57], [92, 55]]]]));
    }

    protected function tearDown(): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        foreach (glob($this->directory.'/*') as $file) {
            unlink($file);
        }
        rmdir($this->directory);
        parent::tearDown();
    }

    private function node(int $id, array $tags = [], float $lon = 93, float $lat = 56): array
    {
        return ['type' => 'node', 'id' => $id, 'lon' => $lon, 'lat' => $lat, 'tags' => $tags + ['amenity' => 'pharmacy']];
    }

    private function document(array $rows, string $category = 'pharmacy'): array
    {
        $ring = json_decode(file_get_contents($this->directory.'/boundary.json'), true);
        $counts = ['node' => 0, 'way' => 0, 'relation' => 0];
        $outcomes = [];
        foreach ($rows as $row) {
            $counts[$row['type']]++;
            if ($row['type'] === 'relation') {
                $outcomes[] = ['source_id' => 'osm:relation:'.$row['id'], 'status' => 'emitted'];
            }
        }

        return ['elements' => $rows, 'preparation' => ['schema_version' => 2, 'dataset_key' => $category, 'categories' => [$category],
            'method' => 'complete_source_members_bbox_v2', 'object_types' => ['node', 'way', 'relation'],
            'rules' => $category === 'pharmacy' ? ['pharmacy' => ['amenity' => ['pharmacy']]] : ['grocery' => ['shop' => ['supermarket', 'convenience']]],
            'pbf_sha256' => hash('sha256', 'fixture'), 'script_sha256' => hash('sha256', 'fixture-script'),
            'common_script_sha256' => hash('sha256', 'fixture-common'), 'retail_script_sha256' => hash('sha256', 'fixture-retail'),
            'boundary_sha256' => hash_file('sha256', $this->directory.'/boundary.json'), 'bbox' => [92, 55, 94, 57],
            'extraction_geometry' => $ring, 'emitted_counts' => $counts, 'relation_audit' => ['selected_count' => count($outcomes), 'outcomes' => $outcomes]]];
    }

    private function import(array $document, string $category = 'pharmacy'): array
    {
        $file = $this->directory.'/'.$category.'.json';
        file_put_contents($file, json_encode($document));

        return app($category === 'pharmacy' ? OsmPharmacyImporter::class : OsmGroceryImporter::class)->import($file, $this->directory.'/boundary.json');
    }

    private function response(float $lon = 93, int $radius = 200): array
    {
        return $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'point', 'lon' => $lon, 'lat' => 56], 'radius_m' => $radius, 'blocks' => ['poi']])->assertOk()->json();
    }

    public function test_retail_rules_unknown_fields_zero_missing_and_independent_grocery(): void
    {
        $reader = app(OsmPharmacyReader::class);
        $rows = [$this->node(1), $this->node(2, ['dispensing' => 'no']), $this->node(3, ['access' => 'private']),
            $this->node(4, ['disused:amenity' => 'pharmacy']), $this->node(5, ['closed:healthcare' => 'pharmacy']),
            $this->node(6, ['access' => 'no']), $this->node(7, ['amenity' => 'doctors', 'healthcare' => 'pharmacy']),
            ['type' => 'node', 'id' => 8, 'lon' => 93, 'lat' => 56, 'tags' => ['shop' => 'chemist']]];
        $this->assertSame(['osm:node:1', 'osm:node:2'], array_column($reader->rows(['elements' => $rows]), 'source_id'));
        $grocery = $this->import($this->document([$this->node(100, ['shop' => 'convenience'])], 'grocery'), 'grocery');
        $before = $this->response()['blocks']['poi'];
        $this->assertSame('READY', $before['status']);
        $this->assertSame('UNAVAILABLE', $before['availability_by_category']['pharmacy']['status']);
        $this->assertNull($before['data']['counts_by_category']['pharmacy']);
        $this->import($this->document(array_slice($rows, 0, 6)));
        $poi = $this->response()['blocks']['poi'];
        $this->assertSame(['grocery' => 1, 'pharmacy' => 2, 'official_stop' => null, 'park' => null], $poi['data']['counts_by_category']);
        $this->assertSame($grocery['import_id'], DB::table('dataset_imports')->where('dataset_key', 'grocery')->where('is_active', true)->value('id'));
        $item = collect($poi['data']['items'])->firstWhere('category', 'pharmacy');
        foreach (['name', 'address', 'observed_at', 'source_updated_at', 'access'] as $key) {
            $this->assertNull($item[$key]);
        }
        $zero = $this->response(93.1)['blocks']['poi'];
        $this->assertSame(0, $zero['data']['counts_by_category']['pharmacy']);
        $partial = $this->response(92.0001, 1000)['blocks']['poi'];
        $this->assertSame('PARTIAL', $partial['coverage']['by_category']['pharmacy']['status']);
        $this->assertNull($partial['data']['counts_by_category']['pharmacy']);
    }

    public function test_geography_boundaries_full_polygon_structural_alias_and_uncertain_identity(): void
    {
        $rows = [$this->node(1)];
        foreach ([200, 200.001, 1000, 1000.001] as $i => $distance) {
            $p = DB::selectOne('SELECT ST_AsGeoJSON(ST_Project(ST_SetSRID(ST_MakePoint(93,56),4326)::geography,?::double precision,0::double precision)::geometry,15) AS point', [$distance]);
            [$lon,$lat] = json_decode($p->point, true)['coordinates'];
            $rows[] = $this->node(10 + $i, [], $lon, $lat);
        }
        $geometry = array_map(fn ($p) => ['lon' => $p[0], 'lat' => $p[1]], [[92.999, 55.9999], [93.1, 55.9999], [93.1, 56.0001], [92.999, 56.0001], [92.999, 55.9999]]);
        $rows[] = ['type' => 'way', 'id' => 20, 'tags' => ['amenity' => 'pharmacy'], 'geometry' => $geometry];
        $rows[] = ['type' => 'relation', 'id' => 30, 'tags' => ['amenity' => 'pharmacy', 'type' => 'multipolygon'], 'members' => [['type' => 'way', 'ref' => 20, 'role' => 'outer', 'geometry' => $geometry]]];
        $report = $this->import($this->document($rows));
        $this->assertCount(1, $report['report']['duplicate_representations']);
        $this->assertNotEmpty($report['report']['possible_duplicates']);
        $a = $this->response()['blocks']['poi']['data']['items'];
        $this->assertContains('osm:node:10', array_column($a, 'id'));
        $this->assertNotContains('osm:node:11', array_column($a, 'id'));
        $polygon = collect($a)->firstWhere('id', 'osm:relation:30');
        $this->assertSame(0.0, (float) $polygon['distance_m']);
        $this->assertNotNull($polygon['identity_note']);
        $this->assertGreaterThan(93.01, $polygon['point']['lon']);
        $b = $this->response(93, 1000)['blocks']['poi']['data']['items'];
        $this->assertContains('osm:node:12', array_column($b, 'id'));
        $this->assertNotContains('osm:node:13', array_column($b, 'id'));
    }

    public function test_scope_rules_and_unresolved_relations_never_replace_valid_snapshot(): void
    {
        $document = $this->document([$this->node(1)]);
        $first = $this->import($document);
        $bad = [];
        $bad[] = array_replace_recursive($document, ['preparation' => ['rules' => ['pharmacy' => ['amenity' => ['doctors']]]]]);
        $narrow = $document;
        $narrow['preparation']['extraction_geometry'] = ['type' => 'Polygon', 'coordinates' => [[[92, 55], [93, 55], [93, 57], [92, 57], [92, 55]]]];
        $narrow['preparation']['bbox'] = [92, 55, 93, 57];
        $bad[] = $narrow;
        $unknown = $document;
        $unknown['preparation']['method'] = 'unknown';
        $bad[] = $unknown;
        $missing = $document;
        unset($missing['preparation']['retail_script_sha256']);
        $bad[] = $missing;
        $rejected = $document;
        $rejected['preparation']['relation_audit'] = ['selected_count' => 1, 'outcomes' => [['source_id' => 'osm:relation:88', 'status' => 'rejected', 'reason' => 'unsupported_node_or_nested_member']]];
        $bad[] = $rejected;
        foreach ($bad as $input) {
            try {
                $this->import($input);
                $this->fail('Invalid scope admitted');
            } catch (RuntimeException $error) {
                $this->assertNotEmpty($error->getMessage());
            }
            $this->assertSame($first['import_id'], DB::table('dataset_imports')->where('dataset_key', 'pharmacy')->where('is_active', true)->value('id'));
        }
    }

    public function test_category_failures_do_not_hide_other_category_or_leak_exception(): void
    {
        $this->import($this->document([$this->node(1)]));
        $this->mock(GroceryPoiProvider::class, fn ($mock) => $mock->shouldReceive('analyze')->andThrow(new RuntimeException('PRIVATE_PHARMACY_CANARY')));
        $poi = $this->response()['blocks']['poi'];
        $this->assertSame('READY', $poi['status']);
        $this->assertSame(1, $poi['data']['counts_by_category']['pharmacy']);
        $this->assertSame('ERROR', $poi['availability_by_category']['grocery']['status']);
        $this->assertStringNotContainsString('PRIVATE_PHARMACY_CANARY', json_encode($poi));
    }

    public function test_pharmacy_failure_preserves_grocery(): void
    {
        $this->import($this->document([$this->node(100, ['shop' => 'convenience'])], 'grocery'), 'grocery');
        $this->mock(PharmacyPoiProvider::class, fn ($mock) => $mock->shouldReceive('analyze')->andThrow(new RuntimeException('PRIVATE_PHARMACY_CANARY')));
        $poi = $this->response()['blocks']['poi'];
        $this->assertSame('READY', $poi['status']);
        $this->assertSame(1, $poi['data']['counts_by_category']['grocery']);
        $this->assertNull($poi['data']['counts_by_category']['pharmacy']);
        $this->assertSame('ERROR', $poi['availability_by_category']['pharmacy']['status']);
        $this->assertStringNotContainsString('PRIVATE_PHARMACY_CANARY', json_encode($poi));
    }

    public function test_late_pharmacy_activation_failure_preserves_both_snapshots(): void
    {
        $grocery = $this->import($this->document([$this->node(100, ['shop' => 'supermarket'])], 'grocery'), 'grocery');
        $first = $this->import($this->document([$this->node(1)]));
        $id = (int) $first['import_id'];
        DB::unprepared("CREATE FUNCTION pharmacy_test_reject_activation() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.is_active AND NEW.id<>$id AND NEW.dataset_key='pharmacy' THEN
                    IF EXISTS (SELECT 1 FROM dataset_imports WHERE id=$id AND is_active)
                        OR NOT EXISTS (SELECT 1 FROM osm_pharmacy WHERE dataset_import_id=NEW.id)
                        OR NOT EXISTS (SELECT 1 FROM dataset_coverages WHERE dataset_import_id=NEW.id) THEN
                        RAISE EXCEPTION 'activation failure was not late';
                    END IF;
                    RAISE EXCEPTION 'synthetic late pharmacy activation failure';
                END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER pharmacy_test_activation BEFORE UPDATE ON dataset_imports FOR EACH ROW EXECUTE FUNCTION pharmacy_test_reject_activation()");
        try {
            $this->import($this->document([$this->node(2)]));
            $this->fail('Activation should fail');
        } catch (QueryException $error) {
            $this->assertStringContainsString('synthetic late pharmacy activation failure', $error->getMessage());
        }
        $this->assertSame($id, DB::table('dataset_imports')->where('dataset_key', 'pharmacy')->where('is_active', true)->value('id'));
        $this->assertSame($grocery['import_id'], DB::table('dataset_imports')->where('dataset_key', 'grocery')->where('is_active', true)->value('id'));
        $this->assertSame(['osm:node:1'], DB::table('osm_pharmacy')->where('dataset_import_id', $id)->pluck('source_id')->all());
        $this->assertTrue(DB::table('dataset_coverages')->where('dataset_import_id', $id)->exists());
    }

    public function test_same_osm_id_is_one_object_with_explicit_pharmacy_precedence(): void
    {
        $row = $this->node(1, ['shop' => 'convenience']);
        $this->import($this->document([$row], 'grocery'), 'grocery');
        $this->import($this->document([$row]));
        $poi = $this->response()['blocks']['poi'];
        $this->assertCount(1, $poi['data']['items']);
        $this->assertSame('pharmacy', $poi['data']['items'][0]['category']);
        $this->assertSame(0, $poi['data']['counts_by_category']['grocery']);
    }

    public function test_prepared_local_pharmacy_file_in_rolled_back_test_database(): void
    {
        if (! ($file = getenv('A8_PHARMACY_FILE'))) {
            $this->markTestSkipped('Explicit local pharmacy fixture required.');
        }
        $boundary = base_path('data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson');
        $grocery = app(OsmGroceryImporter::class)->import(base_path('data/prepared/grocery/a8-scope-v2-20261104-01/grocery.json'), $boundary);
        $before = DB::table('osm_grocery')->where('dataset_import_id', $grocery['import_id'])->count();
        $result = app(OsmPharmacyImporter::class)->import($file, $boundary);
        $this->assertSame(663, $before);
        $this->assertSame($before, DB::table('osm_grocery')->where('dataset_import_id', $grocery['import_id'])->count());
        $this->assertSame($grocery['import_id'], DB::table('dataset_imports')->where('dataset_key', 'grocery')->where('is_active', true)->value('id'));
        // Manual source review anchors: unknown label, named/addressed node,
        // ordinary brand, OTC-only polygon and named retail building.
        $anchors = ['osm:node:618553419', 'osm:node:708811103', 'osm:node:827612883', 'osm:way:193247571', 'osm:way:310061222'];
        $sourceRows = app(OsmPharmacyReader::class)->rows(app(OsmPharmacyReader::class)->read(file_get_contents($file)));
        foreach ($anchors as $sourceId) {
            $source = collect($sourceRows)->firstWhere('source_id', $sourceId);
            $saved = DB::table('osm_pharmacy')->where('dataset_import_id', $result['import_id'])->where('source_id', $sourceId)->first();
            $this->assertNotNull($saved, $sourceId);
            $this->assertSame($source['name'], $saved->name);
            $this->assertSame($source['address'], $saved->address);
            $same = DB::selectOne('SELECT ST_Equals(geom,ST_GeomFromGeoJSON(?)) ok FROM osm_pharmacy WHERE dataset_import_id=? AND source_id=?', [json_encode($source['geometry']), $result['import_id'], $sourceId]);
            $this->assertTrue($same->ok);
        }
        $row = DB::selectOne('SELECT ST_X(ST_PointOnSurface(geom)) lon,ST_Y(ST_PointOnSurface(geom)) lat FROM osm_pharmacy WHERE dataset_import_id=? ORDER BY source_id LIMIT 1', [$result['import_id']]);
        foreach ([200, 1000] as $radius) {
            $request = ['place' => ['kind' => 'point', 'lon' => (float) $row->lon, 'lat' => (float) $row->lat], 'radius_m' => $radius, 'blocks' => ['poi']];
            $response = $this->postJson('/api/v1/place-analysis', $request)->assertOk()->json();
            $this->assertSame('READY', $response['blocks']['poi']['status']);
            $this->assertNotEmpty(array_filter($response['blocks']['poi']['data']['items'], fn ($item) => $item['category'] === 'pharmacy'));
            if ($dir = getenv('A8_PHARMACY_QA_DIR')) {
                $stream = fopen($dir.'/test-api-'.$radius.'.json', 'x');
                fwrite($stream, json_encode(['environment' => 'web_gis_test_rolled_back', 'request' => $request, 'response' => $response], JSON_UNESCAPED_UNICODE));
                fclose($stream);
            }
        }
        if ($dir = getenv('A8_PHARMACY_QA_DIR')) {
            $stream = fopen($dir.'/test-import-report.json', 'x');
            fwrite($stream, json_encode($result, JSON_UNESCAPED_UNICODE));
            fclose($stream);
        }
    }
}
