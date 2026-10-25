<?php

use App\Http\Controllers\Api\V1\AddressProfileController;
use App\Http\Controllers\Api\V1\AddressSearchController;
use App\Http\Controllers\Api\V1\TransportAnalysisController;
use App\Http\Controllers\Api\V1\TripAnalysisController;
use App\Http\Middleware\LimitTripRequest;
use Illuminate\Support\Facades\Route;

Route::get('v1/transport/analysis', TransportAnalysisController::class);

Route::get('v1/addresses/search', AddressSearchController::class)->middleware('throttle:120,1');
Route::get('v1/addresses/{id}/profile', AddressProfileController::class)->middleware('throttle:120,1');

Route::post('v1/trips/analyze', TripAnalysisController::class)->middleware([LimitTripRequest::class, 'throttle:30,1,trips']);

Route::post('v1/addresses/resolve-point', \App\Http\Controllers\Api\V1\PointAddressController::class)
    ->middleware([\App\Http\Middleware\LimitPointAddressRequest::class, 'throttle:120,1,point-address']);
