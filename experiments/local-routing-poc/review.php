<?php

require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
use Illuminate\Support\Facades\DB;

if (array_values((array) DB::selectOne('SHOW default_transaction_read_only'))[0] !== 'on') {
    throw new RuntimeException('Read-only connection required');
}
$root = getenv('PLACELENS_ROUTING_POC_OUTPUT') ?: '/var/www/html/data/reports/local-routing-2026-10-21';
$handle = fopen($root.'/review-input.jsonl', 'r');
$rows = [];
while (($line = fgets($handle)) !== false) {
    $row = json_decode($line, true, flags: JSON_THROW_ON_ERROR);
    if ($row['line'] === null) {
        unset($row['source_lines']);
        $rows[] = $row;
        continue;
    }
    $a = json_encode(['type' => 'Point', 'coordinates' => $row['start']]);
    $b = json_encode(['type' => 'Point', 'coordinates' => $row['target']]);
    $query = <<<'SQL'
WITH r AS (
 SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) geom,
 ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) a,
 ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) b
), links AS (
 SELECT ST_MakeLine(a,ST_StartPoint(geom)) a,ST_MakeLine(ST_EndPoint(geom),b) b FROM r
), src AS (
 SELECT j->>'id' id,j->'tags' tags,ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(j->>'geometry'),4326),32646) geom
 FROM jsonb_array_elements(?::jsonb) j
), roads AS (
 SELECT s.*,ST_Length(ST_Intersection(r.geom,ST_Buffer(s.geom,0.25))) overlap_m FROM src s CROSS JOIN r WHERE jsonb_exists(s.tags,'highway') AND ST_DWithin(s.geom,r.geom,1.5)
), gates AS (
 SELECT j->>'id' id,j->'tags' tags,ST_Transform(ST_SetSRID(ST_MakePoint((j->'coordinate'->>0)::float,(j->'coordinate'->>1)::float),4326),32646) geom
 FROM jsonb_array_elements(?::jsonb) j
), buildings AS (
 SELECT b.osm_type||'/'||b.osm_id id,ST_Buffer(ST_Transform(b.geom,32646),-0.3) geom
 FROM osm_buildings b JOIN dataset_imports i ON i.id=b.dataset_import_id AND i.is_active CROSS JOIN r
 WHERE b.geom && ST_Transform(ST_Expand(ST_Envelope(ST_Collect(ARRAY[r.geom,r.a,r.b])),40),4326)
), structures AS (
 SELECT ST_Union(ST_Buffer(geom,2)) geom FROM roads WHERE tags->>'bridge' IN ('yes','viaduct') OR tags->>'tunnel' IN ('yes','building_passage')
), issues AS (
 SELECT 'START_IN_BUILDING' code,jsonb_agg(id) ids FROM buildings CROSS JOIN r WHERE ST_Covers(buildings.geom,r.a)
 UNION ALL SELECT 'TARGET_IN_BUILDING',jsonb_agg(id) FROM buildings CROSS JOIN r WHERE ST_Covers(buildings.geom,r.b)
 UNION ALL SELECT 'SNAP_THROUGH_BUILDING',jsonb_agg(id) FROM buildings CROSS JOIN links WHERE
 (ST_Length(links.a)>0.5 AND ST_Length(ST_Intersection(buildings.geom,links.a))>0.5) OR
 (ST_Length(links.b)>0.5 AND ST_Length(ST_Intersection(buildings.geom,links.b))>0.5)
 UNION ALL SELECT 'SNAP_THROUGH_BARRIER',jsonb_agg(id) FROM src CROSS JOIN links WHERE tags->>'barrier' IN ('wall','fence','retaining_wall') AND
 ((ST_Length(links.a)>0.5 AND ST_Intersects(src.geom,links.a)) OR (ST_Length(links.b)>0.5 AND ST_Intersects(src.geom,links.b)))
 UNION ALL SELECT 'INDOOR_ROUTE',jsonb_agg(id) FROM roads WHERE overlap_m>3 AND (tags->>'indoor'='yes' OR tags->>'highway' IN ('corridor','elevator') OR tags->>'conveying' IN ('yes','forward','backward'))
 UNION ALL SELECT 'ROUTE_BARRIER_REVIEW',jsonb_agg(src.id) FROM src CROSS JOIN r WHERE src.tags->>'barrier' IN ('wall','fence','retaining_wall') AND ST_Crosses(src.geom,r.geom) AND NOT EXISTS
 (SELECT 1 FROM gates WHERE ST_DWithin(gates.geom,ST_Intersection(src.geom,r.geom),1) AND
 (CASE WHEN ?='walking' THEN coalesce(gates.tags->>'foot',gates.tags->>'access','unknown') ELSE coalesce(gates.tags->>'motorcar',gates.tags->>'motor_vehicle',gates.tags->>'vehicle',gates.tags->>'access','unknown') END) IN ('yes','designated','permissive'))
 UNION ALL SELECT 'ACCESS_REVIEW',jsonb_agg(id) FROM roads WHERE overlap_m>3 AND
 (CASE WHEN ?='walking' THEN coalesce(tags->>'foot',tags->>'access','yes') ELSE coalesce(tags->>'motorcar',tags->>'motor_vehicle',tags->>'vehicle',tags->>'access','yes') END) IN ('no','private','customers','permit','delivery','emergency','agricultural','forestry')
 UNION ALL SELECT 'ROUTE_THROUGH_BUILDING',jsonb_agg(id) FROM buildings CROSS JOIN r CROSS JOIN structures WHERE ST_Length(ST_Difference(ST_Intersection(buildings.geom,r.geom),coalesce(structures.geom,ST_GeomFromText('POLYGON EMPTY',32646))))>1
 UNION ALL SELECT 'RAILWAY_CROSSING_REVIEW',jsonb_agg(src.id) FROM src CROSS JOIN r CROSS JOIN structures WHERE src.tags->>'railway' IN ('rail','narrow_gauge') AND ST_Crosses(src.geom,r.geom) AND NOT ST_CoveredBy(ST_Intersection(src.geom,r.geom),coalesce(structures.geom,ST_GeomFromText('POLYGON EMPTY',32646))) AND NOT EXISTS
 (SELECT 1 FROM roads WHERE overlap_m>3 AND ST_DWithin(roads.geom,ST_Intersection(src.geom,r.geom),0.25) AND
 (CASE WHEN coalesce(src.tags->>'layer','0') ~ '^-?[0-9]+$' THEN coalesce(src.tags->>'layer','0')::int END) <>
 (CASE WHEN coalesce(roads.tags->>'layer','0') ~ '^-?[0-9]+$' THEN coalesce(roads.tags->>'layer','0')::int END))
 UNION ALL SELECT 'WATER_CROSSING_REVIEW',jsonb_agg(w.osm_type||'/'||w.osm_id) FROM osm_water w JOIN dataset_imports i ON i.id=w.dataset_import_id AND i.is_active CROSS JOIN r CROSS JOIN structures
 WHERE w.geom && ST_Transform(ST_Envelope(r.geom),4326) AND ST_Length(ST_Difference(ST_Intersection(ST_Transform(w.geom,32646),r.geom),coalesce(structures.geom,ST_GeomFromText('POLYGON EMPTY',32646))))>2
)
SELECT (SELECT jsonb_object_agg(code,ids) FROM issues WHERE ids IS NOT NULL) issues,
 ST_Length(r.geom) length_m,
 (SELECT ST_Length(ST_Intersection(r.geom,ST_Union(ST_Buffer(roads.geom,1.5)))) FROM roads) covered_length_m,
 (SELECT jsonb_agg(jsonb_build_object('id',id,'tags',tags,'overlap_m',overlap_m)) FROM roads WHERE overlap_m>3) matched_source_ways
