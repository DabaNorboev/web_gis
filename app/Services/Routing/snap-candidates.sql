WITH r AS (
 SELECT ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646) original,
 ST_Transform(ST_SetSRID(ST_MakePoint(?,?),4326),32646) hint,CAST(? AS double precision) radius
), src AS (
 SELECT j->>'id' id,j->>'kind' kind,coalesce(j->'tags','{}'::jsonb) tags,
 coalesce(j->'nodes','[]'::jsonb) nodes,(j->>'access_allowed')::boolean access_allowed,
 ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(j->>'geometry'),4326),32646) geom
 FROM jsonb_array_elements(?::jsonb) j
), service AS (
 SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) geom
), box AS (SELECT ?::jsonb bbox), pilot AS (
 SELECT ST_Intersection(service.geom,ST_Buffer(ST_Transform(ST_MakeEnvelope((bbox->>0)::float,
 (bbox->>1)::float,(bbox->>2)::float,(bbox->>3)::float,4326),32646),-CAST(? AS double precision))) geom FROM service CROSS JOIN box
), buildings AS (
 SELECT id,geom full_geom,ST_Buffer(geom,-0.3) geom FROM src WHERE kind='building'
), road_sources AS (
 SELECT s.* FROM src s
 WHERE s.kind='line' AND s.tags->>'highway' IN
 ('motorway','trunk','primary','secondary','tertiary','residential','unclassified','living_street','service',
 'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link')
 AND coalesce(s.tags->>'area','no')<>'yes' AND coalesce(s.tags->>'indoor','no')<>'yes'
 AND coalesce(s.tags->>'impassable','no')<>'yes' AND NOT jsonb_exists(s.tags,'construction')
), segments AS (
 SELECT s.id source_id,s.nodes,s.access_allowed,ST_IsClosed(s.geom) closed,
 (segment.path)[1] segment_index,segment.geom,r.original,r.hint,r.radius
 FROM road_sources s CROSS JOIN r CROSS JOIN LATERAL ST_DumpSegments(s.geom) segment
 WHERE ST_DWithin(s.geom,r.hint,r.radius) AND ST_DWithin(r.original,r.hint,r.radius)
), feet AS (
 SELECT *,ST_ClosestPoint(geom,hint) matched,ST_Distance(geom,hint) d FROM segments
), local_feet AS (
 SELECT *,lag(d) OVER w prev_d,lead(d) OVER w next_d,
 first_value(d) OVER whole first_d,last_value(d) OVER whole last_d
 FROM feet WINDOW w AS (PARTITION BY source_id ORDER BY segment_index),
 whole AS (PARTITION BY source_id ORDER BY segment_index ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
), projected AS (
 SELECT source_id||':'||segment_index id,source_id,nodes,access_allowed,original,hint,radius,matched
 FROM local_feet WHERE
 NOT (ST_Equals(matched,ST_StartPoint(geom)) AND coalesce(prev_d,CASE WHEN closed THEN last_d END,d)<d)
 AND NOT (ST_Equals(matched,ST_EndPoint(geom)) AND coalesce(next_d,CASE WHEN closed THEN first_d END,d)<d)
), candidates AS (
 SELECT *,ST_Distance(original,matched) distance_m,ST_Distance(hint,matched) hint_distance_m
 FROM projected WHERE ST_DWithin(original,matched,radius)
), connectors AS (
 SELECT id endpoint,original,matched,ST_MakeLine(original,matched) geom FROM candidates
), /* SNAP_ISSUES */,
safe AS (
 SELECT c.* FROM candidates c WHERE c.access_allowed AND NOT EXISTS (SELECT 1 FROM connector_issues i WHERE i.endpoint=c.id)
), near AS (
 SELECT * FROM safe WHERE hint_distance_m<=CASE WHEN CAST(? AS integer)=1 THEN (SELECT min(hint_distance_m) FROM candidates)+1 ELSE (SELECT min(hint_distance_m) FROM safe)+1 END
), selected AS (
 SELECT id,source_id,nodes,ST_AsGeoJSON(ST_Transform(matched,4326),9) point,distance_m,hint_distance_m
 FROM near ORDER BY hint_distance_m,id LIMIT 17
), diagnostics AS (
 SELECT jsonb_build_object('radius_m',r.radius,
 'nearest_road_distance_m',(SELECT min(ST_Distance(geom,r.original)) FROM road_sources),
 'nearest_road_scope','loaded_guard_cells',
 'containing_building_count',(SELECT count(*) FROM src WHERE kind='building' AND ST_Covers(geom,r.original)),
 'entrance_data','NOT_PREPARED',
 'candidate_count',(SELECT count(*) FROM candidates),
 'safe_candidate_count',(SELECT count(*) FROM safe)) data FROM r
)
-- A metadata-only fallback row explains an empty selection; it is never a candidate.
SELECT selected.*,'[]'::jsonb checks,diagnostics.data diagnostics FROM selected CROSS JOIN diagnostics
UNION ALL
SELECT NULL::text,NULL::text,NULL::jsonb,NULL::text,NULL::double precision,NULL::double precision,
 (SELECT coalesce(jsonb_agg(code),'[]'::jsonb) FROM (
   SELECT DISTINCT i.code FROM connector_issues i JOIN candidates c ON c.id=i.endpoint WHERE c.access_allowed
   UNION SELECT 'SNAP_ROAD_ACCESS_UNKNOWN' FROM candidates WHERE NOT access_allowed
   UNION SELECT CASE
     WHEN NOT ST_DWithin(r.original,r.hint,r.radius) THEN 'SNAP_HINT_OUTSIDE_RADIUS'
     WHEN (SELECT min(ST_Distance(geom,r.original)) FROM road_sources)>r.radius THEN 'SNAP_RADIUS_EXCEEDED'
     WHEN NOT EXISTS(SELECT 1 FROM road_sources) THEN 'SNAP_ROAD_DATA_MISSING'
     ELSE 'SNAP_SEARCH_INCOMPLETE' END FROM r WHERE NOT EXISTS(SELECT 1 FROM candidates)
 ) rejected),diagnostics.data
FROM diagnostics
WHERE NOT EXISTS(SELECT 1 FROM selected)
ORDER BY hint_distance_m,id
