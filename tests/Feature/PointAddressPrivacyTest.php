<?php

namespace Tests\Feature;

use App\Services\Addresses\PointAddressService;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Tests\TestCase;

class PointAddressPrivacyTest extends TestCase
{
    public function test_failures_hide_bindings_coordinates_and_debug_details(): void
    {
        config(['app.debug' => true]);
        $this->mock(PointAddressService::class, fn ($mock) => $mock->shouldReceive('resolve')->once()
            ->andThrow(new RuntimeException('SYNTHETIC_PRIVATE_PAYLOAD')));
        Log::shouldReceive('error')->once()->with('Point address request failed.', ['exception_type' => RuntimeException::class]);
        $this->postJson('/api/v1/addresses/resolve-point', ['lon' => 0, 'lat' => 0])->assertStatus(500)
            ->assertHeader('Cache-Control', 'no-store, private')->assertHeader('Referrer-Policy', 'no-referrer')
            ->assertExactJson(['message' => 'Подпись точки временно недоступна.']);
    }

    public function test_validation_and_size_limits_do_not_call_the_service_or_echo_input(): void
    {
        $this->mock(PointAddressService::class, fn ($mock) => $mock->shouldNotReceive('resolve'));
        foreach ([[], ['lon' => 181, 'lat' => 0], ['lon' => 0, 'lat' => -91], ['lon' => ['SYNTHETIC_PRIVATE_PAYLOAD'], 'lat' => 0]] as $input) {
            $this->postJson('/api/v1/addresses/resolve-point', $input)->assertUnprocessable()
                ->assertHeader('Cache-Control', 'no-store, private')->assertDontSee('SYNTHETIC_PRIVATE_PAYLOAD');
        }
        $this->postJson('/api/v1/addresses/resolve-point?lon=0&lat=0', [])->assertUnprocessable();
        $this->postJson('/api/v1/addresses/resolve-point', ['extra' => str_repeat('x', 1100)])->assertStatus(413)
            ->assertHeader('Cache-Control', 'no-store, private');
        $this->getJson('/api/v1/addresses/resolve-point?lon=0&lat=0')->assertStatus(405);
        $this->post('/api/v1/addresses/resolve-point', ['lon' => 0, 'lat' => 0])->assertStatus(415);
    }
}
