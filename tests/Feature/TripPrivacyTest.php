<?php

namespace Tests\Feature;

use App\Services\Routing\LocalCarRouterProvider;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Tests\TestCase;

class TripPrivacyTest extends TestCase
{
    public function test_unexpected_trip_failure_logs_only_type_and_never_debug_payload(): void
    {
        config(['app.debug' => true]);
        $this->mock(LocalCarRouterProvider::class, fn ($mock) => $mock->shouldReceive('analyze')
            ->andThrow(new RuntimeException('SYNTHETIC_PRIVATE_PAYLOAD')));
        Log::shouldReceive('error')->once()->with('Trip request failed.', ['exception_type' => RuntimeException::class]);
        $this->postJson('/api/v1/trips/analyze', ['mode' => 'driving', 'start' => ['lon' => 0, 'lat' => 0],
            'places' => [['lon' => .001, 'lat' => .001, 'label' => 'SYNTHETIC_PRIVATE_PAYLOAD']]])
            ->assertStatus(500)->assertHeader('Cache-Control', 'no-store, private')->assertDontSee('SYNTHETIC_PRIVATE_PAYLOAD')
            ->assertJson(['message' => 'Расчёт поездок временно недоступен.']);
    }

    public function test_page_declares_no_referrer_before_loading_assets(): void
    {
        $this->withoutVite();
        $this->get('/trips')->assertOk()->assertSee('<meta name="referrer" content="no-referrer">', false);
    }

    public function test_legacy_query_page_does_not_start_or_persist_a_session(): void
    {
        $this->withoutVite();
        $this->mock(\Illuminate\Session\SessionManager::class, fn ($mock) => $mock->shouldNotReceive('driver'));
        $this->get('/trips?trip=SYNTHETIC_PRIVATE_CANARY')->assertOk()->assertCookieMissing(config('session.cookie'));
        $this->assertFalse(request()->hasSession());
    }
}
