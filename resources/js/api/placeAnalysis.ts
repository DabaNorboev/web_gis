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
const reason = (v: any) => typeof v === 'string' && /^[A-Z][A-Z0-9_]+$/.test(v)
const sha256 = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const nonNegative = (v: any) => Number.isSafeInteger(v) && v >= 0
const fraction = (v: any) => finite(v) && v >= 0 && v <= 1
const color = (v: any) => typeof v === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(v)
function satelliteScene(v: any): boolean {
    return record(v) && ['scene_id', 'product_uri', 'tile', 'platform', 'baseline', 'datatake'].every(k => typeof v[k] === 'string' && v[k].length > 0)
        && utc(v.acquired_at_catalog) && utc(v.acquired_at_granule)
}
function satelliteWarning(v: any): boolean {
    return record(v) && reason(v.code) && typeof v.message === 'string' && v.message.length > 0
}
function satelliteReleaseRef(v: any): boolean {
    return record(v) && date(v.date) && typeof v.release_id === 'string' && v.release_id.length > 0 && sha256(v.manifest_sha256)
        && Array.isArray(v.scenes) && v.scenes.length > 0 && v.scenes.length <= 8 && v.scenes.every(satelliteScene)
        && Array.isArray(v.warnings) && v.warnings.every(satelliteWarning)
        && Array.isArray(v.limitations) && v.limitations.every((line: any) => typeof line === 'string')
}
function satelliteCoverage(v: any): boolean {
    const counts = ['circle_pixels', 'source_footprint_pixels', 'prepared_pixels', 'outside_rectangle_pixels',
        'inside_rectangle_outside_target_pixels', 'geographic_pixels', 'usable_pixels']
    return record(v) && counts.every(k => nonNegative(v[k]))
        && ['source_footprint_fraction', 'prepared_fraction', 'geographic_fraction', 'usable_fraction'].every(k => fraction(v[k]))
        && record(v.reason_counts) && Object.values(v.reason_counts).every(nonNegative)
        && record(v.source_pixels) && Object.values(v.source_pixels).every(nonNegative)
        && typeof v.scope === 'string' && v.scope.length > 0
        && v.prepared_pixels <= v.circle_pixels && v.usable_pixels <= v.circle_pixels && v.geographic_pixels <= v.circle_pixels
}
function satelliteLegend(v: any): boolean {
    return record(v) && typeof v.version === 'string' && v.version.length > 0 && typeof v.units === 'string'
        && typeof v.intervals === 'string' && record(v.unknown) && color(v.unknown.color) && typeof v.unknown.label === 'string'
        && Array.isArray(v.classes) && v.classes.length >= 2
        && v.classes.every((c: any) => record(c) && finite(c.min) && finite(c.max) && c.min < c.max && color(c.color) && typeof c.label === 'string')
        && v.classes.every((c: any, i: number) => i === 0 || v.classes[i - 1].max === c.min)
        && v.classes[0].min >= -1 && v.classes.at(-1).max <= 1
}
function satelliteRaster(v: any): boolean {
    return record(v) && v.type === 'raster' && Array.isArray(v.tiles) && v.tiles.length > 0
        && v.tiles.every((tile: any) => typeof tile === 'string' && /^\/api\/v1\/satellite\/[a-f0-9]{64}\/\d{4}-\d{2}-\d{2}\/(true-color|ndvi)\/\{z\}\/\{x\}\/\{y\}\.png$/.test(tile))
        && bounds(v.bounds) && v.tileSize === 256 && v.minzoom === 10 && v.maxzoom === 13
        && v.scheme === 'xyz' && typeof v.attribution === 'string'
}
function satelliteBlockData(d: any, releaseByDate: Map<string, any>): boolean {
    if (!record(d) || d.status !== 'READY' || d.reason !== null || !sha256(d.catalog_sha256) || !sha256(d.source_index_sha256)
        || typeof d.method_version !== 'string' || !d.method_version || typeof d.mask_version !== 'string' || !d.mask_version
        || typeof d.legend_version !== 'string' || !satelliteLegend(d.legend) || d.legend_version !== d.legend.version
        || !['READY', 'UNAVAILABLE'].includes(d.delivery_status)) return false
    if (!Array.isArray(d.available_dates) || !d.available_dates.every(satelliteReleaseRef)) return false
    if (!Array.isArray(d.releases) || !d.releases.length || !d.releases.every((r: any) => {
        if (!satelliteReleaseRef(r) || !['READY', 'UNAVAILABLE'].includes(r.status)) return false
        if (r.status === 'READY') return r.reason === null && satelliteCoverage(r.coverage)
            && finite(r.mean_ndvi) && r.mean_ndvi >= -1 && r.mean_ndvi <= 1 && r.mean_ndvi_reason === null
        return reason(r.reason) && r.mean_ndvi === null && typeof r.mean_ndvi_reason === 'string'
            && (r.coverage === null || satelliteCoverage(r.coverage))
    })) return false
    if (new Set(d.releases.map((r: any) => r.date)).size !== d.releases.length
        || new Set(d.available_dates.map((r: any) => r.date)).size !== d.available_dates.length) return false
    const readyDates = new Set(d.releases.filter((r: any) => r.status === 'READY').map((r: any) => r.date))
    if (!d.available_dates.every((r: any) => readyDates.has(r.date))) return false
    const selected = d.selected
    if (!record(selected) || !(selected.date === null || date(selected.date))
        || !['READY', 'UNAVAILABLE'].includes(selected.status)
        || !(selected.reason === null || typeof selected.reason === 'string')
        || !(selected.mean_ndvi === null || finite(selected.mean_ndvi) && selected.mean_ndvi >= -1 && selected.mean_ndvi <= 1)
        || !(selected.mean_ndvi_reason === null || typeof selected.mean_ndvi_reason === 'string')
        || !(selected.coverage === null || satelliteCoverage(selected.coverage))
        || !(selected.layers === null || record(selected.layers) && satelliteRaster(selected.layers['true-color']) && satelliteRaster(selected.layers.ndvi))) return false
    if (selected.date === null) return selected.status === 'UNAVAILABLE' && selected.reason === 'DATE_NOT_SELECTED'
        && selected.coverage === null && selected.mean_ndvi === null && selected.layers === null
    const release = releaseByDate.get(selected.date)
    if (!release) return selected.status === 'UNAVAILABLE' && selected.reason === 'DATE_NOT_IN_CATALOG'
        && selected.coverage === null && selected.mean_ndvi === null && selected.layers === null
    if (selected.release_id !== release.release_id || selected.manifest_sha256 !== release.manifest_sha256
        || selected.status !== release.status || selected.reason !== release.reason
        || JSON.stringify(selected.scenes) !== JSON.stringify(release.scenes)
        || JSON.stringify(selected.warnings) !== JSON.stringify(release.warnings)) return false
    if (selected.status === 'READY' && (!satelliteCoverage(selected.coverage)
        || JSON.stringify(selected.coverage) !== JSON.stringify(release.coverage)
        || selected.mean_ndvi !== release.mean_ndvi || selected.mean_ndvi_reason !== null)) return false
    if (selected.layers === null) return selected.status === 'READY' || selected.status === 'UNAVAILABLE'
    return selected.status === 'READY'
}
function satelliteData(d: any, requestDate: string | null): boolean {
    const releases = Array.isArray(d?.releases) ? d.releases.filter((r: any) => record(r) && date(r.date)) : []
    if (!satelliteBlockData(d, new Map(releases.map((r: any) => [r.date, r])))) return false
    return requestDate === null ? d.selected.date === null : d.selected.date === requestDate
}
function block(v: any, key: AnalysisBlockKey, requestDate: string | null): boolean {
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
    if (key === 'satellite') return satelliteData(d, requestDate)
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
        || !record(v.blocks) || !sameSet(Object.keys(v.blocks), request.blocks) || !request.blocks.every(k => block(v.blocks[k], k, request.date))
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
