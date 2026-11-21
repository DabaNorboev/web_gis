<?php

namespace Tests\Feature;

use App\Services\Analysis\RetailPoiProvider;
use App\Services\Analysis\SatelliteProvider;
use App\Services\Gis\AnalysisArea;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Symfony\Component\Process\Process;
use Tests\TestCase;

class AirSnapshotApiTest extends TestCase
{
    private const POINT = ['place' => ['kind' => 'point', 'lon' => 0.12, 'lat' => 0.23]];

    private string $root;

    protected function setUp(): void
    {
        parent::setUp();

        $this->assertSame('sqlite', config('database.default'));
        $this->assertSame(':memory:', config('database.connections.sqlite.database'));
        $this->assertEmpty(config('database.connections.sqlite.url'));
        $this->assertSame('array', config('cache.default'));
        $this->root = sys_get_temp_dir().'/placelens-air-'.bin2hex(random_bytes(12));
        File::makeDirectory($this->root, 0700);
        config(['air.root' => $this->root]);
        Http::preventStrayRequests();
        $this->mock(AnalysisArea::class, fn ($mock) => $mock->shouldReceive('forPoint')->andReturn([
            'analysis_area' => ['type' => 'Polygon', 'coordinates' => [[[0, 0], [1, 0], [1, 1], [0, 0]]]],
            'analysis_bounds' => [0, 0, 1, 1],
        ]));
    }

    protected function tearDown(): void
    {
        if (isset($this->root)) {
            File::deleteDirectory($this->root);
        }
        parent::tearDown();
    }

