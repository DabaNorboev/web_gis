<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('geocoding_cache', function (Blueprint $table) {
            $table->string('key', 64)->primary();
            $table->text('value');
            $table->unsignedInteger('bytes');
            $table->bigInteger('created_at')->index();
            $table->bigInteger('expires_at')->index();
        });
        Schema::create('geocoding_guards', function (Blueprint $table) {
            $table->string('key', 160)->primary();
            $table->double('value');
            $table->bigInteger('expires_at')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('geocoding_cache');
        Schema::dropIfExists('geocoding_guards');
    }
};
