<?php

namespace Tests\Feature;

use App\Services\Geocoding\AddressNumber;
use App\Services\Geocoding\GeoapifyNormalizer;
use App\Services\Geocoding\GeocodingFailure;
use App\Services\Geocoding\GeocodingScope;
use App\Services\Geocoding\GeocodingTokens;
use Carbon\CarbonImmutable;
use Illuminate\Encryption\Encrypter;
use Illuminate\Support\Facades\Crypt;
use Tests\Support\Geocoding\Fixtures;
use Tests\TestCase;

class GeocodingTokensTest extends TestCase
{
    use Fixtures;

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.key' => 'base64:'.base64_encode(str_repeat('a', 32))]);
        $this->scopeFixture();
        CarbonImmutable::setTestNow('2026-11-15T00:00:00Z');
    }

    protected function tearDown(): void
    {
        CarbonImmutable::setTestNow();
        parent::tearDown();
    }

    private function code(string $code, callable $action): void
    {
        try {
            $action();
            $this->fail('Expected rejection');
        } catch (GeocodingFailure $e) {
            $this->assertSame($code, $e->errorCode);
        }
    }

    public function test_absolute_lifecycle_replay_and_scope_rules(): void
    {
        $tokens = app(GeocodingTokens::class);
        $candidate = $tokens->candidate($this->candidateFixture());
        $initial = $tokens->confirm($candidate['candidate_token']);
        $p0 = json_decode(Crypt::decryptString($initial['selection_token']), true);
        $this->assertSame(604800, $p0['snapshot_expires_at'] - $p0['snapshot_created_at']);
        CarbonImmutable::setTestNow('2026-11-16T00:00:00Z');
        $this->code('SELECTION_EXPIRED', fn () => $tokens->selection($initial['selection_token']));
        $this->code('CANDIDATE_EXPIRED', fn () => $tokens->confirm($candidate['candidate_token']));
        $renewed = $tokens->reconfirm($initial['selection_token']);
        $this->assertSame($initial['place'], $renewed['place']);
        foreach (['2026-11-17T00:00:00Z', '2026-11-21T23:59:59Z'] as $now) {
            CarbonImmutable::setTestNow($now);
            $renewed = $tokens->reconfirm($renewed['selection_token']);
            $p = json_decode(Crypt::decryptString($renewed['selection_token']), true);
            foreach (['snapshot_created_at', 'snapshot_expires_at', 'selection_id', 'place'] as $field) {
                $this->assertSame($p0[$field], $p[$field]);
            }
            $replay = $tokens->reconfirm($initial['selection_token']);
            $this->assertSame($renewed['snapshot_expires_at'], $replay['snapshot_expires_at']);
        }
        $this->assertSame($renewed['snapshot_expires_at'], $renewed['expires_at']);
        config(['geocoding.scope_sha256' => str_repeat('b', 64)]);
        // Analysis remains independent of a new scope; reconfirm checks the active one.
        $this->assertSame($initial['place'], $tokens->selection($renewed['selection_token'])['place']);
        $this->code('SCOPE_CHANGED', fn () => $tokens->reconfirm($renewed['selection_token']));
        config(['geocoding.scope_sha256' => str_repeat('a', 64)]);
        foreach (['2026-11-22T00:00:00Z', '2026-11-23T00:00:00Z'] as $now) {
            CarbonImmutable::setTestNow($now);
            $this->code('SNAPSHOT_EXPIRED', fn () => $tokens->reconfirm($initial['selection_token']));
        }
    }

    public function test_purpose_schema_fields_mac_and_key_rotation(): void
    {
        $tokens = app(GeocodingTokens::class);
        $candidate = $tokens->candidate($this->candidateFixture())['candidate_token'];
        $token = $tokens->confirm($candidate)['selection_token'];
        $this->code('INVALID_SELECTION', fn () => $tokens->reconfirm($candidate));
        $this->code('INVALID_SELECTION', fn () => $tokens->confirm($token));
        $this->code('INVALID_SELECTION', fn () => $tokens->selection(substr($token, 0, -10).'corrupt'));
        $p = json_decode(Crypt::decryptString($token), true);
        foreach ([['schema', 2], ['purpose', 'other'], ['provider', 'other'], ['issued_at', $p['issued_at'] + 1], ['expires_at', '123'],
            ['snapshot_created_at', $p['snapshot_created_at'] - 1], ['snapshot_expires_at', $p['snapshot_expires_at'] + 1], ['extra', true]] as [$k, $v]) {
            $invalid = Crypt::encryptString(json_encode([$k => $v] + $p));
            $this->code('INVALID_SELECTION', fn () => $tokens->reconfirm($invalid));
        }
        $oldKey = str_repeat('a', 32);
        $next = new Encrypter(str_repeat('b', 32), 'AES-256-CBC');
        $this->app->instance('encrypter', $next);
        Crypt::clearResolvedInstance('encrypter');
        $this->code('INVALID_SELECTION', fn () => $tokens->selection($token));
        $next->previousKeys([$oldKey]);
        $this->assertSame($p['place'], $tokens->selection($token)['place']);
        CarbonImmutable::setTestNow('2026-11-16T00:00:00Z');
        $this->code('SELECTION_EXPIRED', fn () => $tokens->selection($token));
        $this->code('INVALID_SELECTION', fn () => $tokens->reconfirm($candidate));
    }

    public function test_numbers_precision_foreign_results_and_no_confidence_upgrade(): void
    {
        $numbers = app(AddressNumber::class);
        $keys = [];
        foreach (['10', '100', '10/2', '10 к2', '10 стр2', '10А', '10A'] as $s) {
            $n = $numbers->parse($s);
            $this->assertSame('COMPLETE', $n['parse_status']);
            $this->assertSame($s, $n['raw']);
            $keys[] = $n['key'];
        }
        $this->assertCount(7, array_unique($keys));
        foreach (['10,12', '10/2, корпус 3', '10 корпус 2 корпус 3'] as $s) {
            $this->assertSame('UNKNOWN', $numbers->parse($s)['parse_status']);
        }
        $this->assertSame('UNKNOWN', $numbers->requested('Мира10')['parse_status']);
        $this->assertSame('UNKNOWN', $numbers->requested('Мира 10 стр 2/3')['parse_status']);
        $this->assertSame('UNKNOWN', $numbers->requested('Мира 10, 12')['parse_status']);
        $this->assertSame($numbers->parse('100')['key'], $numbers->requested('100')['key']);
        $this->assertNull($numbers->requested('улица 9 Мая'));
        $this->assertSame($numbers->parse('10')['key'], $numbers->requested('улица 9 Мая 10')['key']);
        $this->assertSame($numbers->parse('10 к2')['key'], $numbers->parse('д. 10 корпус 2')['key']);
        $n = app(GeoapifyNormalizer::class);
        foreach (['building' => 'house', 'street' => 'street', 'city' => 'locality', 'amenity' => null] as $type => $level) {
            $c = $n->normalize([$this->row(['result_type' => $type, 'rank' => ['confidence' => 1]])], 'Синтетическая 10/2А к3 стр4', '2026-11-15T00:00:00Z')['candidates'][0];
            $this->assertSame($level, $c['precision']['level']);
            $this->assertNull($c['precision']['accuracy_m']);
            $this->assertSame($type === 'building', $c['can_confirm']);
            $this->assertSame('EXACT', $c['number_match']);
        }
        $c = $n->normalize([$this->row(['housenumber' => '10/2А'])], 'Синтетическая 10/2А к3 стр4', '2026-11-15T00:00:00Z')['candidates'][0];
        $this->assertSame('MISMATCH', $c['number_match']);
        $this->assertFalse($c['can_confirm']);
        $this->assertSame('NO_IN_SCOPE_RESULTS', $n->normalize([$this->row(['lon' => -1]), $this->row(['country_code' => 'kz'])], null, '2026-11-15T00:00:00Z')['reason']);
        $c = $n->normalize([$this->row(['lon' => null])], null, '2026-11-15T00:00:00Z')['candidates'][0];
        $this->assertFalse($c['can_confirm']);
        $this->assertNull($c['within_scope']);
    }

    public function test_corrupt_nested_snapshot_schema_is_rejected_even_after_expiry(): void
    {
        $tokens = app(GeocodingTokens::class);
        $token = $tokens->confirm($tokens->candidate($this->candidateFixture())['candidate_token'])['selection_token'];
        $payload = json_decode(Crypt::decryptString($token), true);
        CarbonImmutable::setTestNow('2026-11-23T00:00:00Z');
        foreach (['place.point.lon' => '1.2', 'place.address.precision.level' => 'street', 'place.address.source.normalization_version' => 2,
            'place.address.components.number.corpus' => null, 'place.building' => [], 'place.selection_id' => 'other'] as $path => $value) {
            $p = $payload;
            data_set($p, $path, $value);
            $this->code('INVALID_SELECTION', fn () => $tokens->reconfirm(Crypt::encryptString(json_encode($p))));
        }
    }

    public function test_missing_active_boundary_blocks_exchange_but_not_analysis_of_existing_snapshot(): void
    {
        $tokens = app(GeocodingTokens::class);
        $candidate = $tokens->candidate($this->candidateFixture())['candidate_token'];
        $chosen = $tokens->confirm($candidate);
        $this->mock(GeocodingScope::class, function ($m) {
            $m->shouldReceive('identity')->andReturn(['scope_id' => config('geocoding.scope_id'), 'scope_sha256' => config('geocoding.scope_sha256')]);
            $m->shouldReceive('bounds')->andThrow(new GeocodingFailure('GEOCODING_UNAVAILABLE'));
        });
        $tokens = app(GeocodingTokens::class);
        $this->assertSame($chosen['place'], $tokens->selection($chosen['selection_token'])['place']);
        $this->code('GEOCODING_UNAVAILABLE', fn () => $tokens->confirm($candidate));
        $this->code('GEOCODING_UNAVAILABLE', fn () => $tokens->reconfirm($chosen['selection_token']));
    }
}
