<?php

namespace Tests\Integration;

use App\Services\Geocoding\GeocodingFailure;
use App\Services\Geocoding\GeocodingState;
use Illuminate\Support\Facades\DB;
use Tests\PostgisTestCase;

class GeocodingFpmRuntimeTest extends PostgisTestCase
{
    public function test_real_fpm_http_deadlines_completion_and_slot_release(): void
    {
        if (getenv('G3_FPM_HTTP') !== '1') {
            $this->markTestSkipped('Only the isolated network-none runtime harness starts FPM/nginx.');
        }
        config(['app.key' => 'base64:'.base64_encode(str_repeat('a', 32)), 'geocoding.api_key' => 'synthetic']);
        $schema = 'g3_fpm_'.bin2hex(random_bytes(8));
        DB::statement('CREATE SCHEMA '.$schema);
        DB::statement('SET search_path TO '.$schema.',public');
        config(['database.connections.pgsql.search_path' => $schema.',public']);
        (require database_path('migrations/2026_11_15_000001_create_geocoding_state.php'))->up();
        file_put_contents('/tmp/g3-fpm.conf', "[global]\nerror_log=/tmp/g3-fpm.log\n[www]\nuser=www\ngroup=www\nlisten=127.0.0.1:9000\npm=static\npm.max_children=2\nclear_env=no\nphp_admin_value[curl.cainfo]=/tmp/placelens-g3-ca.pem\n");
        $fpm = proc_open(['php-fpm', '-F', '-y', '/tmp/g3-fpm.conf'],
            [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/tmp/g3-fpm.log', 'a'], 2 => ['file', '/tmp/g3-fpm.log', 'a']], $pipes);
        try {
            for ($i = 0; $i < 100; $i++) {
                $ready = @fsockopen('127.0.0.1', 9000);
                if ($ready) {
                    fclose($ready);
                    break;
                }
                usleep(20000);
            }
            $this->assertIsResource($ready);
            foreach (['dns', 'connect', 'body', 'dns-abort'] as $mode) {
                $this->probe($mode);
            }
        } finally {
            proc_terminate($fpm);
            proc_close($fpm);
            DB::statement('SET search_path TO public');
            DB::statement('DROP SCHEMA '.$schema.' CASCADE');
        }
    }

    private function probe(string $mode): void
    {
        // Each case has fresh quota state; no production schema or session is used.
        DB::table('geocoding_guards')->delete();
        @unlink('/tmp/g3-fpm-marker.json');
        if (str_starts_with($mode, 'dns')) {
            $command = [PHP_BINARY, base_path('tests/Support/Geocoding/dns-sink.php')];
            $url = 'https://synthetic-dns-stall.invalid/';
        } else {
            // Reuse the transport suite's certificate generation without a second crypto setup.
            $command = [PHP_BINARY, base_path('tests/Support/Geocoding/tls-server.php'),
                '/tmp/placelens-g3-ca.pem', '/tmp/g3-fpm-key.pem', $mode];
        }
        $peer = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'a']], $pipes);
        $endpoint = trim(fgets($pipes[1]));
        if (str_starts_with($mode, 'dns')) {
            $this->assertSame('READY', $endpoint);
        } else {
            $this->assertMatchesRegularExpression('/^127\.0\.0\.1:\d+$/', $endpoint);
            $url = 'https://'.$endpoint.'/synthetic';
        }
        file_put_contents('/tmp/g3-fpm-input.json', json_encode(['database' => config('database.connections.pgsql'), 'url' => $url]));
        $socket = stream_socket_client('tcp://127.0.0.1:8080', $errno, $error, 1);
        $start = hrtime(true);
        fwrite($socket, "GET /synthetic HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        try {
            $marker = [];
            for ($i = 0; $i < 100; $i++) {
                $marker = $this->marker();
                if (($marker['phase'] ?? '') === 'admitted') {
                    break;
                }
                usleep(10000);
            }
            $this->assertSame('admitted', $marker['phase'] ?? null);
            $this->assertSame(2, $this->locks());
            try {
                (new GeocodingState)->start('synthetic-fpm-ip');
                $this->fail('FPM must retain its slot while transfer runs');
            } catch (GeocodingFailure $e) {
                $this->assertSame('GEOCODING_BUSY', $e->errorCode);
            }
            if ($mode === 'dns-abort') {
                fclose($socket);
            } else {
                stream_set_timeout($socket, 10);
                $response = stream_get_contents($socket);
                $this->assertStringContainsString('200 OK', $response);
                $this->assertStringContainsString('PROVIDER_TIMEOUT', $response);
                fclose($socket);
            }
            for ($i = 0; $i < 1000; $i++) {
                $marker = $this->marker();
                if (($marker['phase'] ?? '') === 'finished') {
                    break;
                }
                usleep(10000);
            }
            $elapsed = (hrtime(true) - $start) / 1e9;
            $this->assertSame('finished', $marker['phase'] ?? null);
            $this->assertSame('fpm-fcgi', $marker['sapi']);
            $this->assertNotEmpty($marker['ares']);
            $this->assertSame('PROVIDER_TIMEOUT', $marker['code']);
            $min = $mode === 'body' ? 7.5 : 1.7;
            $max = $mode === 'body' ? 9.5 : 3.5;
            $this->assertGreaterThanOrEqual($min, $marker['seconds']);
            $this->assertLessThan($max, $marker['seconds']);
            $this->assertLessThan($max, $elapsed);
            $this->assertSame(0, $this->locks());
            $next = new GeocodingState;
            $next->start('synthetic-fpm-ip');
            $next->alive();
            $next->finish();
            fwrite(STDOUT, "\nFPM ".json_encode(['mode' => $mode, 'http_seconds' => $elapsed] + $marker)."\n");
        } finally {
            if (is_resource($socket)) {
                fclose($socket);
            }
            proc_terminate($peer, 9);
            foreach ($pipes as $pipe) {
                fclose($pipe);
            }
            proc_close($peer);
        }
    }

    private function marker(): array
    {
        return is_file('/tmp/g3-fpm-marker.json') ? (json_decode(file_get_contents('/tmp/g3-fpm-marker.json'), true) ?? []) : [];
    }

    private function locks(): int
    {
        return (int) DB::selectOne("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND classid=170331 AND objsubid=2 AND granted")->n;
    }
}
