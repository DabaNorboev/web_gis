<?php

namespace Tests\Feature;

use Tests\TestCase;

class ComparePageTest extends TestCase
{
    public function test_comparison_is_available_to_guests_with_zero_one_or_two_ids(): void
    {
        $this->withoutVite();
        foreach (['/compare', '/compare?left=osm%3Away%3A1', '/compare?left=osm%3Away%3A1&right=osm%3Anode%3A2&radius_m=300', '/compare?left=unknown'] as $url) {
            $this->get($url)->assertOk()->assertViewIs('welcome');
        }
        $this->assertGuest();
    }
}
