<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class LimitTripRequest
{
    public function handle(Request $request, Closure $next): mixed
    {
        abort_if(strlen($request->getContent()) > 8192, 413, 'Запрос поездки слишком большой.');

        return $next($request);
    }
}
