<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, render, watch, type Component } from 'vue'
import { BusFront, Pill, ShoppingBasket, Trees, TriangleAlert } from '@lucide/vue'
import {
    Map as MapLibreMap,
    LngLatBounds,
    Marker,
    NavigationControl,
    ScaleControl,
    setWorkerUrl,
    type ExpressionSpecification,
    type GeoJSONSource,
    type StyleSpecification,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import basemap from '@/maps/basemap.json'
import googleMapsLogo from '@/maps/google-maps-attribution.png'
import { useImageryBasemap } from '@/composables/useImageryBasemap'
import { useMapTheme } from '@/composables/useMapTheme'
import { applyBasemapTheme, themedBasemap } from '@/utils/mapTheme'
import {
    type AnalysisLayer,
    type AnalysisTab,
    type AnalysisPoint,
    type PoiCategory,
    type SatelliteMode,
} from '@/place-analysis'
import { satelliteClipLayers } from '@/utils/satelliteClip'
import { addressFeatures, type AddressSearchPreview } from '@/utils/addressMap'
import type { Feature, FeatureCollection, Polygon, MultiPolygon, Point } from 'geojson'
import { airReadingLabel } from '@/utils/airObservation'
import type { AirObservation, SatelliteLayerKey, SatelliteRasterSource } from '@/types/placeAnalysis'

const props = withDefaults(defineProps<{
    addressPreview?: AddressSearchPreview | null
    showPlacePin?: boolean
    geometryStale?: boolean
    center: AnalysisPoint
    radius: number
    pois: { id: string; category: PoiCategory; name: string; lon: number; lat: number; distance_m: number; geometry?: Point | Polygon | MultiPolygon }[]
    analysisArea?: Polygon | null
    analysisBounds?: [number, number, number, number] | null
    stations?: { id: string; name: string; lon: number; lat: number }[]
    poiDistancesKnown: boolean
    tab: AnalysisTab
    showObjects: boolean
    showSatellite: boolean
    showStations: boolean
    airHourRows: ReadonlyMap<string, AirObservation> | null
    showRadius: boolean
    layerOrder: AnalysisLayer[]
    satelliteMode: SatelliteMode
    satelliteScope: 'territory' | 'circle'
    satelliteOpacity: number
    satelliteLayers: Partial<Record<SatelliteLayerKey, SatelliteRasterSource>> | null
    categoryFilter: PoiCategory | null
    selectedPoi: string | null
    selectedStation: string | null
    stationContext: AnalysisPoint | null
    pendingDraggable?: boolean
    pendingPoint: AnalysisPoint | null
    pickMode: boolean
}>(), { satelliteOpacity: .75, showPlacePin: true, geometryStale: false, analysisArea: null, analysisBounds: null, stations: () => [], addressPreview: null, pendingDraggable: false })

const stations = computed(() => props.stations)
const poiCategory = computed(() => props.tab === 'objects' ? props.categoryFilter : null)

const emit = defineEmits<{ 'select-point': [point: AnalysisPoint]; 'select-station': [id: string]; 'select-poi': [id: string]; 'cancel-pick': []; 'highlight-address': [id: string | null, source: 'pointer' | 'focus']; 'select-address': [id: string]; 'retry-satellite': [] }>()
const { theme } = useMapTheme()
const categoryIcons: Record<PoiCategory, Component> = {
    grocery: ShoppingBasket, pharmacy: Pill, official_stop: BusFront, park: Trees,
}
const container = ref<HTMLElement | null>(null)
const imageryAttributionTarget = ref<HTMLElement | null>(null)
const mapStatus = ref<'loading' | 'ready' | 'error'>('loading')
const mapStatusText = ref('Загрузка карты…')
const terrainSourceId = 'pa-terrain'
const buildingsLayerId = 'pa-buildings-3d'
const buildingsMinZoom = 15
const buildingsColors = { light: '#a0aba4', streets: '#aea396', dark: '#657589' }
const terrainEnabled = ref(false)
const terrainError = ref(false)
const mapReady = computed(() => mapStatus.value === 'ready')
let terrainLoadTimer: ReturnType<typeof setTimeout> | undefined
let map: MapLibreMap | null = null
const imageryBasemap = useImageryBasemap({
    map: () => map,
    baseLayers: () => baseStyle().layers.map(layer => layer.id),
    // Anchor inside the basemap. getStyle() omits the custom layers masking NDVI.
    beforeLayer: instance => instance.getLayer(buildingsLayerId)
        ? buildingsLayerId : firstLabelLayer(instance) ?? baseStyle().layers.at(-1)?.id,
})
const { mode: basemapMode, imagery, error: basemapError, select: selectBasemap } = imageryBasemap
let ready = false
let addressMarkers: Marker[] = []
let renderedAddressGroup: AddressSearchPreview['groups'][number] | undefined
let poiMarkers: Marker[] = []
let stationMarkers: Marker[] = []
let pinMarker: Marker | null = null
let pendingMarker: Marker | null = null
let radiusLabel: Marker | null = null
let resizeObserver: ResizeObserver | null = null
let statusTimer: ReturnType<typeof setTimeout> | null = null
let markerSyncBusy = false
let markerSyncQueued = false
let rasterSourceRef: Partial<Record<SatelliteLayerKey, SatelliteRasterSource>> | null = null
const rasterError = ref(false)
const rasterLayers: Record<SatelliteLayerKey, { source: string; layer: string }> = {
    'true-color': { source: '', layer: 'pa-satellite-true-color-raster' },
    ndvi: { source: '', layer: 'pa-satellite-ndvi-raster' },
}
let rasterGeneration = 0

setWorkerUrl(workerUrl)

function circlePoint(center: AnalysisPoint, radiusM: number, bearingDeg: number): AnalysisPoint {
    const earth = 6378137
    const lat1 = center.lat * Math.PI / 180
    const lon1 = center.lon * Math.PI / 180
    const bearing = bearingDeg * Math.PI / 180
    const distance = radiusM / earth
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing))
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1), Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2))
    return { lon: lon2 * 180 / Math.PI, lat: lat2 * 180 / Math.PI }
}

