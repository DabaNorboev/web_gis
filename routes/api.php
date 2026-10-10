<?php

use App\Http\Controllers\Api\V1\TransportAnalysisController;
use Illuminate\Support\Facades\Route;

Route::get('v1/transport/analysis', TransportAnalysisController::class);