    public function test_pinned_a11_snapshot_survives_the_php_api_with_literal_times_and_values(): void
    {
        $input = base_path('tests/Fixtures/air/a11-1-v1');
        $output = $this->root.'/releases/a11';
        $this->python('scripts/air/import-snapshot.py', '--input', $input, '--output', $output);
        $version = hash_file('sha256', $output.'/manifest.json');
        rename($output, $this->root.'/releases/'.$version);
        touch($this->root.'/.publish.lock');
        File::put($this->root.'/active.json', json_encode([
            'snapshot_version' => $version, 'last_success_at' => '2026-11-20T06:30:00Z',
            'last_observed_at_raw' => '2026-08-15 23:00:00',
        ], JSON_THROW_ON_ERROR));

        $request = self::POINT + ['blocks' => ['air'], 'stations' => ['selected_ids' => ['4228', 'unknown']]];
        $summary = $this->postJson('/api/v1/place-analysis', $request)->assertOk()
            ->assertJsonPath('blocks.air.status', 'READY')->assertJsonPath('blocks.air.data.snapshot_version', $version)
            ->assertJsonPath('blocks.air.data.missing_selected_ids', ['unknown'])
            ->assertJsonPath('blocks.air.data.counts', ['selected' => 1, 'unlocated' => 2])
            ->assertJsonPath('blocks.air.data.freshness', 'UNKNOWN')
            ->assertJsonCount(3, 'blocks.air.data.stations')->json();
        $raw = json_decode(File::get($input.'/raw/air-2026-week.json'), true, flags: JSON_THROW_ON_ERROR)['data'];
        $catalog = array_column(json_decode(File::get($input.'/raw/air-project9-api.json'), true, flags: JSON_THROW_ON_ERROR)['data']['sites'], null, 'id');
        $histories = [];
        $zeros = 0;
        foreach ($summary['blocks']['air']['data']['stations'] as $station) {
            $id = $station['id'];
            $this->assertSame([$catalog[$id]['geom_x'], $catalog[$id]['geom_y']], [$station['lon'], $station['lat']]);
            $this->assertSame('EPSG:4326', $station['crs']);
            $this->assertSame('A11_OPERATOR_MAP_INTERPRETATION', $station['coordinate_reason']);
            $this->assertSame(['raw_file' => 'raw/air-project9-api.json', 'source_id' => $id], $station['coordinate_provenance']);
            $this->assertNull($station['distance_m']);
            $this->assertSame('2026-08-15 23:00:00', $station['history']['last_observed_at_raw']);
            $history = $this->getJson($this->historyPath($version, $id))->assertOk()->assertJsonCount(168, 'rows')
                ->assertJsonPath('station_id', $id)->assertJsonPath('timezone', null)->assertJsonPath('freshness', 'UNKNOWN')->json();
            $expected = array_values(array_filter($raw, fn ($row) => (string) $row['site'] === $id));
            foreach ($history['rows'] as $index => $row) {
                $this->assertSame($expected[$index]['time'], $row['observed_at_raw']);
                $this->assertEquals($expected[$index]['pm25'], $row['value']);
                $this->assertSame('UNKNOWN', $row['qc']);
                $this->assertNull($row['observed_at_utc']);
                $zeros += $row['value'] === 0 ? 1 : 0;
            }
            $histories[] = $history;
        }
        $this->assertSame(10, $zeros);
        $this->exchange('a11', compact('request', 'summary', 'histories'));

        $folder = $this->root.'/releases/'.$version;
        $catalogPath = $folder.'/input/raw/air-project9-api.json';
        File::append($catalogPath, 'damage');
        $this->postJson('/api/v1/place-analysis', $request)->assertOk()
            ->assertJsonPath('blocks.air.data.stations.0.lon', null)
            ->assertJsonPath('blocks.air.data.stations.0.coordinate_reason', 'SOURCE_DATUM_CRS_UNCONFIRMED');
        $this->getJson($this->historyPath($version, '3846'))->assertOk()->assertJsonCount(168, 'rows');
        File::copy($input.'/raw/air-project9-api.json', $catalogPath);

        // Even the same IDs and coordinates need approval for another input.
        $manifest = json_decode(File::get($folder.'/manifest.json'), true, flags: JSON_THROW_ON_ERROR);
        $manifest['input_manifest_sha256'] = str_repeat('a', 64);
        File::put($folder.'/manifest.json', json_encode($manifest, JSON_THROW_ON_ERROR));
        $otherVersion = hash_file('sha256', $folder.'/manifest.json');
        rename($folder, $this->root.'/releases/'.$otherVersion);
        $active = json_decode(File::get($this->root.'/active.json'), true, flags: JSON_THROW_ON_ERROR);
        $active['snapshot_version'] = $otherVersion;
        File::put($this->root.'/active.json', json_encode($active, JSON_THROW_ON_ERROR));
        $this->postJson('/api/v1/place-analysis', $request)->assertOk()
            ->assertJsonPath('blocks.air.data.snapshot_version', $otherVersion)
            ->assertJsonPath('blocks.air.data.stations.0.lon', null)
            ->assertJsonPath('blocks.air.data.stations.0.lat', null)
            ->assertJsonPath('blocks.air.data.stations.0.coordinate_reason', 'SOURCE_DATUM_CRS_UNCONFIRMED');
    }

