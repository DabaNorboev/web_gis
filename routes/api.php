<?php

use App\Http\Controllers\Api\V1\AddressProfileController;
use App\Http\Controllers\Api\V1\AddressSearchController;
use App\Http\Controllers\Api\V1\TransportAnalysisController;
use Illuminate\Support\Facades\Route;

Route::get('v1/transport/analysis', TransportAnalysisController::class);

Route::get('v1/addresses/search', AddressSearchController::class)->middleware('throttle:120,1');
Route::get('v1/addresses/{id}/profile', AddressProfileController::class)->middleware('throttle:120,1');
