import type { LayerSpecification, Map as LibreMap } from 'maplibre-gl'
import type { FeatureCollection, Feature, Geometry } from 'geojson'
import type { Coordinates } from '@/types/transport'
import { candidateId, sameRoadPoint, type TripCandidateGroup } from '@/utils/tripCandidates'
import type { TripAnalysis, TripMode } from '@/types/trips'

export interface TripMapPoint { key: string; point: Coordinates; road?: Coordinates }
const colors = ['#bd7229', '#4e72ac', '#9470a5']
export function tripMapData(points: TripMapPoint[], analysis: TripAnalysis | null, groups: TripCandidateGroup[] = [], mode: TripMode = analysis?.mode ?? 'driving'): FeatureCollection {
    const features: Feature<Geometry>[] = points.map(p => ({ type: 'Feature', properties: { kind: 'original', label: p.key === 'S' ? 'Старт' : `Место ${p.key}`, color: p.key === 'S' ? '#2d6450' : colors[Number(p.key) - 1] }, geometry: { type: 'Point', coordinates: [p.point.lon, p.point.lat] } }))
    const shown = new Set<string>()
    function matched(key: string, point: Coordinates, kind = 'matched') {
        if (shown.has(key)) return
        shown.add(key)
        features.push({ type: 'Feature', properties: { kind, key }, geometry: { type: 'Point', coordinates: [point.lon, point.lat] } })
        const original = points.find(p => p.key === key)?.point
        if (original && kind === 'matched' && mode !== 'walking') features.push({ type: 'Feature', properties: { kind: 'connector' }, geometry: { type: 'LineString', coordinates: [[original.lon, original.lat], [point.lon, point.lat]] } })
    }
    for (const row of analysis?.results ?? []) {
        if (row.status === 'AVAILABLE' && row.route && row.snaps && (mode !== 'walking' || (row.route_scope === 'street_points' && row.route.scope === 'street_points'))) {
            features.push({ type: 'Feature', properties: { kind: 'route', color: colors[row.index] }, geometry: row.route.geometry })
            matched('S', row.snaps.start.matched)
            matched(String(row.index + 1), row.snaps.target.matched)
        }
        for (const end of ['start', 'target'] as const) {
            const key = end === 'start' ? 'S' : String(row.index + 1), choice = row.road_choices?.[end]
            if (mode !== 'walking' && choice?.status === 'SELECTED' && choice.point) matched(key, choice.point)
            if (!groups.length && choice?.status === 'CHOOSE' && !shown.has(key)) {
                shown.add(key)
                choice.candidates?.forEach((c, i) => features.push({ type: 'Feature', properties: { kind: 'candidate', key, label: `${key === 'S' ? 'Старт' : `Место ${key}`} · Вариант ${i + 1}` }, geometry: { type: 'Point', coordinates: [c.point.lon, c.point.lat] } }))
            }
        }
    }
    for (const group of groups) group.candidates.forEach((candidate, index) => features.push({ type: 'Feature',
        properties: { kind: 'candidate', key: group.key, id: candidateId(group.key, index), label: `${group.label} · Вариант ${index + 1}`,
            selected: sameRoadPoint(group.selected, candidate.point), waiting: !group.selected },
        geometry: { type: 'Point', coordinates: [candidate.point.lon, candidate.point.lat] } }))
    if (mode === 'walking') {
        // A chosen street is an input, separate from both the object and the
        // checked graph endpoint. Never draw an uncalculated object approach.
        for (const p of points) {
            const row = analysis?.results.find(r => p.key === 'S' || r.index === Number(p.key) - 1)
            const street = p.road ?? row?.street_points?.[p.key === 'S' ? 'start' : 'target']
            if (street) features.push({ type: 'Feature', properties: { kind: 'proposed', key: p.key, role: 'selected_street' }, geometry: { type: 'Point', coordinates: [street.lon, street.lat] } })
        }
    } else if (!analysis) for (const p of points) if (p.road) matched(p.key, p.road, 'proposed')
    return { type: 'FeatureCollection', features }
}

/** Shared renderer for the standalone trips map and the comparison maps. */
export function installTripLayers(map: LibreMap, collection: FeatureCollection) {
    if (!map.getSource('trips')) map.addSource('trips', { type: 'geojson', tolerance: 0, data: collection })
    const layers: LayerSpecification[] = [
        { id: 'trip-path-casing', type: 'line', source: 'trips', filter: ['==', 'kind', 'route'], paint: { 'line-color': '#fff', 'line-width': 7, 'line-opacity': .85 } },
        { id: 'trip-paths', type: 'line', source: 'trips', filter: ['==', 'kind', 'route'], paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': .9 } },
        { id: 'trip-connectors', type: 'line', source: 'trips', filter: ['==', 'kind', 'connector'], paint: { 'line-color': '#536b60', 'line-width': 1.5, 'line-dasharray': [2, 3] } },
        { id: 'trip-proposed', type: 'circle', source: 'trips', filter: ['==', 'kind', 'proposed'], paint: { 'circle-color': '#eee', 'circle-radius': 6, 'circle-stroke-color': '#666', 'circle-stroke-width': 2 } },
        { id: 'trip-originals', type: 'circle', source: 'trips', filter: ['==', 'kind', 'original'], paint: { 'circle-color': ['get', 'color'], 'circle-radius': 10, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } },
        { id: 'trip-labels', type: 'symbol', source: 'trips', filter: ['==', 'kind', 'original'], layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.7], 'text-font': ['Noto Sans Regular'], 'text-allow-overlap': true }, paint: { 'text-color': '#273b31', 'text-halo-color': '#fff', 'text-halo-width': 2 } },
        { id: 'trip-matched', type: 'circle', source: 'trips', filter: ['==', 'kind', 'matched'], paint: { 'circle-color': '#fff', 'circle-radius': 6, 'circle-stroke-color': '#273b31', 'circle-stroke-width': 1 } },
    ]
    for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer(layer)
    return layers.map(layer => layer.id)
}
