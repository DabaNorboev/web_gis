<?php

namespace Tests\Feature;

use App\Support\FrontendVite;
use Illuminate\Foundation\Vite;
use Tests\TestCase;

class FrontendAssetsModeTest extends TestCase
{
    public function test_build_ignores_existing_hot_file_and_dev_uses_it(): void
    {
        $root = sys_get_temp_dir().'/assets-mode-'.bin2hex(random_bytes(6));
        mkdir($root);
        mkdir($root.'/build');
        file_put_contents($root.'/hot', 'http://localhost:5173');
        file_put_contents($root.'/build/manifest.json', json_encode([
            'resources/js/app.js' => ['file' => 'assets/fixture.js', 'src' => 'resources/js/app.js', 'isEntry' => true],
        ]));
        $oldMode = getenv('FRONTEND_ASSETS_MODE');
        $oldPublic = public_path();
        $this->app->usePublicPath($root);
        try {
            $vite = $this->app->make(Vite::class);
            $this->assertInstanceOf(FrontendVite::class, $vite);
            $vite->useHotFile($root.'/hot');
            putenv('FRONTEND_ASSETS_MODE=dev');
            config(['app.frontend_assets_mode' => 'build']);
            $this->assertStringContainsString('http://localhost:5173/@vite/client', (string) $vite('resources/js/app.js'));
            putenv('FRONTEND_ASSETS_MODE=build');
            config(['app.frontend_assets_mode' => 'dev']);
            $html = (string) $vite('resources/js/app.js');
            $this->assertStringContainsString('/build/assets/fixture.js', $html);
            $this->assertStringNotContainsString('5173', $html);
            $this->assertFileExists($root.'/hot');
        } finally {
            putenv($oldMode === false ? 'FRONTEND_ASSETS_MODE' : 'FRONTEND_ASSETS_MODE='.$oldMode);
            $this->app->usePublicPath($oldPublic);
            unlink($root.'/hot');
            unlink($root.'/build/manifest.json');
            rmdir($root.'/build');
            rmdir($root);
        }
    }
}