function radiusCoordinates(): [number, number][] {
    return (props.analysisArea?.coordinates[0] ?? []).map(p => [p[0]!, p[1]!] as [number, number])
}
function analysisFeature(): Feature<Polygon> | FeatureCollection {
    return props.analysisArea
        ? { type: 'Feature', properties: {}, geometry: props.analysisArea } : { type: 'FeatureCollection', features: [] }
}

function addLayers() {
    if (!map || map.getSource('pa-radius')) return
    map.addSource('pa-address-preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({ id: 'pa-address-fill', type: 'fill', source: 'pa-address-preview', filter: ['==', '$type', 'Polygon'],
        paint: { 'fill-color': ['case', ['get', 'highlighted'], '#d18c24', '#387d91'], 'fill-opacity': ['case', ['get', 'highlighted'], .5, .18] } })
    map.addLayer({ id: 'pa-address-outline', type: 'line', source: 'pa-address-preview', filter: ['==', '$type', 'Polygon'],
        paint: { 'line-color': ['case', ['get', 'highlighted'], '#925b05', '#387d91'], 'line-width': ['case', ['get', 'highlighted'], 4, 2] } })
    map.addLayer({ id: 'pa-address-point', type: 'circle', source: 'pa-address-preview', filter: ['==', '$type', 'Point'],
        paint: { 'circle-color': ['case', ['get', 'highlighted'], '#d18c24', '#387d91'], 'circle-radius': 9, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
    map.addSource('pa-poi', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({ id: 'pa-poi-fill', type: 'fill', source: 'pa-poi', paint: {
        'fill-color': '#7c3aed', 'fill-opacity': ['case', ['get', 'selected'], .35, .14],
    } })
    map.addLayer({ id: 'pa-poi-outline', type: 'line', source: 'pa-poi', paint: {
        'line-color': '#7c3aed', 'line-width': ['case', ['get', 'selected'], 4, 2],
    } })
    map.addSource('pa-radius', { type: 'geojson', data: analysisFeature() })
    map.addLayer({
        id: 'pa-radius-fill',
        type: 'fill',
        source: 'pa-radius',
        paint: { 'fill-color': '#2d6450', 'fill-opacity': 0.045 },
    })
    map.addLayer({
        id: 'pa-radius-line',
        type: 'line',
        source: 'pa-radius',
        paint: { 'line-color': '#245b45', 'line-width': 2, 'line-dasharray': [4, 3] },
    })
}

function setVisibility(id: string, visible: boolean) {
    if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
}

const layerFillGroups: Record<AnalysisLayer, string[]> = {
    objects: ['pa-poi-fill', 'pa-poi-outline'],
    satellite: ['pa-satellite-clip-start', 'pa-satellite-true-color-raster', 'pa-satellite-ndvi-raster', 'pa-satellite-clip-end'],
    stations: [],
    radius: ['pa-radius-fill', 'pa-radius-line'],
}

function applyMarkerOrder() {
    const rank = (key: AnalysisLayer) => {
        const index = props.layerOrder.indexOf(key)
        return index < 0 ? 0 : props.layerOrder.length - index
    }
    for (const marker of poiMarkers) {
        const selected = marker.getElement().dataset.poiId === props.selectedPoi
        marker.getElement().style.zIndex = String(selected ? 80 : 20 + rank('objects'))
    }
    for (const marker of stationMarkers) {
        marker.getElement().style.zIndex = String(20 + rank('stations'))
    }
}

function applyLayerOrder() {
    if (!map || !ready) return
    const ordered = props.layerOrder.filter(key => layerFillGroups[key].length)
    // Layer keys are listed top-to-bottom; MapLibre moveLayer appends on top.
    for (const key of [...ordered].reverse()) {
        for (const id of layerFillGroups[key]) {
            if (map.getLayer(id)) map.moveLayer(id)
        }
    }
    for (const id of ['pa-address-fill', 'pa-address-outline', 'pa-address-point']) if (map.getLayer(id)) map.moveLayer(id)
    applyMarkerOrder()
    map.triggerRepaint()
}

function syncPoiGeometry() {
    if (!map || !ready) return
    const features: Feature[] = props.pois.filter(p => p.geometry && p.geometry.type !== 'Point'
        && (!poiCategory.value || p.category === poiCategory.value))
        .map(p => ({ type: 'Feature', properties: { id: p.id, selected: p.id === props.selectedPoi }, geometry: p.geometry! }))
    ;(map.getSource('pa-poi') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features })
    setVisibility('pa-poi-fill', props.showObjects)
    setVisibility('pa-poi-outline', props.showObjects)
}

function removeSatelliteRaster(key: SatelliteLayerKey) {
    if (!map) return
    const { source, layer } = rasterLayers[key]
    if (map.getLayer(layer)) map.removeLayer(layer)
    if (source && map.getSource(source)) map.removeSource(source)
    rasterLayers[key].source = ''
}
function syncSatelliteRasters() {
    if (!map || !ready) return
    if (props.satelliteLayers !== rasterSourceRef) {
        rasterSourceRef = props.satelliteLayers
        rasterGeneration++
        for (const key of Object.keys(rasterLayers) as SatelliteLayerKey[]) removeSatelliteRaster(key)
        rasterError.value = false
        for (const key of Object.keys(rasterLayers) as SatelliteLayerKey[]) {
            const descriptor = props.satelliteLayers?.[key]
            if (!descriptor) continue
            const layer = rasterLayers[key].layer
            const source = `pa-satellite-${key}-${rasterGeneration}`
            rasterLayers[key].source = source
            map.addSource(source, {
                type: 'raster', tiles: descriptor.tiles, bounds: descriptor.bounds, tileSize: descriptor.tileSize,
                minzoom: descriptor.minzoom, maxzoom: descriptor.maxzoom, scheme: descriptor.scheme,
                attribution: descriptor.attribution,
            })
            map.addLayer({
                id: layer, type: 'raster', source,
                paint: { 'raster-opacity': Math.max(0, Math.min(1, props.satelliteOpacity)), 'raster-fade-duration': 0 },
            })
        }
    }
    const active = props.satelliteMode === 'ndvi' ? 'ndvi' : 'true-color'
    for (const key of Object.keys(rasterLayers) as SatelliteLayerKey[]) {
        const { layer } = rasterLayers[key]
        if (!map.getLayer(layer)) continue
        setVisibility(layer, props.showSatellite && active === key)
        map.setPaintProperty(layer, 'raster-opacity', Math.max(0, Math.min(1, props.satelliteOpacity)))
    }
    applyLayerOrder()
}

function syncLayers() {
    if (!map || !ready) return
    const radiusSource = map.getSource('pa-radius') as GeoJSONSource | undefined
    syncPoiGeometry()
    radiusSource?.setData(analysisFeature())
    setVisibility('pa-radius-fill', props.showRadius && !!props.analysisArea)
    setVisibility('pa-radius-line', props.showRadius && !!props.analysisArea)
    if (map.getLayer('pa-radius-line')) map.setPaintProperty('pa-radius-line', 'line-opacity', props.geometryStale ? .4 : 1)
    syncSatelliteRasters()
    map.triggerRepaint()
    applyLayerOrder()
}

function mapKeydown(event: KeyboardEvent) {
    if (!props.pickMode) return
    const target = event.target
    if (target instanceof HTMLElement && target.closest('button')) return
    if (event.key === 'Enter') {
        const center = map?.getCenter()
        if (!center) return
        event.preventDefault()
        event.stopPropagation()
        emit('select-point', { lon: center.lng, lat: center.lat })
    } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        emit('cancel-pick')
    }
}

function markerElement(className: string, label: string): HTMLDivElement {
    const element = document.createElement('div')
    element.className = className
    element.title = label
    element.setAttribute('aria-label', label)
    return element
}

function poiMarkerElement(poi: (typeof props.pois)[number], label: string): HTMLButtonElement {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = `pa-map-marker pa-map-marker--${poi.category}${poi.id === props.selectedPoi ? ' is-selected' : ''}`
    element.title = label
    element.setAttribute('aria-label', label)
    element.setAttribute('aria-pressed', String(poi.id === props.selectedPoi))
    element.dataset.poiId = poi.id
    element.addEventListener('click', event => {
        event.stopPropagation()
        emit('select-poi', poi.id)
    })
    render(h(categoryIcons[poi.category], { size: 16, 'stroke-width': 2.2, 'aria-hidden': 'true' }), element)
    return element
}

function syncPoiSelection() {
    syncPoiGeometry()
    for (const marker of poiMarkers) {
        const element = marker.getElement() as HTMLButtonElement
        const selected = element.dataset.poiId === props.selectedPoi
        element.classList.toggle('is-selected', selected)
        element.setAttribute('aria-pressed', String(selected))
    }
    applyMarkerOrder()
}

function clearMarkers(markers: Marker[]) {
    for (const marker of markers) {
        render(null, marker.getElement())
        marker.remove()
    }
}

function clipPoiMarkers() {
    // Selection belongs to the server's full geometry, not the label position.
    for (const marker of poiMarkers) marker.getElement().style.display = ''
}

function syncStationHourLabels() {
    for (const marker of stationMarkers) {
        const element = marker.getElement()
        const caption = element.querySelector<HTMLElement>('.pa-map-station__hour')!
        const row = props.airHourRows?.get(element.dataset.stationId!)
        const reading = row ? airReadingLabel(row) : ''
        caption.hidden = !row
        caption.textContent = row?.missing_reason === 'SOURCE_ROW_MISSING' ? '—'
            : row?.missing_reason === 'SOURCE_VALUE_NULL_OR_ABSENT' ? '∅' : reading
        element.setAttribute('aria-label', row
            ? `${element.dataset.stationName} · PM2,5 · ${reading}${row.value === null ? '' : ' мкг/м³'}`
            : `${element.dataset.stationName} · Местоположение по данным источника`)
    }
}

function syncPoiMarkers() {
    const instance = map
    if (!instance || !ready) return
    clearMarkers(poiMarkers)
    poiMarkers = []
    if (props.showObjects) {
        const filter = poiCategory.value
        for (const poi of props.pois) {
            if (filter && poi.category !== filter) continue
            const element = poiMarkerElement(
                poi,
                props.poiDistancesKnown ? `${poi.name} · ${poi.distance_m} м по прямой` : `${poi.name} · демонстрационный объект`,
            )
            poiMarkers.push(new Marker({ element }).setLngLat([poi.lon, poi.lat]).addTo(instance))
        }
    }
    clipPoiMarkers()
    applyMarkerOrder()
}

function syncMarkers() {
    if (!map || !ready) return
    // A style-load callback and a Vue prop update can both request this synchronously.
    if (markerSyncBusy) {
        markerSyncQueued = true
        return
    }
    markerSyncBusy = true
    try {
        do {
            markerSyncQueued = false
            syncMarkersNow()
        } while (markerSyncQueued)
    } finally {
        markerSyncBusy = false
    }
}

function syncMarkersNow() {
    const instance = map
    if (!instance) return
    clearMarkers(stationMarkers)
    stationMarkers = []
    pinMarker?.remove()
    pinMarker = null
    pendingMarker?.remove()
    pendingMarker = null
    radiusLabel?.remove()
    radiusLabel = null

    if (props.showStations) {
        for (const station of stations.value) {
            const element = document.createElement('button')
            element.type = 'button'
            element.className = `pa-map-station${station.id === props.selectedStation ? ' is-selected' : ''}`
            const caption = document.createElement('span')
            caption.className = 'pa-map-station__hour'
            caption.setAttribute('aria-hidden', 'true')
            element.append(caption)
            element.setAttribute('aria-pressed', String(station.id === props.selectedStation))
            element.addEventListener('click', event => {
                event.stopPropagation()
                emit('select-station', station.id)
            })
            element.dataset.stationId = station.id
            element.dataset.stationName = station.name
            stationMarkers.push(new Marker({ element, anchor: 'center' }).setLngLat([station.lon, station.lat]).addTo(instance))
        }
    }

    syncStationHourLabels()

    const pinElement = document.createElement('div')
    pinElement.className = 'pa-map-pin'
    pinElement.innerHTML = '<span class="pa-map-pin__pulse"></span><span class="pa-map-pin__dot"></span>'
    if (props.showPlacePin) pinMarker = new Marker({ element: pinElement, anchor: 'center' }).setLngLat([props.center.lon, props.center.lat]).addTo(instance)

    if (props.pendingPoint) {
        const pendingElement = document.createElement('div')
        pendingElement.className = 'pa-map-pending'
        pendingMarker = new Marker({ element: pendingElement, anchor: 'center', draggable: props.pendingDraggable })
            .setLngLat([props.pendingPoint.lon, props.pendingPoint.lat]).addTo(instance)
        if (props.pendingDraggable) pendingMarker.on('dragend', () => {
            const p = pendingMarker?.getLngLat(); if (p) emit('select-point', { lon: p.lng, lat: p.lat })
        })
    }

    if (props.showRadius && !!props.analysisArea) {
        const anchor = circlePoint(props.center, props.radius, 42)
        const label = markerElement('pa-map-radius-label', `Радиус анализа ${props.radius} метров`)
        label.textContent = `R = ${props.radius} м${props.geometryStale ? ' · предыдущий' : ''}`
        radiusLabel = new Marker({ element: label }).setLngLat([anchor.lon, anchor.lat]).addTo(instance)
    }
    applyMarkerOrder()
}

function syncAddressPreview() {
    if (!map || !ready) return
    const state = props.addressPreview
    const source = map.getSource('pa-address-preview') as GeoJSONSource | undefined
    source?.setData(state ? addressFeatures(state) : { type: 'FeatureCollection', features: [] })
    const group = state?.groups[0]
    if (renderedAddressGroup !== group) {
        renderedAddressGroup = group
        clearMarkers(addressMarkers)
        addressMarkers = []
        const objects = group?.objects ?? []
        for (const [index, object] of objects.entries()) {
            const element = document.createElement('button')
            element.type = 'button'
            element.className = objects.length === 1 ? 'pa-address-marker pa-address-marker--single' : 'pa-address-marker'
            if (objects.length > 1) element.textContent = String(index + 1)
            element.dataset.addressId = object.id
            const label = state?.labels.get(object.id) ?? ''
            element.setAttribute('aria-label', `${label} · на карте`)
            element.title = label
            element.addEventListener('pointerdown', event => event.preventDefault())
            element.addEventListener('pointerenter', () => emit('highlight-address', object.id, 'pointer'))
            element.addEventListener('pointerleave', () => emit('highlight-address', null, 'pointer'))
            element.addEventListener('focus', () => emit('highlight-address', object.id, 'focus'))
            element.addEventListener('blur', () => emit('highlight-address', null, 'focus'))
            element.addEventListener('click', event => { event.stopPropagation(); emit('select-address', object.id) })
            addressMarkers.push(new Marker({ element }).setLngLat([object.lon, object.lat]).addTo(map))
        }
        spaceAddressMarkers()
    }
    for (const marker of addressMarkers) {
        const element = marker.getElement()
        const highlighted = element.dataset.addressId === state?.highlightedId
        element.classList.toggle('is-highlighted', highlighted)
    }
}

function spaceAddressMarkers() {
    if (!map || !addressMarkers.length) return
    const occupied: { x: number; y: number }[] = []
    const spacing = 36
    for (const marker of addressMarkers) {
        const point = map.project(marker.getLngLat())
        const available = (x: number, y: number) =>
            occupied.every(other => Math.abs(other.x - point.x - x) >= spacing || Math.abs(other.y - point.y - y) >= spacing)
        // Keep each marker anchored to the API point. Move only the numbered button
        // in screen pixels when a previous button would cover it.
        let x = 0, y = 0
        for (let step = spacing; !available(x, y); step += spacing) {
            const offsets: [number, number][] = [[step, 0], [-step, 0], [0, -step], [0, step],
                [step, -step], [-step, -step], [step, step], [-step, step]]
            const offset = offsets.find(([dx, dy]) => available(dx, dy))
            if (offset) [x, y] = offset
        }
        occupied.push({ x: point.x + x, y: point.y + y })
        marker.setOffset([x, y])
        const style = marker.getElement().style
        style.setProperty('--pa-address-leader', `${Math.max(0, Math.hypot(x, y) - 15)}px`)
        style.setProperty('--pa-address-leader-rotation', `${Math.atan2(-y, -x)}rad`)
    }
}

function fitContext() {
    if (!map || !ready || !container.value) return
    const bounds = new LngLatBounds()
    const previewBounds = props.addressPreview?.groups[0]?.bounds
    if (previewBounds) {
        bounds.extend([previewBounds[0], previewBounds[1]])
        bounds.extend([previewBounds[2], previewBounds[3]])
    } else if (props.analysisBounds) {
        bounds.extend([props.analysisBounds[0], props.analysisBounds[1]])
        bounds.extend([props.analysisBounds[2], props.analysisBounds[3]])
    } else {
        return
    }
    if (!previewBounds && props.stationContext) {
        bounds.extend([props.stationContext.lon, props.stationContext.lat])
    }
    const area = container.value.getBoundingClientRect()
    if (!area.width || !area.height) return
    const layers = container.value.closest('.pa-map-shell')?.querySelector('.pa-layers')?.getBoundingClientRect()
    const stacked = window.matchMedia('(max-width: 820px)').matches
    // Reserve the space occupied by the layer panel so fitted markers remain usable.
    const padding = stacked
        ? { top: 24, left: 24, right: 24, bottom: Math.min((layers?.height ?? area.height * .42) + 56, area.height - 100) }
        : { top: 40, left: 40, bottom: 40, right: Math.min((layers?.width ?? 300) + 32, area.width - 120) }
    map.fitBounds(bounds, { padding, maxZoom: previewBounds ? 16.5 : 15.15, duration: 0 })
}

function baseStyle(): StyleSpecification {
    const style = basemap as unknown as StyleSpecification
    return { ...style, sprite: new URL(String(style.sprite), window.location.href).href }
}

function firstLabelLayer(instance: MapLibreMap) {
    return instance.getStyle().layers.find(layer => layer.type === 'symbol' && layer.layout?.['text-field'])?.id
}

function buildingsVisibility(instance: MapLibreMap) {
    // Use camera zoom because terrain can adjust the rendering zoom.
    return instance.getZoom() >= buildingsMinZoom ? 'visible' : 'none'
}

function syncBuildingsVisibility() {
    if (!map?.getLayer(buildingsLayerId)) return
    const visibility = buildingsVisibility(map)
    if (map.getLayoutProperty(buildingsLayerId, 'visibility') !== visibility) {
        map.setLayoutProperty(buildingsLayerId, 'visibility', visibility)
    }
}

function addBuildingsLayer(instance: MapLibreMap) {
    const source = 'openmaptiles'
    if (!instance.getSource(source)) return

    const height: ExpressionSpecification = ['number', ['get', 'render_height'], -1]
    const base: ExpressionSpecification = ['number', ['get', 'render_min_height'], -1]
    const before = firstLabelLayer(instance)
    instance.addLayer({
        id: buildingsLayerId,
        type: 'fill-extrusion',
        source,
        'source-layer': 'building',
        minzoom: buildingsMinZoom,
        layout: { visibility: buildingsVisibility(instance) },
        filter: [
            'all',
            ['!', ['in', ['to-string', ['get', 'hide_3d']], ['literal', ['true', '1']]]],
            ['>=', base, 0],
            ['>', height, base],
        ],
        paint: {
            'fill-extrusion-color': buildingsColors[theme.value],
            'fill-extrusion-height': height,
            'fill-extrusion-base': base,
            'fill-extrusion-opacity': .88,
        },
    }, before ?? 'pa-radius-fill')
}

function clearTerrainLoadTimer() {
    clearTimeout(terrainLoadTimer)
    terrainLoadTimer = undefined
}

function setTerrainMode(enabled: boolean) {
    if (!map || !ready || terrainEnabled.value === enabled) return
    map.stop()
    const center = map.getCenter()
    const zoom = map.getZoom()

    terrainError.value = false
    terrainEnabled.value = enabled
    clearTerrainLoadTimer()
    if (enabled) {
        map.addSource(terrainSourceId, {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            encoding: 'terrarium',
            tileSize: 256,
            maxzoom: 15,
            attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer">Рельеф AWS Terrain Tiles</a> · USGS · NOAA',
        })
        map.setMaxPitch(60)
        map.setTerrain({ source: terrainSourceId, exaggeration: 1.5 })
        addBuildingsLayer(map)
        terrainLoadTimer = setTimeout(terrainUnavailable, 8000)
        map.jumpTo({ center, zoom, pitch: 55 })
    } else {
        if (map.getLayer(buildingsLayerId)) map.removeLayer(buildingsLayerId)
        map.setTerrain(null)
        map.removeSource(terrainSourceId)
        map.jumpTo({ center, zoom, pitch: 0 })
        map.setMaxPitch(0)
    }
}

function terrainUnavailable() {
    if (terrainLoadTimer === undefined) return
    setTerrainMode(false)
    terrainError.value = true
}

function initMap() {
    if (!container.value || map) return
    map = new MapLibreMap({
        container: container.value,
        style: themedBasemap(baseStyle(), theme.value),
        center: [props.center.lon, props.center.lat],
        zoom: 15.15,
        pitch: 0,
        maxPitch: 0,
        bearing: 0,
        attributionControl: { compact: false },
    })
    statusTimer = setTimeout(() => {
        if (mapStatus.value === 'loading') {
            mapStatus.value = 'error'
            mapStatusText.value = 'Не удалось загрузить подложку. Проверьте сеть и повторите страницу.'
        }
    }, 8000)
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left')
    imageryAttributionTarget.value = container.value.querySelector('.maplibregl-ctrl-bottom-right')
    map.on('move', clipPoiMarkers)
    map.on('moveend', spaceAddressMarkers)
    map.on('moveend', imageryBasemap.onMoveEnd)
    map.on('zoom', syncBuildingsVisibility)
    map.on('click', event => {
        if (!props.pickMode && props.addressPreview && map?.getLayer('pa-address-fill')) {
            const ids = new Set(map.queryRenderedFeatures(event.point, { layers: ['pa-address-fill', 'pa-address-point', 'pa-address-outline'] })
                .map(feature => feature.properties?.id as string))
            if (ids.size) {
                const [id] = ids
                if (ids.size === 1 && id) emit('select-address', id)
                return
            }
        }
        if (!props.pickMode && !props.addressPreview && map?.getLayer('pa-poi-fill')) {
            const feature = map.queryRenderedFeatures(event.point, { layers: ['pa-poi-fill'] })[0]
            if (typeof feature?.properties?.id === 'string') { emit('select-poi', feature.properties.id); return }
        }
        emit('select-point', { lon: event.lngLat.lng, lat: event.lngLat.lat })
    })
    map.on('style.load', () => {
        if (!map || ready) return
        ready = true
        if (statusTimer) { clearTimeout(statusTimer); statusTimer = null }
        mapStatus.value = 'ready'
        applyBasemapTheme(map, baseStyle(), theme.value)
        addLayers()
        for (const layer of satelliteClipLayers(() => ({ enabled: props.satelliteScope === 'circle' && props.showSatellite && !!props.satelliteLayers, area: props.analysisArea }))) map.addLayer(layer)
        syncLayers()
        syncPoiMarkers()
        syncMarkers()
        syncAddressPreview()
        fitContext()
    })
    map.on('sourcedata', event => {
        imageryBasemap.onSourceData(event)
        if (event.sourceId === terrainSourceId && event.tile?.dem) clearTerrainLoadTimer()
    })
    map.on('error', event => {
        const sourceId = String((event as unknown as { sourceId?: string }).sourceId ?? '')
        // Allow other DEM tiles to load. Only a failed initial load returns to 2D.
        if (sourceId === terrainSourceId) return
        const currentSources = new Set(Object.values(rasterLayers).map(value => value.source).filter(Boolean))
        const satelliteFailure = !!sourceId && currentSources.has(sourceId)
        if (satelliteFailure) {
            rasterError.value = true
            return
        }
        if (mapStatus.value === 'ready') return
        mapStatus.value = 'error'
        mapStatusText.value = event?.error?.message || 'Подложка карты недоступна.'
    })
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
            map?.resize()
            fitContext()
        })
        resizeObserver.observe(container.value)
    }
}