    public function test_synthetic_history_and_independent_blocks_before_and_after_a_failed_publish(): void
    {
        $this->mock(RetailPoiProvider::class, fn ($mock) => $mock->shouldReceive('analyze')->andReturn(['status' => 'READY']));
        $this->mock(SatelliteProvider::class, fn ($mock) => $mock->shouldReceive('analyze')->andReturn(['status' => 'READY']));
        $this->postJson('/api/v1/place-analysis', self::POINT)->assertOk()
            ->assertJsonPath('blocks.air.code', 'AIR_SOURCE_UNAVAILABLE')
            ->assertJsonPath('blocks.poi.status', 'READY')->assertJsonPath('blocks.satellite.status', 'READY');

        $this->python('tests/air/test_refresh.py', 'publish-fixture', $this->root);
        $request = self::POINT + ['blocks' => ['air'], 'stations' => ['selected_ids' => ['1001']]];
        $summary = $this->postJson('/api/v1/place-analysis', $request)->assertOk()
            ->assertJsonPath('blocks.air.data.stations.0.lon', null)
            ->assertJsonPath('blocks.air.data.stations.0.lat', null)
            ->assertJsonPath('blocks.air.data.stations.0.coordinate_reason', 'SOURCE_DATUM_CRS_UNCONFIRMED')
            ->assertJsonPath('blocks.air.data.stations.0.history.missing_hour_bins', 1)
            ->assertJsonPath('blocks.air.data.stations.0.history.null_values', 2)
            ->assertJsonPath('blocks.air.data.stations.1.latest', null)->json();
        $version = $summary['blocks']['air']['data']['snapshot_version'];
        $path = $this->historyPath($version, '1001');
        $history = $this->getJson($path)->assertOk()->assertHeader('Cache-Control', 'no-store, private')
            ->assertHeader('Referrer-Policy', 'no-referrer')->assertJsonCount(4, 'rows')
            ->assertJsonPath('rows.0.value', 0)->assertJsonPath('rows.0.missing_reason', null)
            ->assertJsonPath('rows.1.row_present', true)->assertJsonPath('rows.1.value', null)
            ->assertJsonPath('rows.1.missing_reason', 'SOURCE_VALUE_NULL_OR_ABSENT')
            ->assertJsonPath('rows.2.row_present', false)->assertJsonPath('rows.2.value', null)
            ->assertJsonPath('rows.2.missing_reason', 'SOURCE_ROW_MISSING')
            ->assertJsonPath('rows.3.row_present', true)->assertJsonPath('rows.3.value', null)
            ->assertJsonPath('rows.3.qc', 'UNKNOWN')->json();
        $this->getJson($this->historyPath($version, '1002'))->assertOk()->assertJsonCount(4, 'rows')
            ->assertJsonPath('rows.3.missing_reason', 'SOURCE_ROW_MISSING');
        $this->getJson($this->historyPath($version, '1003'))->assertNotFound()->assertJsonPath('code', 'AIR_STATION_NOT_FOUND');
        $this->getJson($this->historyPath(str_repeat('c', 64), '1001'))->assertStatus(409)->assertJsonPath('code', 'AIR_SNAPSHOT_CHANGED');

        $this->python('tests/air/test_refresh.py', 'fail-publication', $this->root);
        $this->getJson($path)->assertOk()->assertExactJson($history);
        $this->postJson('/api/v1/place-analysis', self::POINT)->assertOk()
            ->assertJsonPath('blocks.air.data.snapshot_version', $version)
            ->assertJsonPath('blocks.poi.status', 'READY')->assertJsonPath('blocks.satellite.status', 'READY');
        $histories = [$history];
        $this->exchange('synthetic', compact('request', 'summary', 'histories'));

        File::append($this->root.'/releases/'.$version.'/observations.jsonl', 'damage');
        $this->getJson($path)->assertStatus(503)->assertJsonPath('code', 'AIR_SOURCE_UNAVAILABLE');
        $this->postJson('/api/v1/place-analysis', self::POINT)->assertOk()
            ->assertJsonPath('blocks.air.status', 'UNAVAILABLE')->assertJsonPath('blocks.air.code', 'AIR_SOURCE_UNAVAILABLE')
            ->assertJsonPath('blocks.poi.status', 'READY')->assertJsonPath('blocks.satellite.status', 'READY');
        $summary = $this->postJson('/api/v1/place-analysis', $request)->assertOk()
            ->assertJsonPath('blocks.air.status', 'UNAVAILABLE')->json();
        $histories = [];
        $this->exchange('unavailable', compact('request', 'summary', 'histories'));
        Http::assertNothingSent();
    }

    private function historyPath(string $version, string $station): string
    {
        return "/api/v1/air/snapshots/$version/stations/$station/history";
    }

    private function python(string ...$arguments): void
    {
        $process = new Process(['python3', '-B', ...$arguments], base_path(), timeout: 30);
        $process->mustRun();
    }

    private function exchange(string $name, array $payload): void
    {
        if ($directory = getenv('AIR_API_TEST_EXCHANGE')) {
            $this->assertDirectoryExists($directory);
            File::put($directory.'/'.$name.'.json', json_encode($payload, JSON_THROW_ON_ERROR));
        }
    }
}
