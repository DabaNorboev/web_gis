<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('dataset_imports', function (Blueprint $table) {
            $table->id();
            $table->string('source', 100);
            $table->string('dataset_key', 100);
            $table->text('source_url')->nullable();
            $table->string('source_version')->nullable();
            $table->timestampTz('source_updated_at')->nullable();
            $table->timestampTz('observed_at')->nullable();
            $table->char('checksum_sha256', 64);
            $table->char('configuration_sha256', 64);
            $table->jsonb('configuration');
            $table->string('status', 16)->default('running');
            $table->boolean('is_active')->default(false);
            $table->timestampTz('started_at')->useCurrent();
            $table->timestampTz('finished_at')->nullable();
            $table->integer('row_count')->nullable();
            $table->jsonb('result')->nullable();
            $table->text('error_message')->nullable();
            $table->index(['source', 'dataset_key', 'started_at']);
        });

        DB::statement(<<<'SQL'
            ALTER TABLE dataset_imports
                ADD CONSTRAINT dataset_imports_identity_check
                    CHECK (btrim(source) <> '' AND btrim(dataset_key) <> ''),
                ADD CONSTRAINT dataset_imports_hashes_check
                    CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'
                        AND configuration_sha256 ~ '^[0-9a-f]{64}$'),
                ADD CONSTRAINT dataset_imports_configuration_check
                    CHECK (jsonb_typeof(configuration) = 'object'),
                ADD CONSTRAINT dataset_imports_status_check
                    CHECK (status IN ('running', 'succeeded', 'failed')),
                ADD CONSTRAINT dataset_imports_lifecycle_check
                    CHECK ((status = 'running' AND finished_at IS NULL)
                        OR (status IN ('succeeded', 'failed') AND finished_at IS NOT NULL
                            AND finished_at >= started_at)),
                ADD CONSTRAINT dataset_imports_active_check
                    CHECK (NOT is_active OR status = 'succeeded'),
                ADD CONSTRAINT dataset_imports_row_count_check
                    CHECK (row_count IS NULL OR row_count >= 0)
            SQL);

        DB::statement(<<<'SQL'
            CREATE UNIQUE INDEX dataset_imports_one_active
                ON dataset_imports (source, dataset_key) WHERE is_active
            SQL);

        DB::statement(<<<'SQL'
            CREATE UNIQUE INDEX dataset_imports_successful_input
                ON dataset_imports (source, dataset_key, checksum_sha256, configuration_sha256)
                WHERE status = 'succeeded'
            SQL);
    }

    public function down(): void
    {
        Schema::dropIfExists('dataset_imports');
    }
};
