// Synthetic API-contract data. These are not observations about real addresses.
export const places = {
    a: { id: 'osm:way:101', label: 'Тестовая улица, 1', lon: 92.87, lat: 56.01, stops: 4 },
    b: { id: 'osm:way:202', label: 'Тестовая улица, 2', lon: 92.89, lat: 56.02, stops: 7 },
    c: { id: 'osm:way:303', label: 'Новая улица, 3', lon: 92.91, lat: 56.03, stops: 11 },
    d: { id: 'osm:way:404', label: 'Другая улица, 4', lon: 92.93, lat: 56.04, stops: 13 },
}
export const ambiguousPlaces = Array.from({ length: 10 }, (_, index) => ({ id: `osm:way:${501 + index}`, label: 'Неоднозначная улица, 32', lon: 92.87 + index * .00001, lat: 56.01, stops: 3 }))
export const ambiguousGroup = {
    id: 'group-ambiguous', label: 'Неоднозначная улица, 32', match_type: 'exact', object_count: 10,
    bounds: [92.8699, 56.0099, 92.8702, 56.0101],
    objects: ambiguousPlaces.map(place => ({ ...addressObject(place), object_type: 'building', point_method: 'point_on_surface', geometry: { type: 'Polygon', coordinates: [[[place.lon - .000025, place.lat - .000025], [place.lon + .000025, place.lat - .000025], [place.lon + .000025, place.lat + .000025], [place.lon - .000025, place.lat + .000025], [place.lon - .000025, place.lat - .000025]]] } })),
}
const calculated_at = '2026-10-22T00:00:00Z'
const quality = { method: 'DERIVED', availability: 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Синтетическая фикстура, не сведения о местности.' }
function metric(key, value, unit, source = 'OpenStreetMap') {
    return { key, value, unit, source, dataset_import_id: 1, observed_at: null, source_updated_at: null, calculated_at, quality: { ...quality } }
}
function coverage(radius) {
    return { status: 'COVERED', reason: 'Тестовое покрытие.', dataset_import_id: 1, radius_m: radius, available_radius_m: 1000, buffer_m: 1000, service_boundary_sha256: null, data_boundary_sha256: null }
}
export function addressObject(place) {
    return { id: place.id, lon: place.lon, lat: place.lat, object_type: 'address_point', point_method: 'osm_node', levels: null, geometry: { type: 'Point', coordinates: [place.lon, place.lat] } }
}
export function searchResponse(query) {
    if (query.toLowerCase().includes('неоднознач')) return { data: [ambiguousGroup], meta: { quality: { availability: 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Синтетические варианты одного адреса.' } } }
    const data = Object.values(places).filter(place => place.label.toLowerCase().includes(query.toLowerCase())).map(place => ({
        id: `group-${place.id}`, label: place.label, match_type: 'exact', object_count: 1,
        bounds: [place.lon - .001, place.lat - .001, place.lon + .001, place.lat + .001], objects: [addressObject(place)],
    }))
    return { data, meta: { source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: null, quality: { availability: 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Синтетический поиск.' } } }
}
export function profile(place, radius = 500) {
    const point = { lon: place.lon, lat: place.lat }
    // A precomputed rectangular fixture replaces a GIS calculation, never application logic.
    const extent = radius === 300 ? .003 : .005
    const bounds = [place.lon - extent, place.lat - extent, place.lon + extent, place.lat + extent]
    const area = { type: 'Polygon', coordinates: [[[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]], [bounds[0], bounds[1]]]] }
    const stops = Array.from({ length: place.stops }, (_, index) => ({
        id: Number(place.id.split(':').at(-1)) * 100 + index, source_id: `fixture-${place.id}-${index}`,
        name: `Остановка ${index + 1} · ${place.label}`, lon: place.lon + .001 + index * .00008, lat: place.lat + .001 + index * .00008, distance_m: 150 + index * 6,
    }))
    const transport = {
        point, radius_m: radius, scope: 'imported_stops', analysis_area: area, analysis_bounds: bounds, stops_in_radius: stops,
        nearest_stop: { ...stops[0], address: null }, coverage: coverage(radius),
        metrics: Object.fromEntries([['stops_count', place.stops, 'count'], ['nearest_stop_distance', 150, 'm'], ['unique_routes_count', 2, 'count'], ['identified_routes_count', 2, 'count']].map(([key, value, unit]) => [key, metric(key, value, unit, '24bpd')])),
    }
    const blocks = { transport: { status: 'READY', data: transport, message: null } }
    const area_layers = {}, linear_layers = {}
    for (const kind of ['parks', 'vegetation', 'water', 'roads', 'railways']) {
        const metrics = { nearest_distance: metric('nearest_distance', 200, 'm') }
        if (['parks', 'vegetation', 'water'].includes(kind)) {
            metrics.share = metric('share', kind === 'water' ? 0 : 5, '%')
            metrics.area = metric('area', kind === 'water' ? 0 : 100, 'm2')
        }
        blocks[kind] = { status: 'READY', message: null, data: { coverage: coverage(radius), nearest: null, metrics } }
        const feature = { type: 'Feature', properties: { id: `${place.id}-${kind}`, name: place.label }, geometry: area }
        if (kind === 'parks') blocks[kind].data.nearest = { id:feature.properties.id, name:place.label }
        const data = { type: 'FeatureCollection', features: [feature], coverage: coverage(radius), source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: null, quality: { ...quality }, radius_m: radius }
        if (kind === 'roads' || kind === 'railways') {
            feature.geometry = { type: 'LineString', coordinates: [[bounds[0], place.lat], [bounds[2], place.lat]] }
            feature.properties.feature_type = kind === 'roads' ? 'primary' : 'rail'
            linear_layers[kind] = { status: 'READY', message: null, data }
        } else area_layers[kind] = { status: 'READY', message: null, data }
    }
    if (place.id === places.b.id) {
        const missing = blocks.water.data.metrics.share
        missing.value = null
        missing.quality = { ...quality, method: null, availability: 'INSUFFICIENT_DATA', reason: 'Недостаточное покрытие тестового источника.' }
    }
    return {
        address: { id: place.id, label: place.label, object: addressObject(place), bounds, source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: null, reason: 'Тестовая адресная точка, не вход.' },
        point, radius_m: radius, calculated_at, blocks,
        map: { analysis_area: area, analysis_bounds: bounds, stops_in_radius: stops, area_layers, linear_layers },
    }
}
export function comparisonUrl(left = places.a, right = places.b, radius = 500) {
    return `/compare?${new URLSearchParams({ left: left.id, right: right.id, radius_m: String(radius) })}`
}
