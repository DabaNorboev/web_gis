import { ApiRequestError } from './errors'
import type { GeocodedPlace, GeocodingCandidate, GeocodingLookup, GeocodingMeta, GeocodingSelection } from '../types/geocoding'

type Value = Record<string, any>
const record = (v: unknown): v is Value => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && [...v].length <= max
const nullableText = (v: unknown, max: number) => v === null || text(v, max)
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(v)
const sha = (v: unknown) => typeof v === 'string' && /^[a-f\d]{64}$/.test(v)
export const geocodingTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19)
export const geocodingPoint = (v: any): boolean => record(v) && Object.keys(v).length === 2 && typeof v.lon === 'number' && Number.isFinite(v.lon) && Math.abs(v.lon) <= 180 && typeof v.lat === 'number' && Number.isFinite(v.lat) && Math.abs(v.lat) <= 90
export function sameSnapshot(a: any, b: any): boolean {
    if (a === b) return true
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameSnapshot(v, b[i]))
    return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && sameSnapshot(a[k], b[k]))
}
const token = (v: any) => text(v, 6144) && new TextEncoder().encode(v).length <= 6144
function attribution(v: any): boolean {
    return Array.isArray(v) && v.length > 0 && v.length <= 8 && v.every(a => record(a) && text(a.text, 512) && text(a.url, 1024)
        && /^https:\/\/(?:www\.)?(?:geoapify\.com|openstreetmap\.org)(?:\/|$)/.test(a.url))
        && v.some(a => a.url === 'https://www.geoapify.com/' && a.text === 'Powered by Geoapify')
}
function components(v: any): boolean {
    return record(v) && nullableText(v.country_code, 128) && nullableText(v.locality, 128) && nullableText(v.street, 256)
        && record(v.number) && ['COMPLETE', 'UNKNOWN'].includes(v.number.parse_status)
        && ['raw', 'key', 'base', 'fraction', 'letter', 'corpus', 'structure'].every(k => nullableText(v.number[k], 128))
}
function precision(v: any): boolean {
    return record(v) && ['house', 'street', 'locality', null].includes(v.level) && v.accuracy_m === null && v.accuracy_reason === 'NOT_VALIDATED'
        && (v.level === null ? v.reason === 'PROVIDER_LEVEL_UNKNOWN' : v.reason === null)
}
function source(v: any): boolean {
    return record(v) && v.provider === 'geoapify' && nullableText(v.provider_result_type, 128) && v.observed_at === null && v.source_updated_at === null
        && geocodingTime(v.received_at) && v.normalization_version === 1 && attribution(v.attribution)
}
export function validGeocodedPlace(v: any): v is GeocodedPlace {
    const a = v?.address
    return record(v) && v.kind === 'address' && uuid(v.selection_id) && text(v.label, 512) && geocodingPoint(v.point) && v.building === null
        && record(a) && text(a.provider_id, 1024) && components(a.components) && a.components.number.parse_status === 'COMPLETE' && text(a.components.street, 256)
        && precision(a.precision) && a.precision.level === 'house' && ['EXACT', 'NOT_REQUESTED'].includes(a.number_match)
        && source(a.source) && a.source.provider_result_type === 'building' && text(a.scope_id, 128) && sha(a.scope_sha256)
        && !('object' in v) && !('object' in a) && !('selection_token' in v)
}
function candidate(v: any): v is GeocodingCandidate {
    const confirmable = v?.within_scope === true && geocodingPoint(v.point) && text(v.provider_id, 1024)
        && v.precision?.level === 'house' && v.source?.provider_result_type === 'building' && text(v.components?.street, 256)
        && v.components?.number?.parse_status === 'COMPLETE' && ['EXACT', 'NOT_REQUESTED'].includes(v.number_match)
    return record(v) && uuid(v.candidate_id) && nullableText(v.provider_id, 1024) && text(v.label, 512) && components(v.components) && precision(v.precision) && source(v.source)
        && (v.point === null ? v.point_reason === 'COORDINATES_MISSING' && v.within_scope === null : geocodingPoint(v.point) && v.point_reason === null && v.within_scope === true)
        && ['EXACT', 'MISMATCH', 'UNKNOWN', 'NOT_REQUESTED'].includes(v.number_match) && typeof v.can_confirm === 'boolean' && v.can_confirm === !!confirmable
        && Array.isArray(v.restrictions) && v.restrictions.every((r: unknown) => typeof r === 'string' && ['COORDINATES_MISSING', 'PROVIDER_ID_MISSING', 'HOUSE_REQUIRED', 'NUMBER_MISMATCH', 'NUMBER_UNVERIFIED'].includes(r))
        && (v.can_confirm ? v.restrictions.length === 0 && token(v.candidate_token) && geocodingTime(v.expires_at) : v.restrictions.length > 0 && v.candidate_token === null && v.expires_at === null)
}
const invalid = (): never => { throw new ApiRequestError('invalid_response', null, null, null, 'Ответ адресного поиска не соответствует запросу.') }
export function validateGeocodingResponse(v: any, operation: string, request: Value, expected?: GeocodingCandidate | GeocodingSelection) {
    const m = v?.meta, d = v?.data
    if (!record(m) || !record(d) || m.contract_version !== 1 || m.request_id !== request.request_id || m.provider !== 'geoapify'
        || !text(m.scope_id, 128) || !sha(m.scope_sha256) || !['HIT', 'MISS', 'NONE'].includes(m.cache) || !(m.received_at === null || geocodingTime(m.received_at)) || !attribution(m.attribution)) return invalid()
    if (operation === 'search' || operation === 'reverse') {
        if (!['OK', 'NO_SELECTABLE_RESULTS', 'EMPTY'].includes(d.status) || !(d.reason === null || /^[A-Z][A-Z_]+$/.test(d.reason))
            || !Array.isArray(d.candidates) || d.candidates.length > 5 || !d.candidates.every(candidate) || new Set(d.candidates.map((c: any) => c.candidate_id)).size !== d.candidates.length
            || (d.status === 'EMPTY' ? d.candidates.length !== 0 : d.candidates.length === 0)
            || (d.status === 'OK') !== d.candidates.some((c: any) => c.can_confirm)
            || (d.status === 'OK' ? d.reason !== null : d.reason === null)
            || d.candidates.some((c: any) => c.source.received_at !== m.received_at || !sameSnapshot(c.source.attribution, m.attribution))) return invalid()
        if (operation === 'reverse' && (!sameSnapshot(d.point, { lon: request.lon, lat: request.lat }) || d.candidates.some((c: any) => !Number.isFinite(c.reference_distance_m) || c.reference_distance_m < 0 || c.reference_distance_m > 100))) return invalid()
    } else {
        if (!uuid(d.selection_id) || !token(d.selection_token) || !geocodingTime(d.expires_at) || !geocodingTime(d.snapshot_expires_at)
            || Date.parse(d.expires_at) > Date.parse(d.snapshot_expires_at) || !validGeocodedPlace(d.place) || d.place.selection_id !== d.selection_id || m.cache !== 'NONE'
            || d.place.address.scope_id !== m.scope_id || d.place.address.scope_sha256 !== m.scope_sha256 || d.place.address.source.received_at !== m.received_at
            || !sameSnapshot(d.place.address.source.attribution, m.attribution) || !expected) return invalid()
        if (operation === 'reconfirm') {
            const previous = expected as GeocodingSelection
            if (!sameSnapshot(previous.place, d.place) || previous.selection_id !== d.selection_id || previous.snapshot_expires_at !== d.snapshot_expires_at) return invalid()
        } else {
            const c = expected as GeocodingCandidate
            if (!sameSnapshot(c.point, d.place.point) || c.label !== d.place.label || c.provider_id !== d.place.address.provider_id
                || !['components', 'precision', 'number_match', 'source'].every(k => sameSnapshot(c[k as keyof GeocodingCandidate], d.place.address[k as keyof typeof d.place.address]))) return invalid()
        }
    }
    return v as { data: GeocodingLookup & GeocodingSelection; meta: GeocodingMeta }
}
export async function requestGeocoding(operation: 'search' | 'reverse' | 'confirm' | 'reconfirm', fields: Value, signal: AbortSignal, expected?: GeocodingCandidate | GeocodingSelection) {
    const request = { ...fields, request_id: crypto.randomUUID() }
    let response: Response
    try { response = await fetch(`/api/v1/geocoding/${operation}`, { method: 'POST', body: JSON.stringify(request), signal,
        cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }) }
    catch { throw new ApiRequestError(signal.aborted ? 'cancelled' : 'network') }
    let value: any
    try { value = await response.json() } catch { return invalid() }
    if (!response.ok) {
        if (!record(value) || value.request_id !== request.request_id && value.request_id !== null || !/^[A-Z][A-Z_]+$/.test(value.code)
            || !(value.retry_after_s === null || Number.isSafeInteger(value.retry_after_s) && value.retry_after_s >= 0)) return invalid()
        throw new ApiRequestError('http', response.status, value.code, value.retry_after_s === null ? null : String(value.retry_after_s), 'Адресный поиск недоступен. Можно выбрать точку на карте.')
    }
    return validateGeocodingResponse(value, operation, request, expected)
}
