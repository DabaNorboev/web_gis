<?php

namespace App\Support;

use Illuminate\Foundation\Vite;

class FrontendVite extends Vite
{
    public function isRunningHot()
    {
        // Compose selection also applies when Laravel's config cache predates a mode change.
        $mode = getenv('FRONTEND_ASSETS_MODE') ?: config('app.frontend_assets_mode');

        return $mode === 'dev' && parent::isRunningHot();
    }
}
