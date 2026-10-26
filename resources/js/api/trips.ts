import type { TripAnalysis, TripSelection } from '@/types/trips'

// Response identity is checked before a route enters state or the map. These are
// transport/contract checks; access and geometry remain the backend's responsibility.
function matchesSelection(response: TripAnalysis, selection: TripSelection): boolean {
    const same = (a: { lon: number; lat: number } | undefined, b: { lon: number; lat: number }) => !!a && a.lon === b.lon && a.lat === b.lat
    if (!response || response.mode !== selection.mode || !same(response.start, selection.start)
        || !Array.isArray(response.results) || response.results.length !== selection.places.length) return false
    if (selection.mode === 'walking' && (response.route_scope !== 'street_points'
        || (response.source && (response.source.engine !== 'ORS' || response.source.profile !== 'foot-walking')))) return false
    return selection.places.every((place, index) => {
        const rows = response.results.filter(row => row?.index === index)
        const row = rows[0]
        if (rows.length !== 1 || !row || !same(row.start, selection.start) || !same(row.target, place)) return false
        if (selection.mode !== 'walking') return true
        const streetStart = selection.start.road ?? selection.start, streetTarget = place.road ?? place
        if (row.route_scope !== 'street_points' || !same(row.street_points?.start, streetStart) || !same(row.street_points?.target, streetTarget)) return false
        for (const end of ['start', 'target'] as const) {
            const approach = row.approaches?.[end]
            const point = end === 'start' ? selection.start : place
            if (!approach || !same(approach.original, point) || !same(approach.selected_street, point.road ?? point)
                || approach.distance_m !== null || approach.duration_s !== null
                || approach.status !== (point.road ? 'UNKNOWN' : 'NOT_INCLUDED')) return false
        }
        for (const key of ['distance', 'duration'] as const) {
            if (row.metrics?.[key]?.scope !== 'street_points' || row.address_metrics?.[key]?.value !== null
                || row.address_metrics?.[key]?.quality?.method !== null) return false
            if (row.status !== 'AVAILABLE' && row.metrics[key].value !== null) return false
        }
        if (row.status !== 'AVAILABLE') return row.route === null && row.snaps === null
        return row.route?.scope === 'street_points' && !!row.snaps && !!response.source
            && Number.isFinite(row.route.distance_m) && row.route.distance_m > 0
            && Number.isFinite(row.route.duration_s) && row.route.duration_s > 0
            && row.metrics.distance.value === row.route.distance_m && row.metrics.duration.value === row.route.duration_s
    })
}

export async function fetchTrips(selection: TripSelection, signal: AbortSignal): Promise<TripAnalysis> {
    const response = await fetch('/api/v1/trips/analyze', { method: 'POST', signal, cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: selection.mode, start: selection.start, places: selection.places }) })
    if (!response.ok) throw new Error(response.status === 422 ? 'Проверьте координаты и количество мест.'
        : response.status === 429 ? 'Слишком много расчётов. Подождите немного и повторите.' : 'Расчёт сейчас недоступен. Повторите позже.')
    try {
        const result = await response.json() as TripAnalysis
        if (matchesSelection(result, selection)) return result
    } catch { /* A decoding failure must not expose raw response text. */ }
    throw new Error('Ответ не соответствует выбранному режиму и точкам. Повторите расчёт.')
}
