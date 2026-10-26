import type { Coordinates } from '@/types/transport'
import type { TripSelection, TripPoint } from '@/types/trips'

function point(value: unknown): value is Coordinates {
    if (!value || typeof value !== 'object') return false
    const p = value as Coordinates
    return typeof p.lon === 'number' && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180
        && typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90
}

export function selectedPoint(value: unknown): value is TripPoint {
    return point(value) && (!('road' in value) || point((value as TripPoint).road))
}
export function copyPoint(value: TripPoint): TripPoint {
    return { lon: value.lon, lat: value.lat, ...(value.road ? { road: { lon: value.road.lon, lat: value.road.lat } } : {}) }
}

export function parseTripLink(fragment: string): { selection: TripSelection | null; invalid: boolean } {
    const params = new URLSearchParams(fragment.replace(/^[?#]/, ''))
    const values = params.getAll('trip')
    if (!values.length) return { selection: null, invalid: false }
    try {
        if (values.length !== 1 || values[0]!.length > 2000) throw new Error('Invalid link')
        const input = JSON.parse(values[0]!) as TripSelection
        if (!input || input.version !== 1 || !['driving', 'walking'].includes(input.mode) || !selectedPoint(input.start)
            || !Array.isArray(input.places) || input.places.length < 1 || input.places.length > 3
            || input.places.some(p => !selectedPoint(p) || typeof p.label !== 'string' || p.label.length > 80)) throw new Error('Invalid selection')
        return { selection: { version: 1, mode: input.mode, start: copyPoint(input.start),
            places: input.places.map(p => ({ ...copyPoint(p), label: p.label })) }, invalid: false }
    } catch { return { selection: null, invalid: true } }
}

export function tripUrl(selection: TripSelection): string {
    return '/trips#' + new URLSearchParams({ trip: JSON.stringify(selection) }).toString()
}

export function tripLocationKey(location: Pick<Location, 'search' | 'hash'>): string {
    return location.search + '|' + location.hash
}

export function restoreTripLocation(location: Pick<Location, 'search' | 'hash'>, history: Pick<History, 'replaceState'>) {
    const legacy = new URLSearchParams(location.search).has('trip')
    const fragmentHasTrip = new URLSearchParams(location.hash.slice(1)).has('trip')
    const parsed = legacy && fragmentHasTrip ? { selection: null, invalid: true }
        : parseTripLink(legacy ? location.search : location.hash)
    if (legacy) {
        // The first legacy HTTP request already happened. Remove it from this history
        // entry before reload/subresource requests and all future sharing.
        history.replaceState(null, '', parsed.selection ? tripUrl(parsed.selection) : '/trips#trip=invalid')
    }
    return parsed
}

export function tripDistance(metres: number): string {
    return metres >= 1000 ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(metres / 1000) + ' км'
        : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(metres) + ' м'
}

export function tripDuration(seconds: number): string {
    if (seconds === 0) return '0 мин'
    if (seconds < 60) return 'менее 1 мин'
    return 'около ' + new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(seconds / 60) + ' мин'
}

export function snapDistance(metres: number): string {
    if (metres > 0 && metres < .1) return 'менее 0,1 м'
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(metres) + ' м'
}

export function coordinateLabel(point: Coordinates): string {
    return `${point.lon.toFixed(7)}, ${point.lat.toFixed(7)}`
}
