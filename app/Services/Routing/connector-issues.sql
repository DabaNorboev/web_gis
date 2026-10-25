connector_issues AS (
 -- Containment uses the original contour, not the 0.3 m inset used to detect
 -- material interior conflicts. One millimetre absorbs projection / GeoJSON round-off only;
 -- it is not an access allowance. Require one continuous exit from that contour.
 SELECT c.endpoint,'SNAP_THROUGH_BUILDING' code,jsonb_agg(b.id) ids
 FROM connectors c CROSS JOIN buildings b
 WHERE ST_Covers(b.geom,c.matched) OR
 (ST_Length(ST_Intersection(b.geom,c.geom))>0.5 AND NOT (
   (ST_Covers(b.full_geom,c.original) OR ST_DWithin(b.full_geom,c.original,0.001)) AND NOT ST_Covers(b.geom,c.matched)
   AND ST_GeometryType(ST_Intersection(ST_Buffer(b.full_geom,0.001),c.geom))='ST_LineString'))
 GROUP BY c.endpoint
 UNION ALL
 SELECT c.endpoint,'SNAP_THROUGH_BARRIER',jsonb_agg(s.id) FROM connectors c CROSS JOIN src s
 WHERE s.tags->>'barrier' IN ('wall','fence','retaining_wall')
 AND ST_Length(c.geom)>0.5 AND ST_Intersects(s.geom,c.geom) GROUP BY c.endpoint
 UNION ALL
 SELECT c.endpoint,'SNAP_NODE_ACCESS_UNKNOWN',jsonb_agg(s.id) FROM connectors c CROSS JOIN src s
 WHERE s.kind='node' AND NOT s.access_allowed
 AND ST_DWithin(s.geom,c.geom,0.25) GROUP BY c.endpoint
 UNION ALL
 SELECT c.endpoint,'SNAP_THROUGH_WATER',jsonb_agg(s.id) FROM connectors c CROSS JOIN src s
 WHERE s.kind='water' AND ST_Length(ST_Intersection(s.geom,c.geom))>0.5 GROUP BY c.endpoint
 UNION ALL
 SELECT c.endpoint,'SNAP_THROUGH_RAILWAY',jsonb_agg(s.id) FROM connectors c CROSS JOIN src s
 WHERE s.tags->>'railway' IN ('rail','narrow_gauge') AND ST_Length(c.geom)>0.5
 AND ST_Intersects(s.geom,c.geom) GROUP BY c.endpoint
 UNION ALL
 SELECT c.endpoint,'SNAP_CROSSES_ROAD',jsonb_agg(s.id) FROM connectors c CROSS JOIN src s
 WHERE s.kind='line' AND s.tags->>'highway' IN
 ('motorway','trunk','primary','secondary','tertiary','residential','unclassified','living_street','service',
 'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link')
 AND ST_Length(c.geom)>1 AND ST_Intersects(s.geom,ST_Difference(c.geom,ST_Buffer(c.matched,1)))
 GROUP BY c.endpoint
 UNION ALL
 SELECT c.endpoint,'OUTSIDE_CONFIRMED_COVERAGE',jsonb_build_array('pilot') FROM connectors c CROSS JOIN pilot
 WHERE NOT ST_Covers(pilot.geom,c.geom)
)
