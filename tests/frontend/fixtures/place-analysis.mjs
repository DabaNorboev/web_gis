export const keys = ['poi', 'satellite', 'air']
export const categories = ['grocery', 'pharmacy', 'official_stop', 'park']
export const input = { place: { kind: 'point', lon: 0.12, lat: 0.23 }, radius_m: 500 }
export const timestamp = '2026-11-04T00:00:00.000000Z'
const coverage = () => ({ status: 'COVERED', reason: 'Synthetic coverage', available_radius_m: 1000 })
const completeness = () => ({ status: 'UNKNOWN', reason: 'Synthetic completeness unknown' })
export function normalized(request) {
    return { ...structuredClone(request), radius_m: request.radius_m ?? 500, date: request.date ?? null,
        stations: { selected_ids: [...(request.stations?.selected_ids ?? [])], radius_m: request.stations?.radius_m ?? 5000 }, blocks: request.blocks ?? keys }
}
export function responseFor(request = input, statuses = {}) {
    const r = normalized(request)
    const point = r.place.kind === 'point' ? { lon: r.place.lon, lat: r.place.lat } : { lon: .4, lat: .5 }
    const address = r.place.kind !== 'address' ? null : {
        id: r.place.address_id, label: 'Synthetic exact address', object: { ...point, id: r.place.address_id,
            geometry: { type: 'Point', coordinates: [point.lon, point.lat] }, point_method: 'osm_node', object_type: 'address_point', levels: null },
        bounds: [point.lon, point.lat, point.lon, point.lat], source: 'Synthetic', dataset_import_id: 1, observed_at: null, source_updated_at: null, reason: 'Synthetic resolver',
    }
    // A deliberate asymmetric fixture contour, never a geographical analysis.
    const scale = r.radius_m / 500
    const west = point.lon - .001 * scale, east = point.lon + .002 * scale, south = point.lat - .003 * scale, north = point.lat + .004 * scale
    const blocks = Object.fromEntries(r.blocks.map(key => {
        const status = statuses[key] ?? 'UNAVAILABLE'
        const block = { status, code: status === 'READY' ? null : status === 'ERROR' ? 'BLOCK_CALCULATION_FAILED' : 'BLOCK_NOT_AVAILABLE',
            message: status === 'READY' ? null : `Synthetic ${key} provider unavailable`, calculated_at: timestamp,
            coverage: key === 'poi' ? { ...coverage(), by_category: Object.fromEntries(categories.map(c => [c, coverage()])) } : null,
            completeness: key === 'satellite' ? null : key === 'air' ? completeness() : { ...completeness(), by_category: Object.fromEntries(categories.map(c => [c, completeness()])) }, data: null }
        if (status === 'READY') {
            block.data = key === 'poi' ? { items: [{ id: 'osm:node:1', category: 'pharmacy', name: 'Synthetic API pharmacy', address: null,
                geometry: { type: 'Point', coordinates: [point.lon, point.lat] }, point, distance_m: 0, access: null, source: 'Synthetic', dataset_import_id: 1,
                observed_at: null, source_updated_at: null }], count: 1, counts_by_category: { grocery: 0, pharmacy: 1, official_stop: 0, park: 0 } }
                : key === 'satellite' ? { available_dates: [], selected: null } : { stations: [], missing_selected_ids: [], counts: { selected: 0, nearest: 0, other: 0 } }
            if (key === 'poi') block.method_version = 'synthetic-1'
        }
        return [key, block]
    }))
    return { analysis_version: 1, place: { kind: r.place.kind, address, label: address?.label ?? null, point }, radius_m: r.radius_m, date: r.date,
        station_selection: r.stations, calculated_at: timestamp, analysis_bounds: [west, south, east, north],
        analysis_area: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] }, blocks }
}
