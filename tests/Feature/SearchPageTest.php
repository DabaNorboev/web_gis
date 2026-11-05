<?php

namespace Tests\Feature;

use Tests\TestCase;

class SearchPageTest extends TestCase
{
    public function test_search_uses_the_existing_guest_shell(): void
    {
        $this->withoutVite();
        $this->get('/search')->assertRedirect('/');
        $this->assertGuest();
    }
}
