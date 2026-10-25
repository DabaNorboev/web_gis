<?php

use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

Route::view('/address/{id}', 'welcome');
// This public page has no session state. In particular, do not persist an old
// query-format link as Laravel's _previous.url in a guest session.
Route::view('/trips', 'welcome')->withoutMiddleware([
    \Illuminate\Session\Middleware\StartSession::class,
    \Illuminate\View\Middleware\ShareErrorsFromSession::class,
    \Illuminate\Foundation\Http\Middleware\PreventRequestForgery::class,
]);
