// Synthetic contract responses only; no routing or access guards are replaced.
const point = value => ({ lon: value.lon, lat: value.lat })
const metric = (key, value, unit, scope) => ({ key, value, unit, scope,
    source: 'OpenStreetMap / ORS foot-walking', dataset_import_id: null, dataset_version: 'synthetic',
    observed_at: null, calculated_at: '2026-10-26T00:00:00Z',
    quality: { method: value === null ? null : 'DERIVED', availability: value === null ? 'INSUFFICIENT_DATA' : 'AVAILABLE',
        freshness: 'UNKNOWN', reason: value === null ? 'Подходы не подтверждены.' : 'Синтетический маршрут.' } })
function walkingRow(value, index) {
    const originalStart = point(value.start), originalTarget = point(value.places[index])
    const streetStart = point(value.start.road ?? value.start), streetTarget = point(value.places[index].road ?? value.places[index])
    const shift = (a, b) => a.lon === b.lon && a.lat === b.lat ? 0 : 30
    const approach = (original, street, explicit) => ({ status: explicit ? 'UNKNOWN' : 'NOT_INCLUDED',
        original, selected_street: street, selection_shift_m: shift(original, street), distance_m: null, duration_s: null,
        reason: 'Смещение не является рассчитанным подходом.' })
    return { index, label: value.places[index].label, start: originalStart, target: originalTarget,
        route_scope: 'street_points', street_points: { start: streetStart, target: streetTarget },
        selection_kind: value.start.road || value.places[index].road ? 'DIFFERENT_STREET_POINTS' : 'INPUT_STREET_POINTS',
        approaches: { start: approach(originalStart, streetStart, !!value.start.road),
            target: approach(originalTarget, streetTarget, !!value.places[index].road) },
        status: 'AVAILABLE', reason: 'Синтетическая проверенная дорожная часть; входы неизвестны.', checks: [],
        diagnostics: { version: 1, issues: [] }, road_choices: null,
        route: { scope: 'street_points', geometry: { type: 'LineString', coordinates: [[streetStart.lon, streetStart.lat], [streetTarget.lon, streetTarget.lat]] },
            distance_m: 1234 + index, duration_s: 480 },
        snaps: { start: { original: streetStart, matched: streetStart, distance_m: 0 },
            target: { original: streetTarget, matched: streetTarget, distance_m: 0 } },
        metrics: { distance: metric('route_distance', 1234 + index, 'm', 'street_points'),
            duration: metric('route_duration', 480, 's', 'street_points') },
        address_metrics: { distance: metric('object_to_object_distance', null, 'm', 'objects'),
            duration: metric('object_to_object_duration', null, 's', 'objects') } }
}
export function walkingResponse(value) { return { mode: 'walking', route_scope: 'street_points', start: point(value.start),
    results: value.places.map((_, i) => walkingRow(value, i)),
    source: { name: 'Synthetic OSM', engine: 'ORS', engine_version: 'synthetic', profile: 'foot-walking',
        dataset_version: 'synthetic', pbf_sha256: 'synthetic', extract_sha256: 'synthetic', manifest_sha256: 'synthetic',
        observed_at: null, prepared_at: '2026-10-26T00:00:00Z', pilot_bbox: [92.8, 55.9, 93, 56.1], guard_imports: [] },
    limitation: 'Синтетическая дорожная часть; путь от объектов и подходы неизвестны.' } }
export function carResponse(value) { return { mode: 'driving', start: point(value.start),
    results: value.places.map((place, index) => ({ index, label: place.label, start: point(value.start), target: point(place),
        status: 'AVAILABLE', reason: 'Синтетический автомобильный ответ.', checks: [], diagnostics: { version: 1, issues: [] },
        route: { geometry: { type: 'LineString', coordinates: [[value.start.lon, value.start.lat], [place.lon, place.lat]] }, distance_m: 2100, duration_s: 390 },
        snaps: { start: { original: point(value.start), matched: point(value.start), distance_m: 0 },
            target: { original: point(place), matched: point(place), distance_m: 0 } },
        road_choices: null, metrics: { distance: { value: 2100 }, duration: { value: 390 } } })),
    source: null, limitation: 'Синтетический автомобильный ответ.' } }
