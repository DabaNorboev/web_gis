<?php

namespace App\Services\Osm\Import;

use App\Services\Gis\DatasetCoverage;
use Illuminate\Support\Facades\DB;

class OsmParkImporter extends OsmGroceryImporter
{
    public function __construct(OsmParkReader $reader, DatasetCoverage $coverage, OsmParkPreparation $preparation)
    {
        parent::__construct($reader, $coverage, $preparation);
    }

    protected function structuralAliases(string $stage): array
    {
        // Membership and exact component exterior prove a source representation.
        // Mere containment, proximity or a shared name never prove identity.
        return DB::select("WITH candidates AS (
            SELECT DISTINCT w.source_id alias,r.source_id canonical FROM {$stage} r
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.raw_data->'osm'->'members','[]'::jsonb)) m
            JOIN {$stage} w ON w.source_id='osm:way:'||(m->>'ref')
            CROSS JOIN LATERAL ST_Dump(r.geom) part
            WHERE r.source_id LIKE 'osm:relation:%' AND m->>'type'='way' AND m->>'role'='outer'
                AND ST_GeometryType(w.geom)='ST_Polygon' AND ST_GeometryType(part.geom)='ST_Polygon'
                AND ST_Equals(ST_ExteriorRing(w.geom),ST_ExteriorRing(part.geom))
        ) SELECT alias,min(canonical) canonical FROM candidates GROUP BY alias HAVING count(DISTINCT canonical)=1 ORDER BY alias");
    }
}
