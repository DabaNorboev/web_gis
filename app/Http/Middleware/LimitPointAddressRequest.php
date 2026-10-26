<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class LimitPointAddressRequest
{
    public function handle(Request $request, Closure $next): mixed
    {
        abort_if(strlen($request->getContent()) > 1024, 413, 'Запрос слишком большой.');
        abort_unless($request->isJson(), 415, 'Нужен JSON-запрос.');

        return $next($request);
    }
}
