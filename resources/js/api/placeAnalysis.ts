import { ApiRequestError, requestJson } from './errors'
import type { AnalysisBlockKey, AnalysisRequest, PlaceAnalysisInput, PlaceAnalysisResponse } from '../types/placeAnalysis'

export const analysisBlockKeys: AnalysisBlockKey[] = ['poi', 'satellite', 'air']
const categories = ['grocery', 'pharmacy', 'official_stop', 'park'] as const
type Value = Record<string, any>
const record = (v: unknown): v is Value => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const nullableText = (v: unknown) => v === null || typeof v === 'string'
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max
const point = (v: any) => record(v) && finite(v.lon) && Math.abs(v.lon) <= 180 && finite(v.lat) && Math.abs(v.lat) <= 90
const position = (v: any) => Array.isArray(v) && v.length === 2 && point({ lon: v[0], lat: v[1] })
const bounds = (v: any) => Array.isArray(v) && v.length === 4 && position(v.slice(0, 2)) && position(v.slice(2)) && v[0] <= v[2] && v[1] <= v[3]
const utc = (v: any) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v))
const date = (v: any) => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
const ids = (v: any) => Array.isArray(v) && v.length <= 20 && v.every(id => typeof id === 'string' && id.length >= 1 && id.length <= 64) && new Set(v).size === v.length
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every(id => b.includes(id))
const invalid = (): never => { throw new ApiRequestError('invalid_response', null, null, null, 'Ответ анализа не соответствует запросу.') }
function geometry(v: any): boolean {
    const ring = (r: any) => Array.isArray(r) && r.length >= 4 && r.every(position) && JSON.stringify(r[0]) === JSON.stringify(r.at(-1))
    const polygon = (p: any) => Array.isArray(p) && p.length > 0 && p.every(ring)
    return record(v) && (v.type === 'Point' ? position(v.coordinates) : v.type === 'Polygon' ? polygon(v.coordinates)
        : v.type === 'MultiPolygon' && Array.isArray(v.coordinates) && v.coordinates.length > 0 && v.coordinates.every(polygon))
}
function address(v: any, id: string): boolean {
    return record(v) && v.id === id && typeof v.label === 'string' && record(v.object) && v.object.id === id && point(v.object)
        && geometry(v.object.geometry) && ['osm_node', 'point_on_surface'].includes(v.object.point_method)
        && ['building', 'address_point', 'address_area'].includes(v.object.object_type) && nullableText(v.object.levels)
        && bounds(v.bounds) && typeof v.source === 'string' && integer(v.dataset_import_id, 1)
        && nullableText(v.observed_at) && nullableText(v.source_updated_at) && typeof v.reason === 'string'
}
export function normalizeAnalysisInput(input: PlaceAnalysisInput): AnalysisRequest {
    const p = input.place
    const radius = input.radius_m === undefined ? 500 : input.radius_m
    const selection = { selected_ids: input.stations?.selected_ids === undefined ? [] : input.stations.selected_ids, radius_m: input.stations?.radius_m === undefined ? 5000 : input.stations.radius_m }
    const blocks = input.blocks === undefined ? [...analysisBlockKeys] : input.blocks
    if (!record(p) || (p.kind === 'point' ? !point(p) || 'address_id' in p
        : p.kind !== 'address' || typeof p.address_id !== 'string' || !/^osm:(node|way|relation):[1-9][0-9]{0,18}$/.test(p.address_id) || 'lon' in p || 'lat' in p)
        || !integer(radius, 200, 1000) || (input.date !== undefined && !date(input.date))
        || (input.stations !== undefined && !record(input.stations)) || !ids(selection.selected_ids) || !integer(selection.radius_m, 1000, 20000)
        || !Array.isArray(blocks) || !blocks.length || blocks.length > 3 || new Set(blocks).size !== blocks.length || blocks.some(k => !analysisBlockKeys.includes(k))) {
        throw new ApiRequestError('http', 422, 'INVALID_REQUEST', null, 'Проверьте место, радиус, дату и выбор станций.')
    }
    return { place: p.kind === 'point' ? { kind: 'point', lon: p.lon, lat: p.lat } : { kind: 'address', address_id: p.address_id },
        radius_m: radius, date: input.date ?? null, stations: { selected_ids: [...selection.selected_ids], radius_m: selection.radius_m }, blocks: [...blocks] }
}
function coverage(v: any): boolean {
    return record(v) && ['COVERED', 'PARTIAL', 'OUTSIDE_SERVICE_AREA', 'UNKNOWN'].includes(v.status) && typeof v.reason === 'string'
        && (v.available_radius_m === null || (finite(v.available_radius_m) && v.available_radius_m >= 0))
}
function completeness(v: any): boolean {
    return record(v) && ['COMPLETE', 'PARTIAL', 'UNKNOWN'].includes(v.status) && typeof v.reason === 'string'
}
function block(v: any, key: AnalysisBlockKey): boolean {
    if (!record(v) || !utc(v.calculated_at) || !nullableText(v.message)) return false
    if (key === 'satellite' ? v.coverage !== null || v.completeness !== null
        : key === 'air' ? v.coverage !== null || !completeness(v.completeness)
            : (v.coverage !== null && !coverage(v.coverage)) || !completeness(v.completeness)) return false
    if (key === 'poi' && v.availability_by_category !== undefined && (!record(v.availability_by_category)
        || !categories.every(c => { const s = v.availability_by_category[c]; return record(s)
            && ['READY', 'UNAVAILABLE', 'ERROR'].includes(s.status) && typeof s.message === 'string'
            && (s.status === 'READY' ? s.code === null : typeof s.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(s.code)) }))) return false
    if (v.status === 'UNAVAILABLE' || v.status === 'ERROR') return v.data === null && typeof v.message === 'string' && v.message.length > 0
        && typeof v.code === 'string' && (v.status === 'ERROR' ? v.code === 'BLOCK_CALCULATION_FAILED' : /^[A-Z][A-Z0-9_]+$/.test(v.code))
    if (v.status !== 'READY' || v.code !== null || !record(v.data)) return false
    const d = v.data
    if (key === 'poi') return coverage(v.coverage) && categories.every(c => coverage(v.coverage.by_category?.[c]) && completeness(v.completeness.by_category?.[c]))
        && Array.isArray(d.items) && new Set(d.items.map((p: any) => p?.id)).size === d.items.length && d.items.every((p: any) => record(p)
            && typeof p.id === 'string' && /^(osm:(node|way|relation):[1-9][0-9]*|official-stop:.+)$/.test(p.id) && categories.includes(p.category)
            && (p.source_version === undefined || nullableText(p.source_version))
            && (p.source_url === undefined || p.source_url === null || typeof p.source_url === 'string' && p.source_url.startsWith('https://'))
            && (p.limitations === undefined || nullableText(p.limitations))
            && (p.identity_note === undefined || nullableText(p.identity_note)) && nullableText(p.name) && nullableText(p.address) && geometry(p.geometry) && point(p.point) && finite(p.distance_m) && p.distance_m >= 0
            && typeof p.source === 'string' && (p.dataset_import_id === null || integer(p.dataset_import_id, 1))
            && nullableText(p.access) && nullableText(p.observed_at) && nullableText(p.source_updated_at))
        && (d.official_stop_summary === undefined || record(d.official_stop_summary)
            && (d.official_stop_summary.found_count === null || integer(d.official_stop_summary.found_count, 0)
                && d.official_stop_summary.found_count >= d.items.filter((p: any) => p.category === 'official_stop').length)
            && (d.official_stop_summary.source_without_coordinates === null || integer(d.official_stop_summary.source_without_coordinates, 0))
            && (d.official_stop_summary.excluded_outside_scope === undefined || integer(d.official_stop_summary.excluded_outside_scope, 0)
                && integer(d.official_stop_summary.source_without_coordinates, 0)
                && d.official_stop_summary.excluded_outside_scope <= d.official_stop_summary.source_without_coordinates)
            && (v.availability_by_category?.official_stop?.status !== 'READY' ? d.official_stop_summary.found_count === null : true))
        && typeof v.method_version === 'string' && v.method_version.length > 0 && record(d.counts_by_category)
        && categories.every(c => {
            const completeCircle = v.coverage.by_category[c].status === 'COVERED' && v.completeness.by_category[c].status !== 'PARTIAL'
            return completeCircle ? d.counts_by_category[c] === d.items.filter((p: any) => p.category === c).length : d.counts_by_category[c] === null
        }) && (categories.every(c => v.coverage.by_category[c].status === 'COVERED' && v.completeness.by_category[c].status !== 'PARTIAL')
            ? d.count === d.items.length : d.count === null)
    if (key === 'satellite') return Array.isArray(d.available_dates) && d.available_dates.every((v: any) => record(v) && date(v.date) && typeof v.scene_id === 'string'
        && (v.cloud_cover_percent === null || finite(v.cloud_cover_percent) && v.cloud_cover_percent >= 0 && v.cloud_cover_percent <= 100))
        && (d.selected === null || record(d.selected) && ['READY', 'UNAVAILABLE', 'ERROR'].includes(d.selected.status))
    return Array.isArray(d.stations) && d.stations.every((s: any) => record(s) && typeof s.id === 'string' && typeof s.name === 'string' && point(s)
        && typeof s.source === 'string' && integer(s.dataset_import_id, 1) && finite(s.distance_m) && s.distance_m >= 0 && typeof s.selected === 'boolean'
        && ['selected', 'nearest', 'other'].includes(s.group) && ['ACTIVE', 'INACTIVE', 'UNKNOWN'].includes(s.status))
        && Array.isArray(d.missing_selected_ids) && d.missing_selected_ids.every((id: any) => typeof id === 'string')
        && record(d.counts) && ['selected', 'nearest', 'other'].every(c => integer(d.counts[c], 0))
}
export function validateAnalysisResponse(v: unknown, request: AnalysisRequest): PlaceAnalysisResponse {
    if (!record(v) || v.analysis_version !== 1 || v.radius_m !== request.radius_m || v.date !== request.date || !utc(v.calculated_at)
        || !record(v.place) || v.place.kind !== request.place.kind || !point(v.place.point)
        || !record(v.station_selection) || v.station_selection.radius_m !== request.stations.radius_m || !ids(v.station_selection.selected_ids)
        || !sameSet(v.station_selection.selected_ids, request.stations.selected_ids)
        || !record(v.blocks) || !sameSet(Object.keys(v.blocks), request.blocks) || !request.blocks.every(k => block(v.blocks[k], k))
        || !geometry(v.analysis_area) || v.analysis_area.type !== 'Polygon' || !bounds(v.analysis_bounds)) return invalid()
    if (request.place.kind === 'point' ? v.place.address !== null || v.place.label !== null || v.place.point.lon !== request.place.lon || v.place.point.lat !== request.place.lat
        : !address(v.place.address, request.place.address_id) || v.place.label !== v.place.address.label
            || v.place.point.lon !== v.place.address.object.lon || v.place.point.lat !== v.place.address.object.lat) return invalid()
    // Structural bbox/contour consistency, never a replacement GIS circle or coverage calculation.
    const positions = v.analysis_area.coordinates.flat() as number[][]
    const extent = [Math.min(...positions.map(p => p[0]!)), Math.min(...positions.map(p => p[1]!)), Math.max(...positions.map(p => p[0]!)), Math.max(...positions.map(p => p[1]!))]
    if (extent.some((n, i) => Math.abs(n - v.analysis_bounds[i]) > 1e-7)) return invalid()
    return v as PlaceAnalysisResponse
}
export async function fetchPlaceAnalysis(input: PlaceAnalysisInput, signal?: AbortSignal): Promise<PlaceAnalysisResponse> {
    const request = normalizeAnalysisInput(input)
    const body = { place: request.place, radius_m: request.radius_m, ...(request.date === null ? {} : { date: request.date }), stations: request.stations, blocks: request.blocks }
    try {
        const value = await requestJson('/api/v1/place-analysis', { method: 'POST', body: JSON.stringify(body), signal,
            cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } })
        try { return validateAnalysisResponse(value, request) } catch { return invalid() }
    } catch (error) {
        if (error instanceof ApiRequestError && error.status === 422) throw new ApiRequestError('http', 422, error.code, null, 'Проверьте место, радиус, дату и выбор станций.')
        throw error
    }
}
