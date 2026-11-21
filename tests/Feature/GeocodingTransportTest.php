<?php

namespace Tests\Feature;

use App\Services\Geocoding\GeoapifyTransport;
use App\Services\Geocoding\GeocodingFailure;
use App\Services\Geocoding\GeocodingState;
use Tests\TestCase;

class GeocodingTransportTest extends TestCase
{
    private string $cert;

    private string $key;

    private string $opensslConfig;

    protected function setUp(): void
    {
        parent::setUp();
        // Launch PHP with -d curl.cainfo=/tmp/placelens-g3-ca.pem (read at transfer time).
        $this->cert = '/tmp/placelens-g3-ca.pem';
        $this->key = tempnam(sys_get_temp_dir(), 'g3-key-');
        $this->opensslConfig = tempnam(sys_get_temp_dir(), 'g3-ssl-');
        file_put_contents($this->opensslConfig, "[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
        $private = openssl_pkey_new(['private_key_bits' => 2048]);
        $csr = openssl_csr_new(['commonName' => 'localhost'], $private, ['config' => $this->opensslConfig, 'digest_alg' => 'sha256']);
        $crt = openssl_csr_sign($csr, null, $private, 1, ['config' => $this->opensslConfig, 'x509_extensions' => 'ext', 'digest_alg' => 'sha256']);
        openssl_x509_export_to_file($crt, $this->cert);
        openssl_pkey_export_to_file($private, $this->key);
    }

    protected function tearDown(): void
    {
        foreach ([$this->cert, $this->key, $this->opensslConfig] as $file) {
            @unlink($file);
        }
        parent::tearDown();
    }

    private function probe(string $mode, ?string $error, float $minimum = 0, float $maximum = 3): void
    {
        $process = proc_open([PHP_BINARY, base_path('tests/Support/Geocoding/tls-server.php'), $this->cert, $this->key, $mode],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'a']], $pipes);
        $endpoint = trim(fgets($pipes[1]));
        $this->assertMatchesRegularExpression('/^127\.0\.0\.1:\d+$/', $endpoint);
        $state = \Mockery::mock(GeocodingState::class);
        $state->shouldReceive('alive')->andReturnNull();
        $state->shouldReceive('finish')->once();
        $state->shouldReceive('upstreamQuota')->with(null)->andReturn(3600);
        $state->shouldReceive('upstreamStatus')->withAnyArgs()->andReturnNull();
        $client = new class extends GeoapifyTransport
        {
            public function local(string $url, GeocodingState $state): array
            {
                return $this->transfer($url, $state);
            }
        };
        $start = microtime(true);
        try {
            $result = $client->local('https://'.$endpoint.'/synthetic', $state);
            $this->assertNull($error);
            $this->assertSame([], $result);
        } catch (GeocodingFailure $e) {
            $this->assertSame($error, $e->errorCode);
            if ($mode === 'rate') {
                $this->assertSame(95, $e->retryAfter);
            }
        } finally {
            $elapsed = microtime(true) - $start;
            proc_terminate($process);
            foreach ($pipes as $pipe) {
                fclose($pipe);
            }
            proc_close($process);
        }
        $this->assertGreaterThanOrEqual($minimum, $elapsed);
        $this->assertLessThan($maximum, $elapsed);
        fwrite(STDOUT, "\nCLI ".json_encode(['mode' => $mode, 'seconds' => $elapsed])."\n");
    }

    public function test_real_tls_transfer_and_redirect_size_and_retry_rules(): void
    {
        $this->assertSame(! empty(curl_version()['ares']) && (curl_version()['features'] & CURL_VERSION_ASYNCHDNS) !== 0, (new GeoapifyTransport)->available());
        $this->probe('ok', null);
        $this->probe('redirect', 'PROVIDER_RESPONSE_INVALID');
        $this->probe('gzip', 'PROVIDER_RESPONSE_INVALID');
        $this->probe('rate', 'PROVIDER_RATE_LIMITED');
        $this->probe('quota', 'GEOCODING_QUOTA_EXHAUSTED');
    }

    public function test_connect_timeout_includes_stalled_tls_handshake(): void
    {
        $this->probe('connect', 'PROVIDER_TIMEOUT', 1.7, 3.5);
    }

    public function test_full_deadline_includes_headers_body_and_slow_chunks(): void
    {
        foreach (['headers', 'body', 'chunks'] as $mode) {
            $this->probe($mode, 'PROVIDER_TIMEOUT', 7.5, 9.5);
        }
    }

    public function test_lock_failure_aborts_transfer_and_releases_after_handle(): void
    {
        $state = \Mockery::mock(GeocodingState::class);
        $calls = 0;
        $state->shouldReceive('alive')->andReturnUsing(function () use (&$calls) {
            if (++$calls > 2) {
                throw new GeocodingFailure('GEOCODING_UNAVAILABLE');
            }
        });
        $state->shouldReceive('finish')->once();
        // A TLS handshake may spend its entire 2s budget without progress callbacks.
        // Exercise cancellation during response reading, independently of callback counts in TLS.
        $peer = proc_open([PHP_BINARY, base_path('tests/Support/Geocoding/tls-server.php'), $this->cert, $this->key, 'body'],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'a']], $pipes);
        $endpoint = trim(fgets($pipes[1]));
        $this->assertMatchesRegularExpression('/^127\.0\.0\.1:\d+$/', $endpoint);
        $client = new class extends GeoapifyTransport
        {
            public function local(string $url, GeocodingState $state): array
            {
                return $this->transfer($url, $state);
            }
        };
        $start = microtime(true);
        try {
            $client->local('https://'.$endpoint, $state);
            $this->fail('Lost locks must abort');
        } catch (GeocodingFailure $e) {
            $this->assertSame('GEOCODING_UNAVAILABLE', $e->errorCode);
            $this->assertLessThan(3, microtime(true) - $start);
        } finally {
            proc_terminate($peer, 9);
            foreach ($pipes as $pipe) {
                fclose($pipe);
            }
            proc_close($peer);
        }
    }

    public function test_async_dns_stall_respects_connect_deadline_in_isolated_resolver(): void
    {
        if (getenv('G3_ISOLATED_DNS') !== '1') {
            $this->markTestSkipped('Requires isolated loopback resolv.conf; never change host DNS.');
        }
        if (! (new GeoapifyTransport)->available()) {
            $state = \Mockery::mock(GeocodingState::class);
            $state->shouldNotReceive('start', 'alive', 'finish');
            $start = microtime(true);
            try {
                (new GeoapifyTransport)->request('search', ['text' => 'synthetic'], $state);
                $this->fail('Unsupported DNS must fail before HTTP');
            } catch (GeocodingFailure $e) {
                $this->assertSame('GEOCODING_UNAVAILABLE', $e->errorCode);
                $this->assertLessThan(.5, microtime(true) - $start);
            }

            return;
        }
        $process = proc_open([PHP_BINARY, base_path('tests/Support/Geocoding/dns-sink.php')],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'a']], $pipes);
        $this->assertSame("READY\n", fgets($pipes[1]));
        $state = \Mockery::mock(GeocodingState::class);
        $state->shouldReceive('alive')->andReturnNull();
        $state->shouldReceive('finish')->once();
        $client = new class extends GeoapifyTransport
        {
            public function local(GeocodingState $s): array
            {
                return $this->transfer('https://synthetic-dns-stall.invalid/', $s);
            }
        };
        $start = microtime(true);
        try {
            $client->local($state);
            $this->fail('DNS must time out');
        } catch (GeocodingFailure $e) {
            $this->assertSame('PROVIDER_TIMEOUT', $e->errorCode);
            $this->assertGreaterThanOrEqual(1.7, microtime(true) - $start);
            $this->assertLessThan(3.5, microtime(true) - $start);
            fwrite(STDOUT, "\nCLI ".json_encode(['mode' => 'dns', 'seconds' => microtime(true) - $start])."\n");
        } finally {
            proc_terminate($process, 9);
            foreach ($pipes as $pipe) {
                fclose($pipe);
            }
            proc_close($process);
        }
    }
}