watch(theme, value => {
    if (!map || !ready) return
    applyBasemapTheme(map, baseStyle(), value)
    if (map.getLayer(buildingsLayerId)) map.setPaintProperty(buildingsLayerId, 'fill-extrusion-color', buildingsColors[value])
    map.triggerRepaint()
})

watch([() => props.center.lon, () => props.center.lat], () => {
    map?.jumpTo({ center: [props.center.lon, props.center.lat] })
    syncLayers()
    syncMarkers()
    fitContext()
})

watch(() => props.pendingPoint, p => {
    if (p && props.pendingDraggable && map) map.easeTo({ center: [p.lon, p.lat], duration: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } })
})

watch(() => props.radius, () => {
    syncLayers()
    syncMarkers()
    fitContext()
})

watch(() => props.addressPreview, (next, previous) => {
    syncAddressPreview()
    if (next?.groups[0] !== previous?.groups[0]) fitContext()
})

watch([
    () => props.analysisBounds?.[0], () => props.analysisBounds?.[1],
    () => props.analysisBounds?.[2], () => props.analysisBounds?.[3],
], fitContext)

watch(() => props.selectedPoi, () => syncPoiSelection())
watch(() => props.airHourRows, syncStationHourLabels)
watch(() => props.layerOrder, () => applyLayerOrder(), { deep: true })
watch(() => props.stationContext, point => {
    if (point) fitContext()
})

