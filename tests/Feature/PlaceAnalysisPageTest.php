<?php

namespace Tests\Feature;

use Tests\TestCase;

class PlaceAnalysisPageTest extends TestCase
{
    public function test_current_analysis_is_the_only_public_screen(): void
    {
        $this->withoutVite();
        $this->get('/')->assertOk()->assertViewIs('welcome');
        $this->get('/?demo=1')->assertOk()->assertViewIs('welcome');
        foreach (['/analysis', '/analysis?demo=1', '/search', '/compare', '/address/osm:node:1', '/trips?trip=SYNTHETIC_PRIVATE_CANARY'] as $path) {
            $this->get($path)->assertRedirect('/')->assertHeader('Cache-Control', 'no-store, private')->assertHeader('Referrer-Policy', 'no-referrer');
        }
        $this->assertGuest();
    }
}
