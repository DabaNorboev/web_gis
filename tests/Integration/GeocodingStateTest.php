<?php

namespace Tests\Integration;

use App\Services\Geocoding\GeoapifyTransport;
use App\Services\Geocoding\GeocodingFailure;
use App\Services\Geocoding\GeocodingScope;
use App\Services\Geocoding\GeocodingState;
use App\Services\Geocoding\GeocodingTokens;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Tests\PostgisTestCase;
use Tests\Support\Geocoding\Fixtures;

class GeocodingStateTest extends PostgisTestCase
{
    use Fixtures;

    private string $schema;

    protected function setUp(): void
    {
        parent::setUp(); // Existing web_gis_test configuration/database/mode guards BEFORE any DDL.
        config(['app.key' => 'base64:'.base64_encode(str_repeat('a', 32)), 'geocoding.api_key' => 'synthetic']);
        $this->schema = 'g3_'.bin2hex(random_bytes(8));
        DB::statement('CREATE SCHEMA '.$this->schema);
        DB::statement('SET search_path TO '.$this->schema.',public');
        config(['database.connections.pgsql.search_path' => $this->schema.',public']);
        (require database_path('migrations/2026_11_15_000001_create_geocoding_state.php'))->up();
    }

    protected function tearDown(): void
    {
        DB::statement('SET search_path TO public');
        DB::statement('DROP SCHEMA '.$this->schema.' CASCADE');
        parent::tearDown();
    }

    private function rejects(string $code, callable $operation): void
    {
        try {
            $operation();
            $this->fail('Expected protection');
        } catch (GeocodingFailure $e) {
            $this->assertSame($code, $e->errorCode);
        }
    }

