export const keys = ['poi', 'satellite', 'air']
export const categories = ['grocery', 'pharmacy', 'official_stop', 'park']
export const input = { place: { kind: 'point', lon: 0.12, lat: 0.23 }, radius_m: 500 }
export const timestamp = '2026-11-04T00:00:00.000000Z'
const coverage = () => ({ status: 'COVERED', reason: 'Synthetic coverage', available_radius_m: 1000 })
const completeness = () => ({ status: 'UNKNOWN', reason: 'Synthetic completeness unknown' })
export const satellitePin = 'a'.repeat(64)
export const satelliteLegend = {
    version: 'ndvi-fixed-v2', units: 'dimensionless', intervals: 'Synthetic fixture; not a real legend publication.',
    unknown: { color: '#00000000', label: 'Неизвестно / исключено маской' },
    classes: [
        { min: -1, max: -0.2, color: '#234682', label: 'NDVI -1 … -0.2' },
        { min: -0.2, max: 0, color: '#508cb9', label: 'NDVI -0.2 … 0' },
        { min: 0, max: 0.2, color: '#b9af9b', label: 'NDVI 0 … 0.2' },
        { min: 0.2, max: 0.4, color: '#cda55f', label: 'NDVI 0.2 … 0.4' },
        { min: 0.4, max: 0.6, color: '#d7dc8c', label: 'NDVI 0.4 … 0.6' },
        { min: 0.6, max: 0.8, color: '#73af5a', label: 'NDVI 0.6 … 0.8' },
        { min: 0.8, max: 1, color: '#237337', label: 'NDVI 0.8 … 1' },
    ],
}
export function satelliteScenes(date) {
    return [{
        scene_id: `S2A_46VDH_${date.replaceAll('-', '')}_0_L2A`, product_uri: `Synthetic_${date}_46VDH.SAFE`,
        tile: 'MGRS-46VDH', platform: 'sentinel-2a', baseline: '05.10', datatake: `Synthetic_datatake_${date}`,
        acquired_at_catalog: `${date}T05:13:01.659000Z`, acquired_at_granule: `${date}T05:13:01.659442Z`,
    }]
}
export function satelliteRef(date) {
    return {
        date, release_id: `${date}-synthetic-a9-v1`, manifest_sha256: date === '2024-05-07' ? '1'.repeat(64) : '2'.repeat(64),
        scenes: satelliteScenes(date),
        warnings: date === '2024-05-07'
            ? [{ code: 'EARLY_SPRING_SNOW', message: 'Synthetic early-spring snow and phenology note; not a summer state.' }]
            : [],
        limitations: ['Synthetic fixture limitation, not a real dataset.'],
    }
}
export function satelliteCoverage(circle = 1600, usable = circle) {
    return {
        circle_pixels: circle, source_footprint_pixels: circle, prepared_pixels: circle,
        outside_rectangle_pixels: 0, inside_rectangle_outside_target_pixels: 0,
        geographic_pixels: circle, usable_pixels: usable,
        source_footprint_fraction: 1, prepared_fraction: 1, geographic_fraction: 1, usable_fraction: usable / circle,
        reason_counts: Object.fromEntries(['valid', 'nodata', 'ambiguous_COG_DN1', 'saturated', 'cloud_shadow', 'cloud_or_cirrus',
            'unclassified', 'SCL2_dark_or_shadow', 'snow', 'defective', 'numerical', 'unsupported_SCL', 'outside_target',
            'outside_source_footprints'].map((key, index) => [key, index === 0 ? usable : index === 1 ? circle - usable : 0])),
        source_pixels: { 1: circle }, scope: 'full_circle_native_pixel_centers',
    }
}
function satelliteRelease(date) {
    const usable = date === '2024-05-07' ? 1400 : 1600
    return { ...satelliteRef(date), status: 'READY', reason: null, coverage: satelliteCoverage(1600, usable),
        mean_ndvi: date === '2024-05-07' ? 0.31 : 0.44, mean_ndvi_reason: null }
}
export function satelliteRaster(date, layer) {
    return {
        type: 'raster', tiles: [`/api/v1/satellite/${satellitePin}/${date}/${layer}/{z}/{x}/{y}.png`],
        bounds: [-180, -85, 180, 85], tileSize: 256, minzoom: 10, maxzoom: 13, scheme: 'xyz',
        attribution: 'Synthetic satellite fixture',
    }
}
export function satelliteDataFor(date) {
    const dates = ['2024-05-07', '2024-08-15']
    const releases = dates.map(satelliteRelease)
    const selected = date === null
        ? { date: null, status: 'UNAVAILABLE', reason: 'DATE_NOT_SELECTED', coverage: null, mean_ndvi: null, mean_ndvi_reason: 'DATE_NOT_SELECTED', layers: null }
        : releases.find(release => release.date === date)
            ? { ...releases.find(release => release.date === date), layers: { 'true-color': satelliteRaster(date, 'true-color'), ndvi: satelliteRaster(date, 'ndvi') } }
            : { date, status: 'UNAVAILABLE', reason: 'DATE_NOT_IN_CATALOG', coverage: null, mean_ndvi: null, mean_ndvi_reason: 'DATE_NOT_IN_CATALOG', layers: null }
    return {
        status: 'READY', reason: null, catalog_sha256: 'b'.repeat(64), source_index_sha256: 'c'.repeat(64),
        method_version: 'placelens-s2-date-v1', mask_version: 'scl456-dn-city-v1', legend_version: 'ndvi-fixed-v2',
        available_dates: releases.map(({ date: value, release_id, manifest_sha256, scenes, warnings, limitations }) => ({ date: value, release_id, manifest_sha256, scenes, warnings, limitations })),
        releases, delivery_status: 'READY', legend: satelliteLegend, selected,
    }
}
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
                : key === 'satellite' ? satelliteDataFor(r.date) : { stations: [], missing_selected_ids: [], counts: { selected: 0, nearest: 0, other: 0 } }
            if (key === 'poi') block.method_version = 'synthetic-1'
        }
        return [key, block]
    }))
    return { analysis_version: 1, place: { kind: r.place.kind, address, label: address?.label ?? null, point }, radius_m: r.radius_m, date: r.date,
        station_selection: r.stations, calculated_at: timestamp, analysis_bounds: [west, south, east, north],
        analysis_area: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] }, blocks }
}
