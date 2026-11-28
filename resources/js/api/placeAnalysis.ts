import { validGeocodedPlace, sameSnapshot } from './geocoding'
import { ApiRequestError, requestJson } from './errors'
import type { AirSnapshotHour, AirSnapshotHourRequest, AirStationHistory, AirStationHistoryRequest, AnalysisBlockKey, AnalysisPoint, AnalysisRequest, AnalysisStation, PlaceAnalysisInput, PlaceAnalysisResponse } from '../types/placeAnalysis'

export const analysisBlockKeys: AnalysisBlockKey[] = ['poi', 'satellite', 'air']
const coreCategories = ['grocery', 'pharmacy', 'official_stop', 'park'] as const
const educationCategories = [...coreCategories, 'school', 'kindergarten'] as const
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
    if (!record(p)) throw new ApiRequestError('http', 422, 'INVALID_REQUEST')
    const external = input.analysis_version === 2
    if (external && (!record(p) || p.kind !== 'address' || !('selection_token' in p) || typeof p.selection_token !== 'string' || !p.selection_token || new TextEncoder().encode(p.selection_token).length > 6144
        || Object.keys(p).some(k => !['kind', 'selection_token'].includes(k)) || !validGeocodedPlace(input.expected_place))
        || !external && (input.analysis_version !== undefined || input.expected_place !== undefined || 'selection_token' in p)) {
        throw new ApiRequestError('http', 422, 'INVALID_REQUEST')
    }
    const radius = input.radius_m === undefined ? 500 : input.radius_m
    const selection = { selected_ids: input.stations?.selected_ids === undefined ? [] : input.stations.selected_ids, radius_m: input.stations?.radius_m === undefined ? 5000 : input.stations.radius_m }
    const blocks = input.blocks === undefined ? [...analysisBlockKeys] : input.blocks
    if (!record(p) || (!external && (p.kind === 'point' ? !point(p) || 'address_id' in p
        : p.kind !== 'address' || !('address_id' in p) || typeof p.address_id !== 'string' || !/^osm:(node|way|relation):[1-9][0-9]{0,18}$/.test(p.address_id) || 'lon' in p || 'lat' in p))
        || !integer(radius, 200, 1000) || (input.date !== undefined && !date(input.date))
        || (input.stations !== undefined && !record(input.stations)) || !ids(selection.selected_ids) || !integer(selection.radius_m, 1000, 20000)
        || !Array.isArray(blocks) || !blocks.length || blocks.length > 3 || new Set(blocks).size !== blocks.length || blocks.some(k => !analysisBlockKeys.includes(k))) {
        throw new ApiRequestError('http', 422, 'INVALID_REQUEST', null, 'Проверьте место, радиус, дату и выбор станций.')
    }
    return { ...(external ? { analysis_version: 2 as const, expected_place: structuredClone(input.expected_place) } : {}), place: external ? { kind: 'address', selection_token: (p as { selection_token: string }).selection_token } : p.kind === 'point' ? { kind: 'point', lon: p.lon, lat: p.lat } : { kind: 'address', address_id: (p as { address_id: string }).address_id },
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
function satelliteRaster(v: any, selectedDate: string, layer: 'true-color' | 'ndvi'): boolean {
    const tilePath = `${selectedDate}/${layer}/{z}/{x}/{y}.png`
    return record(v) && v.type === 'raster' && Array.isArray(v.tiles) && v.tiles.length > 0
        && v.tiles.every((tile: any) => {
            const prefix = typeof tile === 'string' && /^\/api\/v1\/satellite\/[a-f0-9]{64}\//.exec(tile)?.[0]
            return !!prefix && tile.slice(prefix.length) === tilePath
        })
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
        || !(selected.coverage === null || satelliteCoverage(selected.coverage))) return false
    if (selected.date === null) return selected.status === 'UNAVAILABLE' && selected.reason === 'DATE_NOT_SELECTED'
        && selected.coverage === null && selected.mean_ndvi === null && selected.layers === null
    const release = releaseByDate.get(selected.date)
    if (!release) return selected.status === 'UNAVAILABLE' && selected.reason === 'DATE_NOT_IN_CATALOG'
        && selected.coverage === null && selected.mean_ndvi === null && selected.layers === null
    if (selected.release_id !== release.release_id || selected.manifest_sha256 !== release.manifest_sha256
        || selected.status !== release.status || selected.reason !== release.reason
        || JSON.stringify(selected.scenes) !== JSON.stringify(release.scenes)
        || JSON.stringify(selected.warnings) !== JSON.stringify(release.warnings)) return false
    if (JSON.stringify(selected.coverage) !== JSON.stringify(release.coverage)
        || selected.mean_ndvi !== release.mean_ndvi || selected.mean_ndvi_reason !== release.mean_ndvi_reason) return false
    if (selected.layers === null) return true
    return d.delivery_status === 'READY' && selected.coverage?.prepared_pixels > 0
        && (selected.status === 'READY' || ['NO_USABLE_NDVI', 'NO_GEOGRAPHIC_DATA'].includes(selected.reason))
        && record(selected.layers) && satelliteRaster(selected.layers['true-color'], selected.date, 'true-color')
        && satelliteRaster(selected.layers.ndvi, selected.date, 'ndvi')
}
function satelliteData(d: any, requestDate: string | null): boolean {
    const releases = Array.isArray(d?.releases) ? d.releases.filter((r: any) => record(r) && date(r.date)) : []
    if (!satelliteBlockData(d, new Map(releases.map((r: any) => [r.date, r])))) return false
    return requestDate === null ? d.selected.date === null : d.selected.date === requestDate
}
const stationId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) && Number.isSafeInteger(Number(v))
const airSource = 'air.krasn.ru/project/9'
const hourMs = 3_600_000
// A fixed-offset calendar is used for validation and bin arithmetic only.
function sourceHour(v: unknown): number {
    if (typeof v !== 'string' || !date(v.slice(0, 10)) || !/^\d{4}-\d\d-\d\d (?:[01]\d|2[0-3]):00:00$/.test(v)) return NaN
    return Date.parse(v.replace(' ', 'T') + 'Z')
}
function airWindow(v: unknown): number {
    if (!record(v)) return NaN
    return (sourceHour(v.end_exclusive) - sourceHour(v.begin_inclusive)) / hourMs
}
function inAirWindow(time: unknown, window: Value): boolean {
    const hour = sourceHour(time)
    return hour >= sourceHour(window.begin_inclusive) && hour < sourceHour(window.end_exclusive)
}
function airSnapshot(v: any): boolean {
    return record(v) && sha256(v.snapshot_version) && integer(airWindow(v.window_raw), 1, 168)
        && utc(v.last_success_at) && (v.last_observed_at_raw === null || inAirWindow(v.last_observed_at_raw, v.window_raw))
        && v.timezone === null && v.utc_offset === null && v.time_reason === 'SOURCE_TIMEZONE_UNCONFIRMED'
        && v.freshness === 'UNKNOWN' && v.scope === 'STATION_OBSERVATIONS'
        && v.indicator === 'pm2_5' && v.unit === 'µg/m³' && v.aggregation === 'hourly'
}
function airRow(v: any): boolean {
    if (!record(v) || !Number.isFinite(sourceHour(v.observed_at_raw)) || v.observed_at_utc !== null || v.qc !== 'UNKNOWN') return false
    if (v.row_present === false) return v.value === null && v.missing_reason === 'SOURCE_ROW_MISSING' && v.qc_reason === 'SOURCE_ROW_MISSING'
    return v.row_present === true && v.qc_reason === 'SOURCE_QC_NOT_PROVIDED'
        && (v.value === null ? v.missing_reason === 'SOURCE_VALUE_NULL_OR_ABSENT' : finite(v.value) && v.missing_reason === null)
}
function airPosition(station: Value): boolean {
    if (station.crs === 'EPSG:4326') {
        const provenance = station.coordinate_provenance
        return point(station) && record(provenance) && provenance.source_id === station.id
            && ((station.coordinate_reason === 'A11_OPERATOR_MAP_INTERPRETATION' && provenance.raw_file === 'raw/air-project9-api.json')
                || (station.coordinate_reason === 'A12_PILOT_OPERATOR_MAP_INTERPRETATION' && provenance.raw_file === 'raw/project.json'))
    }
    return (station.lon === null || station.lon === undefined) && (station.lat === null || station.lat === undefined)
        && (station.crs === null || station.crs === undefined) && station.coordinate_provenance === undefined
        && (station.coordinate_reason === undefined || station.coordinate_reason === 'SOURCE_DATUM_CRS_UNCONFIRMED')
}
function airData(d: any, selectedIds: string[]): boolean {
    if (!airSnapshot(d) || !Array.isArray(d.stations) || d.stations.length > 20 || !ids(d.missing_selected_ids) || !record(d.counts)) return false
    const hours = airWindow(d.window_raw)
    if (!d.stations.every((s: any) => {
        if (!record(s) || !stationId(s.id) || typeof s.name !== 'string' || !s.name.length || s.source !== airSource
            || !airPosition(s) || (s.distance_m !== null && (s.crs !== 'EPSG:4326' || !finite(s.distance_m) || s.distance_m < 0))
            || s.selected !== selectedIds.includes(s.id) || s.group !== (s.selected ? 'selected' : 'unlocated') || s.status !== 'UNKNOWN') return false
        const h = s.history
        if (!record(h) || !integer(h.row_count, 0, hours) || !integer(h.null_values, 0, h.row_count) || h.missing_hour_bins !== hours - h.row_count) return false
        if (h.row_count === 0) return h.status === 'UNAVAILABLE' && h.reason === 'SOURCE_ROW_MISSING'
            && h.first_observed_at_raw === null && h.last_observed_at_raw === null && s.latest === null
        return h.status === 'AVAILABLE' && h.reason === null && inAirWindow(h.first_observed_at_raw, d.window_raw)
            && inAirWindow(h.last_observed_at_raw, d.window_raw) && h.first_observed_at_raw <= h.last_observed_at_raw
            && airRow(s.latest) && s.latest.row_present && s.latest.observed_at_raw === h.last_observed_at_raw
    })) return false
    const stationIds = new Set(d.stations.map((s: any) => s.id))
    const missing = selectedIds.filter(id => !stationIds.has(id))
    const selected = selectedIds.length - missing.length
    const observed = d.stations.map((s: any) => s.history.last_observed_at_raw).filter(Boolean).sort().at(-1) ?? null
    const lastNumeric = d.last_numeric_observed_at_raw
    const hasNumeric = d.stations.some((station: AnalysisStation) => station.history.row_count > station.history.null_values)
    if (lastNumeric !== undefined && (lastNumeric === null ? hasNumeric
        : !hasNumeric || observed === null || !inAirWindow(lastNumeric, d.window_raw) || lastNumeric > observed)) return false
    return stationIds.size === d.stations.length && sameSet(d.missing_selected_ids, missing)
        && d.last_observed_at_raw === observed && d.counts.selected === selected && d.counts.unlocated === d.stations.length - selected
}
export function validateAirStationHistory(v: unknown, request: AirStationHistoryRequest): AirStationHistory {
    if (!record(v) || !airSnapshot(v) || v.snapshot_version !== request.snapshot_version || v.station_id !== request.station_id
        || !stationId(v.station_id) || v.source !== airSource || !Array.isArray(v.rows) || v.rows.length !== airWindow(v.window_raw)
        || !v.rows.every((row, i) => airRow(row) && sourceHour(row.observed_at_raw) === sourceHour(v.window_raw.begin_inclusive) + i * hourMs)) {
        throw new ApiRequestError('invalid_response')
    }
    if (v.pm10_rows !== undefined && (!Array.isArray(v.pm10_rows) || v.pm10_rows.length !== v.rows.length
        || !v.pm10_rows.every((row, index) => airRow(row) && (row.value === null || row.value >= 0)
            && row.observed_at_raw === v.rows[index].observed_at_raw && row.row_present === v.rows[index].row_present)
        || !v.pm10_rows.some(row => row.value !== null))) {
        throw new ApiRequestError('invalid_response')
    }
    return v as unknown as AirStationHistory
}
export async function fetchAirStationHistory(request: AirStationHistoryRequest, signal?: AbortSignal): Promise<AirStationHistory> {
    const { snapshot_version, station_id } = request
    if (!sha256(snapshot_version) || !stationId(station_id)) throw new ApiRequestError('http', 422, 'INVALID_REQUEST')
    const path = `/api/v1/air/snapshots/${snapshot_version}/stations/${station_id}/history`
    const data = await requestJson(path, { signal, mode: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } })
    return validateAirStationHistory(data, { snapshot_version, station_id })
}
export function validateAirSnapshotHour(v: unknown, request: AirSnapshotHourRequest): AirSnapshotHour {
    if (!record(v) || !airSnapshot(v) || v.snapshot_version !== request.snapshot_version
        || v.observed_at_raw !== request.observed_at_raw || !inAirWindow(v.observed_at_raw, v.window_raw)
        || v.source !== airSource || !Array.isArray(v.rows) || v.rows.length !== request.station_ids.length
        || !v.rows.every(row => airRow(row) && stationId(row.station_id) && row.observed_at_raw === v.observed_at_raw)
        || !sameSet(v.rows.map(row => row.station_id), request.station_ids)) {
        throw new ApiRequestError('invalid_response')
    }
    return v as unknown as AirSnapshotHour
}
export async function fetchAirSnapshotHour(request: AirSnapshotHourRequest, signal?: AbortSignal): Promise<AirSnapshotHour> {
    const { snapshot_version, observed_at_raw } = request
    if (!sha256(snapshot_version) || !Number.isFinite(sourceHour(observed_at_raw))) throw new ApiRequestError('http', 422, 'INVALID_REQUEST')
    const query = new URLSearchParams({ observed_at_raw })
    const path = `/api/v1/air/snapshots/${snapshot_version}/hour?${query}`
    const data = await requestJson(path, { signal, mode: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } })
    return validateAirSnapshotHour(data, request)
}
function block(v: any, key: AnalysisBlockKey, requestDate: string | null, selectedIds: string[]): boolean {
    if (!record(v) || !utc(v.calculated_at) || !nullableText(v.message)) return false
    if (key === 'satellite' ? v.coverage !== null || v.completeness !== null
        : key === 'air' ? v.coverage !== null || !completeness(v.completeness)
            : (v.coverage !== null && !coverage(v.coverage)) || !completeness(v.completeness)) return false
    const categories = v.method_version === 'poi-v4-geography-source-geometry-education' ? educationCategories : coreCategories
    if (key === 'poi' && v.availability_by_category !== undefined && (!record(v.availability_by_category)
        || !categories.every(c => { const s = v.availability_by_category[c]; return record(s)
            && ['READY', 'UNAVAILABLE', 'ERROR'].includes(s.status) && typeof s.message === 'string'
            && (s.status === 'READY' ? s.code === null : typeof s.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(s.code)) }))) return false
    if (v.status === 'UNAVAILABLE' || v.status === 'ERROR') return v.data === null && typeof v.message === 'string' && v.message.length > 0
        && typeof v.code === 'string' && (v.status === 'ERROR'
            ? v.code === 'BLOCK_CALCULATION_FAILED' || (key === 'satellite' && v.code === 'SATELLITE_READ_FAILED')
            : /^[A-Z][A-Z0-9_]+$/.test(v.code))
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
    return airData(d, selectedIds)
}
export function validateAnalysisResponse(v: unknown, request: AnalysisRequest): PlaceAnalysisResponse {
    if (!record(v) || v.analysis_version !== (request.analysis_version ?? 1) || v.radius_m !== request.radius_m || v.date !== request.date || !utc(v.calculated_at)
        || !record(v.place) || v.place.kind !== request.place.kind || !point(v.place.point)
        || !record(v.station_selection) || v.station_selection.radius_m !== request.stations.radius_m || !ids(v.station_selection.selected_ids)
        || !sameSet(v.station_selection.selected_ids, request.stations.selected_ids)
        || !record(v.blocks) || !sameSet(Object.keys(v.blocks), request.blocks) || !request.blocks.every(k => block(v.blocks[k], k, request.date, request.stations.selected_ids))
        || !geometry(v.analysis_area) || v.analysis_area.type !== 'Polygon' || !bounds(v.analysis_bounds)) return invalid()
    if (request.analysis_version === 2) {
        if (!validGeocodedPlace(v.place) || !sameSnapshot(v.place, request.expected_place)) return invalid()
    } else if (request.place.kind === 'point' ? v.place.address !== null || v.place.label !== null || v.place.point.lon !== request.place.lon || v.place.point.lat !== request.place.lat
        : !('address_id' in request.place) || !address(v.place.address, request.place.address_id) || v.place.label !== v.place.address.label
            || v.place.point.lon !== v.place.address.object.lon || v.place.point.lat !== v.place.address.object.lat) return invalid()
    // Structural bbox/contour consistency, never a replacement GIS circle or coverage calculation.
    const positions = v.analysis_area.coordinates.flat() as number[][]
    const extent = [Math.min(...positions.map(p => p[0]!)), Math.min(...positions.map(p => p[1]!)), Math.max(...positions.map(p => p[0]!)), Math.max(...positions.map(p => p[1]!))]
    if (extent.some((n, i) => Math.abs(n - v.analysis_bounds[i]) > 1e-7)) return invalid()
    return v as PlaceAnalysisResponse
}
export async function checkPlaceServiceArea({ lon, lat }: AnalysisPoint, signal: AbortSignal): Promise<void> {
    const response = await requestJson('/api/v1/place-analysis/selection', {
        method: 'POST', signal, mode: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ lon, lat }),
    })
    if (!record(response) || response.status !== 'INSIDE') throw new ApiRequestError('invalid_response')
}

export async function fetchPlaceAnalysis(input: PlaceAnalysisInput, signal?: AbortSignal): Promise<PlaceAnalysisResponse> {
    const request = normalizeAnalysisInput(input)
    const body = { ...(request.analysis_version === 2 ? { analysis_version: 2 } : {}), place: request.place, radius_m: request.radius_m, ...(request.date === null ? {} : { date: request.date }), stations: request.stations, blocks: request.blocks }
    try {
        const value = await requestJson('/api/v1/place-analysis', { method: 'POST', body: JSON.stringify(body), signal,
            cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } })
        try { return validateAnalysisResponse(value, request) } catch { return invalid() }
    } catch (error) {
        if (error instanceof ApiRequestError && error.status === 422) throw new ApiRequestError('http', 422, error.code, null, 'Проверьте место, радиус, дату и выбор станций.')
        throw error
    }
}