FROM r
SQL;
    $result = (array) DB::selectOne($query, [json_encode($row['line']), $a, $b, json_encode($row['source_lines']), json_encode($row['barrier_nodes']), $row['mode'], $row['mode']]);
    $result['issues'] = json_decode($result['issues'] ?? '{}', true);
    $result['matched_source_ways'] = json_decode($result['matched_source_ways'] ?? '[]', true);
    $row['geometry_review'] = $result;
    if ($row['kind'] === 'needs_refinement' || isset($result['issues']['START_IN_BUILDING']) || isset($result['issues']['TARGET_IN_BUILDING']) || isset($result['issues']['SNAP_THROUGH_BUILDING']) || isset($result['issues']['SNAP_THROUGH_BARRIER'])) {
        $row['status'] = 'NEEDS_REFINEMENT';
    } elseif ($row['status'] === 'REVIEW_REQUIRED') {
        $row['status'] = count($result['issues']) || $result['covered_length_m'] < .97 * $result['length_m'] ? 'UNKNOWN' : 'MODEL_GEOMETRY_CONSISTENT';
    }
    // MODEL_GEOMETRY_CONSISTENT is still not ACCEPTED: source direction/access and
    // complete connector review require explicit assessment before any product Go.
    unset($row['source_lines'], $row['barrier_nodes']);
    $rows[] = $row;
}
fclose($handle);
echo json_encode(['read_only' => true, 'routes' => $rows], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)."\n";
