WITH r AS (
 SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) geom,
 ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) a,
 ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) b
), src AS (
 SELECT j->>'id' id,j->>'kind' kind,coalesce(j->'tags','{}'::jsonb) tags,
 coalesce(j->'nodes','[]'::jsonb) nodes,(j->>'access_allowed')::boolean access_allowed,
 ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(j->>'geometry'),4326),32646) geom
 FROM jsonb_array_elements(?::jsonb) j
), service AS (
 SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(?),4326),32646) geom
), box AS (
 SELECT ?::jsonb bbox
), pilot AS (
 SELECT ST_Intersection(service.geom,ST_Buffer(ST_Transform(ST_MakeEnvelope((bbox->>0)::float,(bbox->>1)::float,(bbox->>2)::float,(bbox->>3)::float,4326),32646),-CAST(? AS double precision))) geom FROM box CROSS JOIN service
), annotation AS (
 SELECT ?::jsonb nodes,CAST(? AS double precision) tolerance_m
), endpoint_pieces AS (
 SELECT ST_MakeLine(ST_PointN(r.geom,1),ST_PointN(r.geom,2)) start_piece,
 ST_MakeLine(ST_PointN(r.geom,ST_NPoints(r.geom)-1),ST_EndPoint(r.geom)) end_piece FROM r
), links AS (
 SELECT ST_MakeLine(a,ST_StartPoint(geom)) a,ST_MakeLine(ST_EndPoint(geom),b) b,ST_StartPoint(geom) sa,ST_EndPoint(geom) sb FROM r
), roads AS (
 SELECT s.*,ST_Length(ST_Intersection(r.geom,ST_Buffer(s.geom,0.25))) overlap_m FROM src s CROSS JOIN r
 WHERE s.kind='line' AND jsonb_exists(s.tags,'highway') AND ST_DWithin(s.geom,r.geom,1.5)
), endpoint_roads AS (
 SELECT roads.*,p.endpoint FROM roads CROSS JOIN annotation CROSS JOIN endpoint_pieces
 CROSS JOIN LATERAL (VALUES ('start',annotation.nodes->0,endpoint_pieces.start_piece),
 ('target',annotation.nodes->-1,endpoint_pieces.end_piece)) p(endpoint,node,piece)
 WHERE roads.nodes @> jsonb_build_array(p.node) AND ST_CoveredBy(p.piece,ST_Buffer(roads.geom,annotation.tolerance_m))
), endpoint_access_issues AS (
 SELECT 'ENDPOINT_ACCESS_REVIEW' code,endpoint FROM endpoint_roads WHERE NOT access_allowed
 UNION SELECT 'ENDPOINT_NODE_ACCESS_REVIEW',p.endpoint FROM src gates CROSS JOIN r CROSS JOIN annotation
 CROSS JOIN LATERAL (VALUES ('start',ST_StartPoint(r.geom)),('target',ST_EndPoint(r.geom))) p(endpoint,point)
 WHERE gates.kind='node' AND NOT gates.access_allowed AND ST_DWithin(gates.geom,p.point,annotation.tolerance_m)
 AND EXISTS (SELECT 1 FROM endpoint_roads WHERE endpoint_roads.endpoint=p.endpoint
   AND endpoint_roads.nodes @> jsonb_build_array(split_part(gates.id,'/',2)::bigint))
), annotated_bridge_edges AS (
 -- Only an actual source edge traversed by this route can establish a level.
 SELECT roads.id,roads.tags,roads.nodes,segment.geom FROM roads
 CROSS JOIN LATERAL ST_DumpSegments(roads.geom) segment CROSS JOIN annotation
 WHERE roads.access_allowed AND roads.tags->>'bridge' IN ('yes','viaduct')
 AND roads.tags->>'layer' ~ '^-?[0-9]{1,3}$'
 AND EXISTS (SELECT 1 FROM jsonb_array_elements(annotation.nodes) WITH ORDINALITY n(value,ord)
   WHERE (n.value=roads.nodes->((segment.path)[1]-1) AND annotation.nodes->(n.ord::int)=roads.nodes->((segment.path)[1]))
      OR (n.value=roads.nodes->((segment.path)[1]) AND annotation.nodes->(n.ord::int)=roads.nodes->((segment.path)[1]-1)))
), barrier_crossings AS (
 SELECT src.id,src.tags,src.nodes,(ST_Dump(ST_Intersection(src.geom,r.geom))).geom crossing
 FROM src CROSS JOIN r WHERE src.tags->>'barrier' IN ('wall','fence','retaining_wall') AND ST_Crosses(src.geom,r.geom)
), unconfirmed_barrier_crossings AS (
 SELECT b.* FROM barrier_crossings b CROSS JOIN r CROSS JOIN annotation
 WHERE NOT EXISTS (SELECT 1 FROM src gates WHERE gates.kind='node' AND ST_DWithin(gates.geom,b.crossing,1)
   AND gates.access_allowed AND coalesce(gates.tags->>'locked','no')<>'yes')
 AND NOT EXISTS (SELECT 1 FROM annotated_bridge_edges e
   WHERE b.tags->>'layer' ~ '^-?[0-9]{1,3}$'
   AND (CASE WHEN b.tags->>'layer' ~ '^-?[0-9]{1,3}$' THEN (b.tags->>'layer')::int END)
       <> (CASE WHEN e.tags->>'layer' ~ '^-?[0-9]{1,3}$' THEN (e.tags->>'layer')::int END)
   AND ST_GeometryType(b.crossing)='ST_Point' AND ST_DWithin(e.geom,b.crossing,annotation.tolerance_m)
   AND ST_CoveredBy(ST_Intersection(r.geom,ST_Buffer(b.crossing,1)),ST_Buffer(e.geom,annotation.tolerance_m))
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b.nodes) n WHERE e.nodes @> jsonb_build_array(n)))
), structures AS (
 SELECT ST_Union(ST_Buffer(geom,2)) geom FROM roads WHERE tags->>'bridge' IN ('yes','viaduct') OR tags->>'tunnel' IN ('yes','building_passage')
), buildings AS (
 SELECT id,geom full_geom,ST_Buffer(geom,-0.3) geom FROM src WHERE kind='building'
), connectors AS (
 SELECT 'start' endpoint,r.a original,links.sa matched,links.a geom FROM r CROSS JOIN links
 UNION ALL SELECT 'target',r.b,links.sb,links.b FROM r CROSS JOIN links
), /* SNAP_ISSUES */, issues AS (
 SELECT code,ids FROM connector_issues
 UNION ALL SELECT 'INDOOR_ROUTE',jsonb_agg(id) FROM roads WHERE overlap_m>3 AND (tags->>'indoor'='yes' OR tags->>'highway' IN ('corridor','elevator') OR tags->>'conveying' IN ('yes','forward','backward'))
 -- Annotations cover whole source edges (checked in PHP), but may omit clipped
 -- first/last edges. Match those by an adjacent annotated node AND the complete
 -- endpoint piece within the documented precision, never by overlap > 3 metres.
 UNION ALL SELECT 'ENDPOINT_ACCESS_REVIEW',jsonb_agg(id) FROM endpoint_roads WHERE NOT access_allowed
 UNION ALL SELECT 'ENDPOINT_NODE_ACCESS_REVIEW',jsonb_agg(gates.id) FROM src gates CROSS JOIN r CROSS JOIN annotation
 WHERE gates.kind='node' AND NOT gates.access_allowed
 AND (ST_DWithin(gates.geom,ST_StartPoint(r.geom),annotation.tolerance_m) OR ST_DWithin(gates.geom,ST_EndPoint(r.geom),annotation.tolerance_m))
 AND EXISTS (SELECT 1 FROM endpoint_roads WHERE endpoint_roads.nodes @> jsonb_build_array(split_part(gates.id,'/',2)::bigint))
 UNION ALL SELECT 'ROUTE_BARRIER_REVIEW',jsonb_agg(id) FROM unconfirmed_barrier_crossings
 UNION ALL SELECT 'ROUTE_THROUGH_BUILDING',jsonb_agg(id) FROM buildings CROSS JOIN r CROSS JOIN structures WHERE ST_Length(ST_Difference(ST_Intersection(buildings.geom,r.geom),coalesce(structures.geom,ST_GeomFromText('POLYGON EMPTY',32646))))>1
 UNION ALL SELECT 'RAILWAY_CROSSING_REVIEW',jsonb_agg(src.id) FROM src CROSS JOIN r CROSS JOIN structures WHERE src.tags->>'railway' IN ('rail','narrow_gauge') AND ST_Crosses(src.geom,r.geom) AND NOT ST_CoveredBy(ST_Intersection(src.geom,r.geom),coalesce(structures.geom,ST_GeomFromText('POLYGON EMPTY',32646))) AND NOT EXISTS
 (SELECT 1 FROM roads WHERE overlap_m>3 AND ST_DWithin(roads.geom,ST_Intersection(src.geom,r.geom),0.25) AND
 (CASE WHEN coalesce(src.tags->>'layer','0') ~ '^-?[0-9]+$' THEN coalesce(src.tags->>'layer','0')::int END) <>
 (CASE WHEN coalesce(roads.tags->>'layer','0') ~ '^-?[0-9]+$' THEN coalesce(roads.tags->>'layer','0')::int END))
 UNION ALL SELECT 'WATER_CROSSING_REVIEW',jsonb_agg(id) FROM src CROSS JOIN r CROSS JOIN structures WHERE kind='water' AND ST_Length(ST_Difference(ST_Intersection(src.geom,r.geom),coalesce(structures.geom,ST_GeomFromText('POLYGON EMPTY',32646))))>2
)
SELECT (SELECT jsonb_object_agg(code,ids) FROM issues WHERE ids IS NOT NULL) issues,ST_Length(r.geom) length_m,
 (SELECT jsonb_agg(jsonb_build_object('code',code,'endpoint',endpoint,'stage',stage)) FROM (
   SELECT code,endpoint,'connector' stage FROM connector_issues
   UNION SELECT code,endpoint,'geometry' stage FROM endpoint_access_issues
 ) localized) connector_diagnostics,
 (SELECT ST_Length(ST_Intersection(r.geom,ST_Union(ST_Buffer(roads.geom,1.5)))) FROM roads) covered_length_m,
 (SELECT coalesce(bool_or(ST_DWithin(roads.geom,r.a,1.5)),false) FROM roads) on_network,
 (SELECT ST_Covers(pilot.geom,r.geom) AND ST_Covers(pilot.geom,r.a) AND ST_Covers(pilot.geom,r.b) FROM pilot) in_scope
FROM r
