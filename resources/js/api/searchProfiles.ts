import { ApiRequestError, requestJson } from './errors'
import type { ProfileBlockKey, ResolvedAddress, SelectedAddressProfile } from '../types/searchApi'

const blockKeys: ProfileBlockKey[] = ['transport', 'parks', 'vegetation', 'water', 'roads', 'railways']
type RecordValue = Record<string, any>
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v)
const point = (p: any) => record(p) && typeof p.lon === 'number' && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180
    && typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90
const bounds = (b: any) => Array.isArray(b) && b.length === 4 && b.every(v => typeof v === 'number' && Number.isFinite(v))
const nullableText = (v: unknown) => v === null || typeof v === 'string'
function geometry(g: any): boolean {
    const position = (p: any) => Array.isArray(p) && p.length === 2 && point({ lon: p[0], lat: p[1] })
    const ring = (r: any) => Array.isArray(r) && r.length >= 4 && r.every(position) && JSON.stringify(r[0]) === JSON.stringify(r.at(-1))
    const polygon = (p: any) => Array.isArray(p) && p.length > 0 && p.every(ring)
    return record(g) && (g.type === 'Point' ? position(g.coordinates) : g.type === 'Polygon' ? polygon(g.coordinates)
        : g.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.every(polygon))
}
function address(a: any, id: string): boolean {
    return record(a) && a.id === id && typeof a.label === 'string' && record(a.object) && a.object.id === id && point(a.object)
        && geometry(a.object.geometry) && bounds(a.bounds) && typeof a.source === 'string' && Number.isSafeInteger(a.dataset_import_id)
        && nullableText(a.observed_at) && nullableText(a.source_updated_at)
        && ['osm_node', 'point_on_surface'].includes(a.object.point_method) && ['building', 'address_point', 'address_area'].includes(a.object.object_type)
        && nullableText(a.object.levels) && typeof a.reason === 'string'
}
const invalid = (): never => { throw new ApiRequestError('invalid_response') }
function validateInput(id: string) {
    if (!/^osm:(node|way|relation):[1-9][0-9]{0,18}$/.test(id)) throw new ApiRequestError('http', 422, 'INVALID_REQUEST')
}
export async function resolveAddress(id: string, signal: AbortSignal): Promise<ResolvedAddress> {
    validateInput(id)
    const value = await requestJson(`/api/v1/addresses/${encodeURIComponent(id)}`, { signal, cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } })
    if (!record(value) || !address(value.address, id) || value.capabilities?.resolver_version !== 1 || value.capabilities?.selected_profile_version !== 1) return invalid()
    return value as ResolvedAddress
}
function block(value: any, key: string, radius: number, origin: any): boolean {
    if (!record(value)) return false
    if (value.status === 'ERROR') return value.data === null && value.code === 'BLOCK_CALCULATION_FAILED' && typeof value.message === 'string'
    if (value.status !== 'READY' || value.message !== null || !record(value.data) || !record(value.data.metrics)) return false
    const metrics = Object.values(value.data.metrics)
    if (!metrics.length || !metrics.every(m => record(m) && (m.value === null || (typeof m.value === 'number' && Number.isFinite(m.value)))
        && typeof m.calculated_at === 'string' && nullableText(m.observed_at) && record(m.quality)
        && ['AVAILABLE', 'INSUFFICIENT_DATA', 'UNAVAILABLE'].includes(m.quality.availability)
        && (m.value === null || m.quality.availability === 'AVAILABLE') && nullableText(m.quality.method))) return false
    return key !== 'transport' || (value.data.radius_m === radius && point(value.data.point)
        && value.data.point.lon === origin.lon && value.data.point.lat === origin.lat && Array.isArray(value.data.stops_in_radius))
}
export async function fetchSelectedAddressProfile(id: string, radius: 300 | 500, blocks: readonly ProfileBlockKey[],
    capabilities: ResolvedAddress['capabilities'], signal: AbortSignal): Promise<SelectedAddressProfile> {
    validateInput(id)
    if (capabilities?.selected_profile_version !== 1 || ![300, 500].includes(radius) || !blocks.length || blocks.length > 6
        || new Set(blocks).size !== blocks.length || blocks.some(k => !blockKeys.includes(k))) throw new ApiRequestError('http', 422, 'INVALID_REQUEST')
    const query = new URLSearchParams({ scope: 'selected', profile_version: '1', radius_m: String(radius) })
    blocks.forEach(key => query.append('blocks[]', key))
    const value = await requestJson(`/api/v1/addresses/${encodeURIComponent(id)}/profile?${query}`, {
        signal, cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } })
    if (!record(value) || value.scope !== 'selected' || value.profile_version !== 1 || value.radius_m !== radius || !address(value.address, id)
        || !point(value.point) || value.point.lon !== value.address.object.lon || value.point.lat !== value.address.object.lat
        || typeof value.calculated_at !== 'string' || !Array.isArray(value.selected_blocks) || value.selected_blocks.length !== blocks.length
        || !blocks.every(k => value.selected_blocks.includes(k)) || !record(value.blocks)
        || Object.keys(value.blocks).length !== blocks.length || !blocks.every(k => block(value.blocks[k], k, radius, value.point))
        || !record(value.map) || !geometry(value.map.analysis_area) || value.map.analysis_area.type !== 'Polygon' || !bounds(value.map.analysis_bounds)) return invalid()
    for (const [group, keys] of [['area_layers', ['parks', 'vegetation', 'water']], ['linear_layers', ['roads', 'railways']]] as const) {
        const wanted = blocks.filter(k => (keys as readonly string[]).includes(k)), layers = value.map[group] ?? {}
        if (!record(layers) || Object.keys(layers).length !== wanted.length || !wanted.every(k => {
            const layer = layers[k]
            return record(layer) && (layer.status === 'ERROR' ? layer.data === null && typeof layer.message === 'string'
                && ['BLOCK_CALCULATION_FAILED', 'LAYER_CALCULATION_FAILED'].includes(layer.code)
                : layer.status === 'READY' && layer.message === null && record(layer.data) && layer.data.type === 'FeatureCollection'
                && Array.isArray(layer.data.features) && layer.data.radius_m === radius)
        })) return invalid()
    }
    if (blocks.includes('transport') ? !Array.isArray(value.map.stops_in_radius) : 'stops_in_radius' in value.map) return invalid()
    return value as SelectedAddressProfile
}
