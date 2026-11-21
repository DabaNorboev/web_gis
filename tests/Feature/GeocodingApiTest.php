<?php

namespace Tests\Feature;

use App\Services\Addresses\AddressResolverService;
use App\Services\Geocoding\GeoapifyTransport;
use App\Services\Geocoding\GeocodingService;
use App\Services\Geocoding\GeocodingState;
use App\Services\Geocoding\GeocodingTokens;
use App\Services\Gis\AnalysisArea;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Tests\Support\Geocoding\Fixtures;
use Tests\TestCase;

class GeocodingApiTest extends TestCase
{
    use Fixtures;

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.key' => 'base64:'.base64_encode(str_repeat('a', 32))]);
        $this->scopeFixture();
        $this->mock(GeocodingState::class, fn ($m) => $m->shouldReceive('rate')->andReturnNull());
        $this->mock(GeoapifyTransport::class, fn ($m) => $m->shouldNotReceive('request'));
    }

    public function test_strict_requests_echo_and_privacy_including_debug(): void
    {
        config(['app.debug' => true]);
        $id = (string) Str::uuid();
        $path = '/api/v1/geocoding/search';
        foreach ([['request_id' => $id, 'q' => 'canary', 'mode' => 'search', 'extra' => 'canary'],
            ['request_id' => $id, 'q' => 'ab', 'mode' => 'search'], ['request_id' => $id, 'q' => ['canary'], 'mode' => 'search'],
            ['request_id' => $id, 'q' => 'canary'], ['request_id' => $id, 'q' => null, 'mode' => 'search']] as $body) {
            $this->postJson($path, $body)->assertUnprocessable()->assertJsonPath('code', 'INVALID_REQUEST')->assertJsonPath('request_id', $id)
                ->assertHeader('Cache-Control', 'no-store, private')->assertHeader('Referrer-Policy', 'no-referrer')->assertDontSee('canary');
        }
        $this->postJson($path, ['request_id' => 'invalid'])->assertUnprocessable()->assertJsonPath('request_id', null);
        $this->postJson($path.'?q=canary', ['request_id' => $id])->assertUnprocessable()->assertJsonPath('request_id', $id);
        $this->options($path, [], ['Origin' => 'https://synthetic.invalid', 'Access-Control-Request-Method' => 'POST'])
            ->assertStatus(405)->assertHeaderMissing('Access-Control-Allow-Origin')->assertHeader('Referrer-Policy', 'no-referrer');
        $this->getJson($path)->assertStatus(405)->assertJsonPath('code', 'METHOD_NOT_ALLOWED')->assertJsonPath('request_id', null);
        $this->call('POST', $path, [], [], [], ['CONTENT_TYPE' => 'text/plain', 'HTTP_ACCEPT' => 'application/json'], '{}')->assertStatus(415);
        $this->call('POST', $path, [], [], [], ['CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json'], '{')->assertUnprocessable();
        $this->postJson($path, ['q' => str_repeat('x', 8192)])->assertStatus(413)->assertJsonPath('code', 'REQUEST_TOO_LARGE');
    }

    public function test_confirm_reconfirm_and_analysis_share_snapshot_without_cache_or_network(): void
    {
        $tokens = app(GeocodingTokens::class);
        $candidate = $tokens->candidate($this->candidateFixture())['candidate_token'];
        $confirmed = $this->postJson('/api/v1/geocoding/confirm', ['request_id' => (string) Str::uuid(), 'candidate_token' => $candidate, 'position_confirmed' => true])
            ->assertOk()->assertJsonPath('meta.cache', 'NONE')->assertJsonPath('data.place.building', null)->json('data');
        $renewed = $this->postJson('/api/v1/geocoding/reconfirm', ['request_id' => (string) Str::uuid(), 'selection_token' => $confirmed['selection_token'], 'position_confirmed' => true])
            ->assertOk()->assertJsonPath('data.place', $confirmed['place'])->json('data');
        $this->mock(AddressResolverService::class, fn ($m) => $m->shouldNotReceive('snapshots', 'resolve', 'validateId'));
        $this->mock(AnalysisArea::class, fn ($m) => $m->shouldReceive('forPoint')->times(3)->with(1.2, 2.3, 500)->andReturn(['analysis_area' => [], 'analysis_bounds' => []]));
        foreach (['poi', 'satellite', 'air'] as $block) {
            $r = $this->postJson('/api/v1/place-analysis', ['analysis_version' => 2, 'place' => ['kind' => 'address', 'selection_token' => $renewed['selection_token']], 'blocks' => [$block]])
                ->assertOk()->assertJsonPath('analysis_version', 2)->assertJsonPath('place', $confirmed['place']);
            $this->assertSame([$block], array_keys($r->json('blocks')));
            $r->assertDontSee($renewed['selection_token'])->assertDontSee('"object"', false);
        }
    }

    public function test_mixed_identity_and_false_confirmation_rejected(): void
    {
        foreach ([false, 1, 'true', null] as $confirmed) {
            $this->postJson('/api/v1/geocoding/confirm', ['request_id' => (string) Str::uuid(), 'candidate_token' => 'canary', 'position_confirmed' => $confirmed])
                ->assertUnprocessable()->assertJsonPath('code', 'INVALID_REQUEST');
        }
        foreach ([['kind' => 'address', 'selection_token' => 'canary', 'address_id' => 'osm:node:1'], ['kind' => 'address', 'selection_token' => 'canary', 'lon' => 0],
            ['kind' => 'point', 'lon' => 0, 'lat' => 0], ['kind' => 'address', 'address_id' => 'synthetic-provider-id']] as $place) {
            $this->postJson('/api/v1/place-analysis', ['analysis_version' => 2, 'place' => $place])->assertUnprocessable();
        }
        $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'address', 'selection_token' => 'canary']])->assertUnprocessable();
        $this->postJson('/api/v1/place-analysis', ['place' => ['kind' => 'address', 'address_id' => 'synthetic-provider-id']])->assertNotFound();
        $this->postJson('/api/v1/geocoding/confirm', ['request_id' => (string) Str::uuid(), 'candidate_token' => 'canary', 'position_confirmed' => true])
            ->assertUnprocessable()->assertJsonPath('code', 'INVALID_SELECTION')->assertDontSee('canary');
    }

    public function test_unexpected_exception_is_safe_and_not_reported_even_with_debug(): void
    {
        config(['app.debug' => true]);
        $this->mock(GeocodingService::class, fn ($m) => $m->shouldReceive('execute')->andThrow(new \RuntimeException('PRIVATE_CANARY')));
        Log::shouldReceive('error')->never();
        $id = (string) Str::uuid();
        $this->postJson('/api/v1/geocoding/search', ['request_id' => $id, 'q' => 'PRIVATE_CANARY', 'mode' => 'search'])
            ->assertStatus(503)->assertJsonPath('code', 'GEOCODING_UNAVAILABLE')->assertJsonPath('request_id', $id)
            ->assertDontSee('PRIVATE_CANARY')->assertDontSee('trace')->assertDontSee('arguments');
    }
}