watch([poiCategory, () => props.showObjects, () => props.pois, () => props.poiDistancesKnown], () => {
    syncPoiGeometry()
    syncPoiMarkers()
})

watch(() => [props.showSatellite, props.satelliteMode, props.satelliteScope, props.satelliteOpacity, props.satelliteLayers], syncSatelliteRasters)

watch(
    () => [
        props.showPlacePin, props.geometryStale, props.showStations, props.showRadius,
        props.selectedStation, props.pendingPoint, props.pendingDraggable, props.analysisArea, props.stations,
    ],
    () => {
        syncLayers()
        syncMarkers()
    },
)

function focusMap() {
    container.value?.focus()
}

defineExpose({ focusMap, fitContext, mapReady, terrainEnabled, setTerrainMode, basemapMode, selectBasemap })

onMounted(initMap)
onBeforeUnmount(() => {
    imageryBasemap.dispose()
    clearTerrainLoadTimer()
    clearMarkers(addressMarkers)
    clearMarkers(poiMarkers)
    clearMarkers(stationMarkers)
    pinMarker?.remove()
    pendingMarker?.remove()
    radiusLabel?.remove()
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null }
    resizeObserver?.disconnect()
    resizeObserver = null
    map?.remove()
    map = null
    ready = false
})
</script>

