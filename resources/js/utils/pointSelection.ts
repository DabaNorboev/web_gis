import type { Coordinates } from '@/types/transport'

export interface PointSelection { point: Coordinates | null; radius: number }
export function parsePointSelection(search: string): PointSelection & { invalid: boolean } {
    const params = new URLSearchParams(search)
    const radiusText = params.get('radius_m')
    const radius = radiusText === '300' ? 300 : 500
    const invalidRadius = params.getAll('radius_m').length > 1 || (radiusText !== null && !['300', '500'].includes(radiusText))
    const hasPoint = params.has('lon') || params.has('lat')
    if (!hasPoint) return { point: null, radius, invalid: invalidRadius }
    const lonText = params.get('lon') ?? '', latText = params.get('lat') ?? ''
    const decimal = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
    const lon = Number(lonText), lat = Number(latText)
    if (invalidRadius || params.getAll('lon').length !== 1 || params.getAll('lat').length !== 1 || !decimal.test(lonText) || !decimal.test(latText) || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
        return { point: null, radius, invalid: true }
    }
    return { point: { lon, lat }, radius, invalid: false }
}
export function pointSelectionUrl(selection: PointSelection, search = ''): string {
    const params = new URLSearchParams(search)
    for (const key of ['lon', 'lat', 'radius_m']) params.delete(key)
    if (selection.point) {
        // Preserve the analysis coordinates, not the rounded coordinate label.
        params.set('lon', String(selection.point.lon)); params.set('lat', String(selection.point.lat))
    }
    if (selection.point || selection.radius === 300) params.set('radius_m', String(selection.radius))
    const query = params.toString()
    return query ? `/?${query}` : '/'
}