    public function test_real_boundary_covers_outer_and_hole_edges_without_changing_session_timeouts(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'g3-scope-');
        file_put_contents($file, '{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[4,4],[6,4],[6,6],[4,6],[4,4]]]}');
        config(['geocoding.scope_path' => $file, 'geocoding.scope_sha256' => hash_file('sha256', $file)]);
        try {
            $scope = new GeocodingScope;
            $before = DB::selectOne("SELECT current_setting('statement_timeout') AS s,current_setting('lock_timeout') AS l");
            foreach ([[0, 5, true], [1, 1, true], [4, 5, true], [5, 5, false], [-1, 5, false]] as [$lon, $lat, $expected]) {
                $this->assertSame($expected, $scope->covers(compact('lon', 'lat')));
            }
            $this->assertEquals($before, DB::selectOne("SELECT current_setting('statement_timeout') AS s,current_setting('lock_timeout') AS l"));
            config(['geocoding.scope_sha256' => str_repeat('0', 64)]);
            $this->rejects('GEOCODING_UNAVAILABLE', fn () => (new GeocodingScope)->bounds());
            config(['geocoding.scope_path' => $file.'-missing']);
            $this->rejects('GEOCODING_UNAVAILABLE', fn () => (new GeocodingScope)->bounds());
        } finally {
            unlink($file);
        }
    }

    public function test_cache_encryption_ttls_size_eviction_and_selection_independence(): void
    {
        $this->scopeFixture();
        $state = new GeocodingState;
        $tokens = app(GeocodingTokens::class);
        $candidate = $this->candidateFixture();
        $chosen = $tokens->confirm($tokens->candidate($candidate)['candidate_token']);
        $state->put('synthetic', ['data' => $candidate], 300);
        $r = DB::table('geocoding_cache')->first();
        $this->assertStringNotContainsString('Синтетическая', $r->value);
        $this->assertSame($candidate, $state->cached('synthetic')['data']);
        $this->assertEquals($r->expires_at, DB::table('geocoding_cache')->first()->expires_at);
        $state->put('large', ['data' => str_repeat('a', 32768)], 300);
        $this->assertNull($state->cached('large'));
        // Force both count and byte overflow using synthetic rows, then test real atomic eviction.
        DB::statement("INSERT INTO geocoding_cache SELECT 'fixture-'||n,repeat('x',4000),4000,0,253402300799 FROM generate_series(1,5001) n");
        $state->put('newest', ['data' => 'fresh'], 60);
        $this->assertLessThanOrEqual(5000, DB::table('geocoding_cache')->count());
        $this->assertLessThanOrEqual(16777216, (int) DB::table('geocoding_cache')->sum('bytes'));
        $this->assertSame(['data' => 'fresh'], $state->cached('newest'));
        DB::table('geocoding_cache')->update(['expires_at' => 0]);
        $this->assertNull($state->cached('synthetic'));
        $this->assertSame($chosen['place'], $tokens->selection($chosen['selection_token'])['place']);
        $a = $state->cacheKey('reverse', ['lon' => -0.0, 'lat' => 1], []);
        $this->assertSame($a, $state->cacheKey('reverse', ['lon' => 0.0, 'lat' => 1], []));
        $this->assertNotSame($a, $state->cacheKey('reverse', ['lon' => 0.00000000001, 'lat' => 1], []));
        $this->assertNotSame($state->cacheKey('search', ['q' => 'Мира 10/2', 'mode' => 'search'], []), $state->cacheKey('search', ['q' => 'Мира 10 к2', 'mode' => 'search'], []));
        $state->finish();
    }

    public function test_rates_shared_sessions_slots_start_spacing_quota_and_loss_fail_closed(): void
    {
        $clock = floor((float) DB::selectOne('SELECT extract(epoch FROM clock_timestamp()) AS t')->t / 60) * 60 + 1;
        $factory = fn () => new class($clock) extends GeocodingState
        {
            public function __construct(private float $clock) {}

            protected function time(): float
            {
                return $this->clock;
            }
        };
        $a = $factory();
        $b = $factory();
        for ($n = 0; $n < 30; $n++) {
            ($n % 2 ? $a : $b)->rate('synthetic-ip', false);
        }
        $this->rejects('RATE_LIMITED', fn () => $b->rate('synthetic-ip', false));
        for ($n = 0; $n < 60; $n++) {
            ($n % 2 ? $a : $b)->rate('synthetic-ip', true);
        }
        $this->rejects('RATE_LIMITED', fn () => $b->rate('synthetic-ip', true));
        $a->start('first');
        $this->rejects('GEOCODING_BUSY', fn () => $b->start('first'));
        $this->rejects('RATE_LIMITED', fn () => $b->start('second'));
        $a->alive();
        $a->finish();
        // No sleeps: expire only the synthetic inter-start record.
        DB::table('geocoding_guards')->where('key', 'last_start')->delete();
        $b->start('first');
        $this->assertSame(2.0, (float) DB::table('geocoding_guards')->where('key', 'like', 'day:%')->value('value'));
        // Simulate lost locks in a live process on its own dedicated session.
        $rp = new \ReflectionProperty(GeocodingState::class, 'pdo');
        $rp->getValue($b)->exec('SELECT pg_advisory_unlock_all()');
        $this->rejects('GEOCODING_UNAVAILABLE', fn () => $b->alive());
        $b->finish();
        DB::table('geocoding_guards')->where('key', 'last_start')->delete();
        config(['geocoding.daily_limit' => 2]);
        $this->rejects('GEOCODING_QUOTA_EXHAUSTED', fn () => $b->start('third'));
        config(['geocoding.daily_limit' => 2000]);
        $b->upstreamStatus(429, 90);
        $this->rejects('PROVIDER_RATE_LIMITED', fn () => $a->start('third'));
        DB::table('geocoding_guards')->where('key', 'cooldown')->delete();
        $this->assertSame(3600, $b->upstreamQuota());
        $this->rejects('GEOCODING_QUOTA_EXHAUSTED', fn () => $a->start('third'));
        DB::table('geocoding_guards')->where('key', 'quota_cooldown')->delete();
        $b->upstreamStatus(403, null);
        $this->rejects('GEOCODING_UNAVAILABLE', fn () => $a->start('third'));
        $b->finish();
        // Migration round trip only in our guarded synthetic schema.
        $migration = require database_path('migrations/2026_11_15_000001_create_geocoding_state.php');
        $migration->down();
        $this->assertFalse(Schema::hasTable('geocoding_cache'));
        $migration->up();
    }

    public function test_four_global_slots_and_no_transaction_held_during_transfer(): void
    {
        $workers = [];
        try {
            for ($i = 0; $i < 4; $i++) {
                DB::table('geocoding_guards')->where('key', 'last_start')->delete();
                $s = new GeocodingState;
                $s->start('worker-'.$i);
                $workers[] = $s;
                $pdo = (new \ReflectionProperty($s, 'pdo'))->getValue($s);
                $this->assertFalse($pdo->inTransaction());
            }
            $this->rejects('GEOCODING_BUSY', fn () => (new GeocodingState)->start('fifth'));
            $workers[0]->finish();
            DB::table('geocoding_guards')->where('key', 'last_start')->delete();
            $s = new GeocodingState;
            $s->start('fifth');
            $s->alive();
            $s->finish();
        } finally {
            foreach ($workers as $s) {
                $s->finish();
            }
        }
    }

    public function test_competing_php_workers_and_process_death_release_slots_without_refunding_quota(): void
    {
        $workers = [];
        try {
            for ($n = 0; $n < 6; $n++) {
                $env = array_merge(getenv(), ['G3_WORKER_DB' => json_encode(config('database.connections.pgsql'))]);
                $process = proc_open([PHP_BINARY, base_path('tests/Support/Geocoding/worker.php'), (string) $n],
                    [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'a']], $pipes, base_path(), $env);
                stream_set_timeout($pipes[1], 10);
                $this->assertSame("READY\n", fgets($pipes[1]));
                $workers[] = [$process, $pipes];
            }
            foreach ($workers as [$process, $pipes]) {
                fwrite($pipes[0], "GO\n");
                fflush($pipes[0]);
            }
            $admitted = 0;
            foreach ($workers as [$process, $pipes]) {
                $status = trim(fgets($pipes[1]));
                $this->assertContains($status, ['ADMITTED', 'RATE_LIMITED', 'GEOCODING_UNAVAILABLE', 'GEOCODING_BUSY', 'GEOCODING_QUOTA_EXHAUSTED']);
                $admitted += $status === 'ADMITTED' ? 1 : 0;
            }
            $this->assertSame(1, $admitted);
            $this->assertSame(1.0, (float) DB::table('geocoding_guards')->where('key', 'like', 'day:%')->value('value'));
        } finally {
            foreach ($workers as [$process, $pipes]) {
                proc_terminate($process, 9);
                foreach ($pipes as $pipe) {
                    fclose($pipe);
                }
                proc_close($process);
            }
        }
        DB::table('geocoding_guards')->where('key', 'last_start')->delete();
        config(['geocoding.daily_limit' => 1]);
        $this->rejects('GEOCODING_QUOTA_EXHAUSTED', fn () => (new GeocodingState)->start('synthetic-worker-0'));
        config(['geocoding.daily_limit' => 2000]);
        $state = new GeocodingState;
        $state->start('synthetic-worker-0');
        $state->alive();
        $state->finish();
    }

    public function test_client_disconnect_keeps_transfer_slot_until_curl_finishes(): void
    {
        $stall = stream_socket_server('tcp://127.0.0.1:0');
        $stallAddress = stream_socket_get_name($stall, false);
        $portProbe = stream_socket_server('tcp://127.0.0.1:0');
        $address = stream_socket_get_name($portProbe, false);
        fclose($portProbe);
        $marker = tempnam(sys_get_temp_dir(), 'g3-abort-');
        $env = array_merge(getenv(), ['G3_WORKER_DB' => json_encode(config('database.connections.pgsql')),
            'G3_ABORT_MARKER' => $marker, 'G3_ABORT_URL' => 'https://'.$stallAddress]);
        $process = proc_open([PHP_BINARY, '-S', $address, base_path('tests/Support/Geocoding/abort-router.php')],
            [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'a'], 2 => ['file', '/dev/null', 'a']], $pipes, base_path(), $env);
        try {
            $socket = false;
            for ($i = 0; $i < 100 && ! $socket; $i++) {
                $socket = @stream_socket_client('tcp://'.$address, $errno, $error, .05);
                if (! $socket) {
                    usleep(20000);
                }
            }
            $this->assertIsResource($socket);
            fwrite($socket, "GET /synthetic HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
            for ($i = 0; $i < 100 && file_get_contents($marker) !== 'admitted'; $i++) {
                usleep(10000);
            }
            $this->assertSame('admitted', file_get_contents($marker));
            fclose($socket); // Actual client disconnect while the cURL TLS transfer is still alive.
            $this->rejects('GEOCODING_BUSY', fn () => (new GeocodingState)->start('synthetic-abort-ip'));
            for ($i = 0; $i < 300 && file_get_contents($marker) !== 'finished'; $i++) {
                usleep(10000);
            }
            $this->assertSame('finished', file_get_contents($marker));
            $next = new GeocodingState;
            $next->start('synthetic-abort-ip');
            $next->alive();
            $next->finish();
            $this->assertSame(2.0, (float) DB::table('geocoding_guards')->where('key', 'like', 'day:%')->value('value'));
        } finally {
            proc_terminate($process, 9);
            foreach ($pipes as $pipe) {
                fclose($pipe);
            }
            proc_close($process);
            fclose($stall);
            unlink($marker);
        }
    }

    public function test_service_cache_ttl_reissues_tokens_without_source_refresh_and_errors_are_not_cached(): void
    {
        $this->scopeFixture();
        config(['geocoding.enabled' => true]);
        $this->mock(GeoapifyTransport::class, function ($m) {
            $m->shouldReceive('available')->andReturnTrue();
            $m->shouldReceive('request')->once()->with('autocomplete', \Mockery::on(fn ($p) => $p['filter'] === 'rect:0,0,10,10' && $p['limit'] === 5 && $p['lang'] === 'ru'), \Mockery::type(GeocodingState::class))->andReturn([$this->row(['district' => 'Условный район'])]);
        });
        $request = ['request_id' => (string) Str::uuid(), 'q' => 'Синтетическая 10/2А к3 стр4', 'mode' => 'autocomplete'];
        $a = $this->postJson('/api/v1/geocoding/search', $request)->assertOk()->assertJsonPath('meta.cache', 'MISS')->json();
        $this->assertSame('Условный район', $a['data']['candidates'][0]['components']['district']);
        $cacheRow = DB::table('geocoding_cache')->first();
        $this->assertSame(300, $cacheRow->expires_at - $cacheRow->created_at);
        $request['request_id'] = (string) Str::uuid();
        $b = $this->postJson('/api/v1/geocoding/search', $request)->assertOk()->assertJsonPath('meta.cache', 'HIT')->json();
        $this->assertSame('Условный район', $b['data']['candidates'][0]['components']['district']);
        $this->assertSame($a['meta']['received_at'], $b['meta']['received_at']);
        $this->assertSame($a['data']['candidates'][0]['candidate_id'], $b['data']['candidates'][0]['candidate_id']);
        $this->assertNotSame($a['data']['candidates'][0]['candidate_token'], $b['data']['candidates'][0]['candidate_token']);
        $this->assertSame($cacheRow->expires_at, DB::table('geocoding_cache')->first()->expires_at);
        $chosen = app(GeocodingTokens::class)->confirm($a['data']['candidates'][0]['candidate_token']);
        $this->assertSame('Условный район', $chosen['place']['address']['components']['district']);
        DB::table('geocoding_cache')->delete();
        $this->assertSame($chosen['place'], app(GeocodingTokens::class)->selection($chosen['selection_token'])['place']);
        $this->mock(GeoapifyTransport::class, function ($m) {
            $m->shouldReceive('available')->andReturnTrue();
            $m->shouldReceive('request')->once()->andThrow(new GeocodingFailure('PROVIDER_TIMEOUT', 504));
        });
        DB::table('geocoding_guards')->where('key', 'last_start')->delete();
        $request['request_id'] = (string) Str::uuid();
        $this->postJson('/api/v1/geocoding/search', $request)->assertStatus(504)->assertJsonPath('code', 'PROVIDER_TIMEOUT');
        $this->assertSame(0, DB::table('geocoding_cache')->count());
    }

    public function test_cache_without_display_district_can_still_confirm_and_reconfirm(): void
    {
        $this->scopeFixture();
        $this->mock(GeoapifyTransport::class, fn ($mock) => $mock->shouldNotReceive('request'));
        $request = ['request_id' => (string) Str::uuid(), 'q' => 'Синтетическая 10/2А к3 стр4', 'mode' => 'autocomplete'];
        $candidate = $this->candidateFixture();
        $state = app(GeocodingState::class);
        $state->put($state->cacheKey('search', $request, app(GeocodingScope::class)->identity()), [
            'data' => ['status' => 'OK', 'reason' => null, 'candidates' => [$candidate]],
            'received_at' => $candidate['source']['received_at'],
        ], 300);

        $response = $this->postJson('/api/v1/geocoding/search', $request)->assertOk()->assertJsonPath('meta.cache', 'HIT');
        $this->assertArrayNotHasKey('district', $response->json('data.candidates.0.components'));
        $tokens = app(GeocodingTokens::class);
        $selection = $tokens->confirm($response->json('data.candidates.0.candidate_token'));
        $this->assertSame($candidate['label'], $selection['place']['label']);
        $this->assertSame($candidate['components'], $selection['place']['address']['components']);
        $this->assertSame($selection['place'], $tokens->reconfirm($selection['selection_token'])['place']);
    }

    public function test_reverse_positive_empty_and_landmark_ttls_and_outside_scope_without_network(): void
    {
        $this->scopeFixture();
        config(['geocoding.enabled' => true]);
        $this->mock(GeoapifyTransport::class, function ($m) {
            $m->shouldReceive('available')->andReturnTrue();
            $m->shouldReceive('request')->times(3)->andReturnUsing(function ($mode) {
                $this->assertSame(0, DB::transactionLevel());
                static $calls = 0;

                return match (++$calls) {
                    1 => [$this->row()], 2 => [], default => [$this->row(['result_type' => 'street'])]
                };
            });
        });
        foreach ([3600, 60, 3600] as $i => $ttl) {
            DB::table('geocoding_cache')->delete();
            DB::table('geocoding_guards')->where('key', 'last_start')->delete();
            $r = $this->postJson('/api/v1/geocoding/reverse', ['request_id' => (string) Str::uuid(), 'lon' => 1.2, 'lat' => 2.3])
                ->assertOk()->assertJsonPath('data.point', ['lon' => 1.2, 'lat' => 2.3]);
            $c = DB::table('geocoding_cache')->first();
            $this->assertSame($ttl, $c->expires_at - $c->created_at);
            $r->assertJsonPath('data.status', ['OK', 'EMPTY', 'NO_SELECTABLE_RESULTS'][$i]);
            if ($i === 1) {
                $r->assertJsonPath('meta.received_at', null);
            }
        }
        $this->postJson('/api/v1/geocoding/reverse', ['request_id' => (string) Str::uuid(), 'lon' => -1.0, 'lat' => 2.3])
            ->assertOk()->assertJsonPath('data.reason', 'OUTSIDE_SCOPE')->assertJsonPath('meta.cache', 'NONE')->assertJsonPath('meta.received_at', null);
    }

    public function test_reverse_filters_provider_points_by_geography_before_cache_and_token_issue(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'g5-scope-');
        file_put_contents($file, '{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]]]}');
        config(['geocoding.enabled' => true, 'geocoding.scope_path' => $file, 'geocoding.scope_sha256' => hash_file('sha256', $file)]);
        $this->mock(GeoapifyTransport::class, function ($m) {
            $m->shouldReceive('available')->andReturn(true);
            $m->shouldReceive('request')->twice()->andReturn(
                [$this->row(['lon' => 1.2005]), $this->row(['lon' => 1.202]), $this->row(['lon' => null])],
                [$this->row(['lon' => 1.202]), $this->row(['lon' => null])]);
        });
        $input = ['request_id' => (string) Str::uuid(), 'lon' => 1.2, 'lat' => 2.3];
        try {
            $r = $this->postJson('/api/v1/geocoding/reverse', $input)->assertOk()
                ->assertJsonPath('data.point', ['lon' => 1.2, 'lat' => 2.3])->assertJsonPath('data.status', 'OK')
                ->assertJsonCount(1, 'data.candidates')->assertJsonPath('meta.cache', 'MISS');
            $distance = $r->json('data.candidates.0.reference_distance_m');
            $this->assertGreaterThan(50, $distance);
            $this->assertLessThan(60, $distance);
            $this->assertTrue($r->json('data.candidates.0.can_confirm'));
            $this->postJson('/api/v1/geocoding/confirm', ['request_id' => (string) Str::uuid(),
                'candidate_token' => $r->json('data.candidates.0.candidate_token'), 'position_confirmed' => true])
                ->assertOk()->assertJsonPath('data.place.point', $r->json('data.candidates.0.point'));
            $input['request_id'] = (string) Str::uuid();
            $this->postJson('/api/v1/geocoding/reverse', $input)->assertOk()->assertJsonPath('meta.cache', 'HIT')
                ->assertJsonCount(1, 'data.candidates')->assertJsonPath('data.candidates.0.reference_distance_m', $distance);
            DB::table('geocoding_cache')->delete();
            DB::table('geocoding_guards')->where('key', 'last_start')->delete();
            $input['request_id'] = (string) Str::uuid();
            $this->postJson('/api/v1/geocoding/reverse', $input)->assertOk()->assertJsonPath('data.status', 'EMPTY')
                ->assertJsonPath('data.reason', 'NO_NEARBY_RESULTS')->assertJsonCount(0, 'data.candidates');
            $cache = DB::table('geocoding_cache')->first();
            $this->assertSame(60, $cache->expires_at - $cache->created_at);
        } finally {
            unlink($file);
        }
    }

    public function test_guard_failure_rejects_network_admission_and_releases_all_slots(): void
    {
        Schema::drop('geocoding_guards');
        $state = new GeocodingState;
        $this->rejects('GEOCODING_UNAVAILABLE', fn () => $state->start('synthetic-failed-guard'));
        $this->rejects('GEOCODING_UNAVAILABLE', fn () => $state->rate('synthetic-failed-guard', false));
        $this->rejects('GEOCODING_UNAVAILABLE', fn () => $state->cached('synthetic'));
        $state->finish();
        $this->assertSame(0, (int) DB::selectOne("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND classid=170331::oid")->n);
    }
}
