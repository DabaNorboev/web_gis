export function pointReference(match = 'NEARBY', ids = ['osm:way:1']) {
    return { data: { match, requires_choice: ids.length > 1, candidates: match === 'NONE' ? [] : ids.map((id, i) => ({
        id, label: `Synthetic reference ${i + 1}`, object_type: 'building', geometry_type: 'POLYGON', distance_m: match === 'CONTAINING' ? 0 : 25 + i * .5,
    })) }, meta: { source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: null, nearby_radius_m: 100,
        calculated_at: '2026-11-04T00:00:00Z', coverage: { status: 'UNKNOWN', reason: 'Synthetic coverage unknown' },
        quality: { method: match === 'NEARBY' ? 'PROXY' : match === 'CONTAINING' ? 'DERIVED' : null, availability: match === 'NONE' ? 'INSUFFICIENT_DATA' : 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Synthetic bounded dataset' } } }
}
