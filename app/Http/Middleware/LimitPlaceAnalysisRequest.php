<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class LimitPlaceAnalysisRequest
{
    public function handle(Request $request, Closure $next): mixed
    {
        abort_if(strlen($request->getContent()) > 8192, 413);
        abort_unless($request->isJson(), 415);
        try {
            $body = json_decode($request->getContent(), false, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            abort(422);
        }
        abort_unless($body instanceof \stdClass, 422);

        return $next($request);
    }
}
