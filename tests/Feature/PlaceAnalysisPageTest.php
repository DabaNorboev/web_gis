<?php

namespace Tests\Feature;

use Tests\TestCase;

class PlaceAnalysisPageTest extends TestCase
{
    public function test_first_analysis_page_uses_the_existing_guest_shell(): void
    {
        $this->withoutVite();
        $this->get('/analysis')->assertOk()->assertViewIs('welcome');
        $this->assertGuest();
    }
}
