<?php

use Illuminate\Support\Facades\Route;

Route::view('/', 'welcome')->name('analysis');

// Retired pages never restore old query/fragment state or create a session.
foreach (['/analysis', '/search', '/compare', '/address/{id}', '/trips'] as $path) {
    Route::get($path, fn () => redirect('/')->withHeaders([
        'Cache-Control' => 'no-store',
        'Referrer-Policy' => 'no-referrer',
    ]))->withoutMiddleware([
        \Illuminate\Session\Middleware\StartSession::class,
        \Illuminate\View\Middleware\ShareErrorsFromSession::class,
        \Illuminate\Foundation\Http\Middleware\PreventRequestForgery::class,
    ]);
}