<template>
    <div class="pa-map-host" :class="{ 'is-picking': pickMode }" :data-map-theme="theme" :data-layer-order="props.layerOrder.join(' ')">
        <div
            ref="container"
            class="pa-map"
            role="application"
            tabindex="0"
            :aria-label="pickMode ? 'Карта анализа места. Enter выбирает точку в центре, Escape отменяет выбор.' : 'Карта анализа места'"
            @keydown="mapKeydown"
        ></div>
        <Teleport v-if="basemapMode === 'satellite' && imagery && imageryAttributionTarget" :to="imageryAttributionTarget">
            <div class="maplibregl-ctrl pa-imagery-credit" aria-label="Источник спутниковой подложки">
                <img class="pa-imagery-credit__logo" :src="googleMapsLogo" alt="Google Maps">
                <span>{{ imagery.attribution }}</span>
            </div>
        </Teleport>
        <div v-if="$slots['air-hour'] || rasterError || terrainError || basemapError" class="pa-map-notices"
            :class="{ 'has-air-hour': $slots['air-hour'], 'has-map-alert': rasterError || terrainError || basemapError }">
            <slot name="air-hour" />
            <p v-if="basemapError" class="pa-map-alert" role="alert">
                <TriangleAlert :size="16" aria-hidden="true" />
                <span>Спутниковая подложка недоступна. Показана обычная карта.</span>
                <button type="button" class="pa-outline" @click="selectBasemap(true)">Повторить</button>
            </p>
            <p v-if="terrainError" class="pa-map-alert" role="alert">
                <TriangleAlert :size="16" aria-hidden="true" />
                <span>Рельеф недоступен. Карта переключена в 2D.</span>
            </p>
            <p v-if="rasterError" class="pa-map-alert" role="alert">
                <TriangleAlert :size="16" aria-hidden="true" />
                <span>Не удалось загрузить изображение. Аналитика по кругу сохранена.</span>
                <button type="button" class="pa-outline" @click="emit('retry-satellite')">Повторить</button>
            </p>
        </div>
        <p v-if="mapStatus !== 'ready'" class="pa-map-status" role="status">{{ mapStatusText }}</p>
    </div>
</template>
