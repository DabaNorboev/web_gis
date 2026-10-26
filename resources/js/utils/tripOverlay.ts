import type { Map as LibreMap, MapMouseEvent, GeoJSONSource, LayerSpecification } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import type { Coordinates } from '@/types/transport'
import { installTripLayers } from '@/utils/tripMap'

/** Prepared display data; candidates carry a scenario-prepared string ID.
 * Scenario identities and response indices stay outside the map. */
export interface TripMapOverlay { data: FeatureCollection; sequence: number }

export function tripOverlayBounds(data: FeatureCollection): [[number, number], [number, number]] | null {
    const points: number[][] = []
    for (const feature of data.features) {
        if (feature.geometry.type === 'Point') points.push(feature.geometry.coordinates)
        else if (feature.geometry.type === 'LineString') points.push(...feature.geometry.coordinates)
    }
    if (!points.length) return null
    return [[Math.min(...points.map(p => p[0]!)), Math.min(...points.map(p => p[1]!))], [Math.max(...points.map(p => p[0]!)), Math.max(...points.map(p => p[1]!))]]
}

const candidateLayers: LayerSpecification[] = [
    { id: 'compare-road-candidates', type: 'circle', source: 'trips', filter: ['==', 'kind', 'candidate'], paint: { 'circle-radius': 8, 'circle-color': '#ffe4a0', 'circle-stroke-width': 2, 'circle-stroke-color': '#835b23' } },
    { id: 'compare-road-labels', type: 'symbol', source: 'trips', filter: ['==', 'kind', 'candidate'], layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, -1.7], 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#513b17', 'text-halo-color': '#fff', 'text-halo-width': 2 } },
]

/** Uses the owner's style readiness and click dispatch. Never commands the camera
 * or subscribes to map events; CityMap controls their order and lifetime. */
export function createTripOverlay(map: LibreMap, options: {
    data: () => FeatureCollection | null
    picking: () => boolean
    select: (point: Coordinates) => void
    candidate: (key: string, point: Coordinates) => void
}) {
    let disposed = false
    let layerIds: string[] = []
    const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] })
    function update() {
        if (disposed) return
        ;(map.getSource('trips') as GeoJSONSource | undefined)?.setData(options.data() ?? empty())
    }
    function install() {
        if (disposed) return
        layerIds = installTripLayers(map, options.data() ?? empty())
        for (const layer of candidateLayers) {
            if (!map.getLayer(layer.id)) map.addLayer(layer)
            layerIds.push(layer.id)
        }
        update()
    }
    function click(event: MapMouseEvent): boolean {
        if (disposed) return false
        if (options.picking()) {
            options.select({ lon: event.lngLat.lng, lat: event.lngLat.lat })
            return true
        }
        const data = options.data()
        if (!data || !map.getLayer('compare-road-candidates')) return false
        const candidate = map.queryRenderedFeatures(event.point, { layers: ['compare-road-candidates'] })[0]
        if (candidate?.geometry.type !== 'Point' || typeof candidate.properties.id !== 'string') return false
        // GeoJSON tiles update asynchronously. Match the prepared candidate ID
        // before dispatch, and use its original coordinates rather than tile rounding.
        const current = data.features.find(feature => feature.properties?.kind === 'candidate'
            && feature.properties.id === candidate.properties.id)
        if (!current || current.geometry.type !== 'Point') return false
        options.candidate(String(current.properties!.key), { lon: current.geometry.coordinates[0]!, lat: current.geometry.coordinates[1]! })
        return true
    }
    function dispose() {
        if (disposed) return
        disposed = true
        for (const id of [...layerIds].reverse()) if (map.getLayer(id)) map.removeLayer(id)
        if (layerIds.length && map.getSource('trips')) map.removeSource('trips')
        layerIds = []
    }
    return { install, update, click, dispose }
}
