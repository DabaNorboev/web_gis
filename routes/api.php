<?php

use App\Http\Controllers\Api\V1\AddressProfileController;
use App\Http\Controllers\Api\V1\AddressResolverController;
use App\Http\Controllers\Api\V1\AddressSearchController;
use App\Http\Controllers\Api\V1\PlaceAnalysisController;
use App\Http\Controllers\Api\V1\PointAddressController;
use App\Http\Controllers\Api\V1\SatelliteTileController;
use App\Http\Controllers\Api\V1\TransportAnalysisController;
use App\Http\Controllers\Api\V1\TripAnalysisController;
use App\Http\Middleware\LimitPlaceAnalysisRequest;
use App\Http\Middleware\LimitPointAddressRequest;
use App\Http\Middleware\LimitTripRequest;
use Illuminate\Support\Facades\Route;

Route::post('v1/place-analysis', PlaceAnalysisController::class)
    ->middleware([LimitPlaceAnalysisRequest::class, 'throttle:60,1,place-analysis']);

Route::get('v1/transport/analysis', TransportAnalysisController::class);

Route::get('v1/addresses/search', AddressSearchController::class)->middleware('throttle:120,1');
Route::get('v1/addresses/{id}', AddressResolverController::class)->middleware('throttle:120,1');
Route::get('v1/addresses/{id}/profile', AddressProfileController::class)->middleware('throttle:120,1');

Route::post('v1/trips/analyze', TripAnalysisController::class)->middleware([LimitTripRequest::class, 'throttle:30,1,trips']);

Route::post('v1/addresses/resolve-point', PointAddressController::class)
    ->middleware([LimitPointAddressRequest::class, 'throttle:120,1,point-address']);

Route::get('v1/satellite/{pin}/{date}/{layer}/{z}/{x}/{y}.png', SatelliteTileController::class)
    ->where(['pin' => '[a-f0-9]{64}', 'date' => '[0-9]{4}-[0-9]{2}-[0-9]{2}', 'layer' => 'true-color|ndvi', 'z' => '[0-9]{1,2}', 'x' => '[0-9]{1,5}', 'y' => '[0-9]{1,5}']);
