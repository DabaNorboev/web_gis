import { selectedPoint, tripDistance } from '@/utils/trips'
import type { TripAnalysis, TripPoint, TripResult, TripMode } from '@/types/trips'
import type { SideKey } from '@/utils/comparison'

export interface ComparisonPlace { id: string; label: string; point: TripPoint | null }
export interface ComparisonTripHints { start?: TripPoint; target?: TripPoint }
export interface ComparisonTripLink {
    version: 1 | 2
    mode: TripMode
    places: { id: string; label: string; point: TripPoint }[]
    // Hints belong to one side AND one trip. They are never shared implicitly.
    roads: Partial<Record<SideKey, Record<string, ComparisonTripHints>>>
}
export function parseComparisonTrips(hash: string): { selection: ComparisonTripLink | null; invalid: boolean } {
    if (hash.length > 16000) return { selection: null, invalid: true }
    const values = new URLSearchParams(hash.replace(/^#/, '')).getAll('places')
    if (!values.length) return { selection: null, invalid: false }
    try {
        if (values.length !== 1 || values[0]!.length > 5000) throw Error()
        const input = JSON.parse(values[0]!) as ComparisonTripLink
        if ((input?.version !== 1 && input?.version !== 2) || !Array.isArray(input.places) || !input.places.length || input.places.length > 3) throw Error()
        const mode = input.mode === undefined ? 'driving' : input.mode
        // V1 readers ignore mode, so only V2 can safely carry walking selections.
        if (input.version === 1 ? mode !== 'driving' : input.mode !== 'walking') throw Error()
        const ids = new Set<string>()
        const places = input.places.map(p => {
            if (!p || !/^[a-zA-Z0-9_-]{1,48}$/.test(p.id) || ids.has(p.id) || typeof p.label !== 'string' || p.label.length > 80 || !selectedPoint(p.point)) throw Error()
            ids.add(p.id)
            // Original targets have no shared road hint.
            return { id: p.id, label: p.label, point: { lon: p.point.lon, lat: p.point.lat } }
        })
        const roads: ComparisonTripLink['roads'] = {}
        if (input.roads !== undefined && (!input.roads || typeof input.roads !== 'object' || Array.isArray(input.roads))) throw Error()
        for (const side of ['left', 'right'] as const) {
            const rows = input.roads?.[side]
            if (rows === undefined) continue
            if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw Error()
            const clean: Record<string, ComparisonTripHints> = Object.create(null)
            for (const [id, hints] of Object.entries(rows)) {
                if (!ids.has(id) || !hints || typeof hints !== 'object' || Array.isArray(hints)) throw Error()
                const next: ComparisonTripHints = {}
                for (const end of ['start', 'target'] as const) if (hints[end] !== undefined) {
                    if (!selectedPoint(hints[end])) throw Error()
                    next[end] = { lon: hints[end]!.lon, lat: hints[end]!.lat }
                }
                if (next.start || next.target) clean[id] = next
            }
            if (Object.keys(clean).length) roads[side] = clean
        }
        return { selection: { version: input.version, mode, places, roads }, invalid: false }
    } catch { return { selection: null, invalid: true } }
}
export function comparisonTripsFragment(selection: ComparisonTripLink): string {
    const canonical = selection.version === 1 && selection.mode === 'walking' ? { ...selection, version: 2 } : selection
    const hash = '#' + new URLSearchParams({ places: JSON.stringify(canonical) }).toString()
    const valid = parseComparisonTrips(hash).selection
    if (!valid) throw Error('Некорректная ссылка личных мест.')
    return '#' + new URLSearchParams({ places: JSON.stringify(valid) }).toString()
}
export function acceptedTrip(row: TripResult | null | undefined): row is TripResult & { route: NonNullable<TripResult['route']> } {
    return !!row && row.status === 'AVAILABLE' && !!row.route && !!row.snaps
        && Number.isFinite(row.route.distance_m) && row.route.distance_m >= 0
        && Number.isFinite(row.route.duration_s) && row.route.duration_s >= 0
}
export function pairedTripFact(a: { row: TripResult | null; source: TripAnalysis['source'] }, b: { row: TripResult | null; source: TripAnalysis['source'] }, mode: TripMode = 'driving'): string {
    if (!acceptedTrip(a.row) || !acceptedTrip(b.row)) return 'Недостаточно подтверждённых поездок для сравнения длины. Успех одной стороны не означает её преимущество.'
    if (!a.source || !b.source || JSON.stringify(a.source) !== JSON.stringify(b.source)) return 'Источники или версии расчёта различаются; прямой вывод о длине не сделан.'
    if (mode === 'walking' && (a.row.route_scope !== 'street_points' || b.row.route_scope !== 'street_points' || a.row.route.scope !== 'street_points' || b.row.route.scope !== 'street_points' || a.row.metrics.distance.scope !== 'street_points' || b.row.metrics.distance.scope !== 'street_points')) return 'Область пеших метрик не подтверждена; прямое сравнение не выполнено.'
    const left = tripDistance(a.row.route.distance_m), right = tripDistance(b.row.route.distance_m)
    if (mode === 'walking') {
        const detail = left === right ? `Длины уличных частей одинаковы в показанной точности: ${left}.` : `Уличная часть от ${a.row.route.distance_m < b.row.route.distance_m ? 'А' : 'Б'} короче: А — ${left}, Б — ${right}.`
        return `${detail} Полный путь от объектов и подходы не рассчитаны. Автоматического победителя нет.`
    }
    if (left === right) return `Длина автомобильных маршрутов одинакова в показанной точности: ${left}.`
    return `Автомобильный маршрут от ${a.row.route.distance_m < b.row.route.distance_m ? 'А' : 'Б'} короче: А — ${left}, Б — ${right}.`
}
