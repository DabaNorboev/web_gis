# Offline checker provenance

`historical_geometry.py`, `walking-policy.json` and `extract_nodes.py` are exact
copies from this project's retained Git object
`236a8d891af87c0e2396e16cf99620949299363b`, directory
`experiments/pedestrian-routing-poc-2026-10-22/`. `historical_review.py` copies
that object's `review.py` through the `Reviewer` class, excluding the old driver;
imports are renamed and driving access delegates to the new mode policy.
These are project-local historical modules, not a new installed dependency.

`review_ors.py` adapts ORS GeoJSON / OsmId ranges and adds explicit car access
inheritance, barrier and direction checks. A passing route is only consistent
with retained source geometry and known obstacles. All user distance/time fields
remain null. Neither this review nor an ORS response confirms an entrance or
physical passage. Historical walking bridge/rail conflicts stay unresolved.

`extract_nodes.py` runs with existing pyosmium and reads `/input/pilot.osm.pbf`;
stdout must go to a new evidence directory's `nodes.jsonl`. It emits retained
tagged source nodes; the old extract's standalone-node omissions remain.

The review reads `output/{walking,driving}/responses.json`, `output/nodes.jsonl`,
the unchanged fixed controls, historical context and exported obstacles. It
creates `review.json` and `review.csv` exclusively and never calls HTTP, Docker,
Laravel or a database. Geometry checking intentionally rejects uncertain
attribution instead of relaxing thresholds. Building origins remain rejected in
both modes; this is stricter than the current car UI's explicit road choices.

This adapter does not prove node-identity continuity between geometrically
coincident segments or validate every car turn restriction relation. Its model
consistency status is deliberately weaker than the production provider contract.

## Revision v2 (26 October 2026)

The modules above and the original evidence are unchanged. New `source_chain.py`
attributes each ORS shape segment only to its declared way, retaining all original
source pieces and checking node-identity continuity. `endpoint_groups.py` groups
adjacent projections only by one actual common junction or same-edge precision.
`revision_review.py` checks mode access and obstacles on those original pieces;
it does not use the historical one-segment matcher or case-name veto.

The 1.25m representation allowance comes from the pinned 1m import simplification
plus 0.25m precision and never expands connectors, access or obstacle clearances.
Point crossing evidence cannot authorize a collinear barrier/rail overlap; each
hazard needs its own evidence. The 0.25m source-end precision and 20/35m snapping
limits remain. Unknown source chains, crossings and policy stay unknown.

V2 results are written in a new evidence directory; v1 outputs are never replaced.
All product metrics remain null. Car turn restriction relations, real entrances,
field access and time remain unvalidated. See REVISION-PLAN.md / REVISION-RESULT.md.
