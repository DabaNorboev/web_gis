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
    type GeoJSONSource,
    type StyleSpecification,
} from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import basemap from '@/maps/basemap.json'
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
import { addressFeatures, type AddressMapState } from '@/utils/addressMap'
import type { Feature, FeatureCollection, Polygon, MultiPolygon, Point } from 'geojson'
import type { SatelliteLayerKey, SatelliteRasterSource } from '@/types/placeAnalysis'

const props = withDefaults(defineProps<{
    addressPreview?: AddressMapState | null
    showPlacePin?: boolean
    geometryStale?: boolean
    center: AnalysisPoint
    radius: number
    pois: { id: string; category: PoiCategory; name: string; lon: number; lat: number; distance_m: number; geometry?: Point | Polygon | MultiPolygon }[]
    analysisArea?: Polygon | null
    analysisBounds?: [number, number, number, number] | null
    stations?: { id: string; name: string; lon: number; lat: number; number: number; distance_km: number }[]
    poiDistancesKnown: boolean
    tab: AnalysisTab
    showObjects: boolean
    showSatellite: boolean
    showStations: boolean
    showRadius: boolean
    layerOrder: AnalysisLayer[]
    satelliteMode: SatelliteMode
    satelliteScope: 'territory' | 'circle'
    satelliteOpacity: number
    satelliteLayers: Partial<Record<SatelliteLayerKey, SatelliteRasterSource>> | null
    categoryFilter: PoiCategory | null
    selectedPoi: string | null
    selectedStation: string | null
    stationFocusRequest: number
    pendingPoint: AnalysisPoint | null
    pickMode: boolean
}>(), { satelliteOpacity: .75, showPlacePin: true, geometryStale: false, analysisArea: null, analysisBounds: null, stations: () => [], addressPreview: null })

const stations = computed(() => props.stations)

const emit = defineEmits<{ 'select-point': [point: AnalysisPoint]; 'select-station': [id: string]; 'select-poi': [id: string]; 'cancel-pick': []; 'highlight-address': [id: string | null]; 'select-address': [id: string]; 'retry-satellite': [] }>()
const { theme } = useMapTheme()
const categoryIcons: Record<PoiCategory, Component> = {
    grocery: ShoppingBasket, pharmacy: Pill, official_stop: BusFront, park: Trees,
}
const container = ref<HTMLElement | null>(null)
const mapStatus = ref<'loading' | 'ready' | 'error'>('loading')
const mapStatusText = ref('Загрузка карты…')
let map: MapLibreMap | null = null
let ready = false
let addressMarkers: Marker[] = []
let poiMarkers: Marker[] = []
let stationMarkers: Marker[] = []
let pinMarker: Marker | null = null
let pendingMarker: Marker | null = null
let radiusLabel: Marker | null = null
let resizeObserver: ResizeObserver | null = null
let statusTimer: ReturnType<typeof setTimeout> | null = null
let focusedStation: string | null = null
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
        && (props.tab !== 'objects' || !props.categoryFilter || p.category === props.categoryFilter))
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
    clearMarkers(poiMarkers)
    clearMarkers(stationMarkers)
    poiMarkers = []
    stationMarkers = []
    pinMarker?.remove()
    pinMarker = null
    pendingMarker?.remove()
    pendingMarker = null
    radiusLabel?.remove()
    radiusLabel = null

    if (props.showObjects) {
        const filter = props.tab === 'objects' ? props.categoryFilter : null
        for (const poi of props.pois) {
            if (filter && poi.category !== filter) continue
            const element = poiMarkerElement(
                poi,
                props.poiDistancesKnown ? `${poi.name} · ${poi.distance_m} м по прямой` : `${poi.name} · демонстрационный объект`,
            )
            poiMarkers.push(new Marker({ element }).setLngLat([poi.lon, poi.lat]).addTo(instance))
        }
    }

    if (props.showStations) {
        for (const station of stations.value) {
            const element = document.createElement('button')
            element.type = 'button'
            element.className = `pa-map-station${station.id === props.selectedStation ? ' is-selected' : ''}`
            element.textContent = String(station.number)
            element.setAttribute('aria-label', `${station.name} · ${station.distance_km} км`)
            element.addEventListener('click', event => {
                event.stopPropagation()
                emit('select-station', station.id)
            })
            element.dataset.stationId = station.id
            stationMarkers.push(new Marker({ element, anchor: 'center' }).setLngLat([station.lon, station.lat]).addTo(instance))
        }
    }

    const pinElement = document.createElement('div')
    pinElement.className = 'pa-map-pin'
    pinElement.innerHTML = '<span class="pa-map-pin__pulse"></span><span class="pa-map-pin__dot"></span>'
    if (props.showPlacePin) pinMarker = new Marker({ element: pinElement, anchor: 'center' }).setLngLat([props.center.lon, props.center.lat]).addTo(instance)

    if (props.pendingPoint) {
        const pendingElement = document.createElement('div')
        pendingElement.className = 'pa-map-pending'
        pendingMarker = new Marker({ element: pendingElement, anchor: 'center' })
            .setLngLat([props.pendingPoint.lon, props.pendingPoint.lat]).addTo(instance)
    }

    if (props.showRadius && !!props.analysisArea) {
        const anchor = circlePoint(props.center, props.radius, 42)
        const label = markerElement('pa-map-radius-label', `Радиус анализа ${props.radius} метров`)
        label.textContent = `R = ${props.radius} м${props.geometryStale ? ' · предыдущий' : ''}`
        radiusLabel = new Marker({ element: label }).setLngLat([anchor.lon, anchor.lat]).addTo(instance)
    }
    clipPoiMarkers()
    applyMarkerOrder()
}

function syncAddressPreview() {
    if (!map || !ready) return
    const state = props.addressPreview
    const source = map.getSource('pa-address-preview') as GeoJSONSource | undefined
    source?.setData(state ? addressFeatures(state) : { type: 'FeatureCollection', features: [] })
    const objects = state?.groups.flatMap(group => group.objects) ?? []
    if (addressMarkers.map(marker => marker.getElement().dataset.addressId).join('|') !== objects.map(o => o.id).join('|')) {
        clearMarkers(addressMarkers)
        addressMarkers = []
        for (const group of state?.groups ?? []) for (const [index, object] of group.objects.entries()) {
            const element = document.createElement('button')
            element.type = 'button'
            element.className = 'pa-address-marker'
            element.textContent = String(index + 1)
            element.dataset.addressId = object.id
            element.setAttribute('aria-label', `${group.label} · объект ${index + 1}`)
            element.addEventListener('pointerdown', event => event.preventDefault())
            element.addEventListener('pointerenter', () => emit('highlight-address', object.id))
            element.addEventListener('pointerleave', () => emit('highlight-address', null))
            element.addEventListener('focus', () => emit('highlight-address', object.id))
            element.addEventListener('click', event => { event.stopPropagation(); emit('select-address', object.id) })
            addressMarkers.push(new Marker({ element }).setLngLat([object.lon, object.lat]).addTo(map))
        }
    }
    for (const marker of addressMarkers) {
        const element = marker.getElement()
        const highlighted = element.dataset.addressId === state?.highlightedId
        element.classList.toggle('is-highlighted', highlighted)
        element.setAttribute('aria-pressed', String(highlighted))
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
    if (!previewBounds && props.showStations) {
        for (const station of stations.value) {
            bounds.extend([station.lon, station.lat])
        }
    }
    const area = container.value.getBoundingClientRect()
    if (!area.width || !area.height) return
    const layers = container.value.closest('.pa-map-shell')?.querySelector('.pa-layers')?.getBoundingClientRect()
    const stacked = window.matchMedia('(max-width: 820px)').matches
    // Reserve the space occupied by the layer panel so fitted markers remain usable.
    const padding = stacked
        ? { top: 24, left: 24, right: 24, bottom: Math.min((layers?.height ?? area.height * .42) + 56, area.height - 100) }
        : { top: 40, left: 40, bottom: 40, right: Math.min((layers?.width ?? 300) + 32, area.width - 120) }
    map.fitBounds(bounds, { padding, maxZoom: 15.15, duration: 0 })
}

function centerStation() {
    if (!map || !ready || !props.showStations) return
    const station = stations.value.find(value => value.id === focusedStation)
    if (!station) return
    // fitBounds retains its asymmetric padding. Clear it for an actual canvas center.
    map.easeTo({
        center: [station.lon, station.lat],
        padding: { top: 0, bottom: 0, left: 0, right: 0 },
        duration: 0,
    })
}

function baseStyle(): StyleSpecification {
    const style = basemap as unknown as StyleSpecification
    return { ...style, sprite: new URL(String(style.sprite), window.location.href).href }
}

function initMap() {
    if (!container.value || map) return
    map = new MapLibreMap({
        container: container.value,
        style: themedBasemap(baseStyle(), theme.value),
        center: [props.center.lon, props.center.lat],
        zoom: 15.15,
        pitch: 0,
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
    map.on('move', clipPoiMarkers)
    map.on('click', event => {
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
        syncMarkers()
        syncAddressPreview()
        if (focusedStation) centerStation()
        else fitContext()
    })
    map.on('error', event => {
        const sourceId = String((event as unknown as { sourceId?: string }).sourceId ?? '')
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
            if (focusedStation && props.showStations && !props.addressPreview) centerStation()
            else fitContext()
        })
        resizeObserver.observe(container.value)
    }
}

watch(theme, value => {
    if (!map || !ready) return
    applyBasemapTheme(map, baseStyle(), value)
    map.triggerRepaint()
})

watch(() => [props.center.lon, props.center.lat], () => {
    focusedStation = null
    map?.jumpTo({ center: [props.center.lon, props.center.lat] })
    syncLayers()
    syncMarkers()
    fitContext()
})

watch(() => props.radius, () => {
    focusedStation = null
    syncLayers()
    syncMarkers()
    fitContext()
})

watch(() => props.addressPreview, (next, previous) => {
    syncAddressPreview()
    if (next?.groups[0] !== previous?.groups[0]) fitContext()
}, { deep: true })

watch(() => props.analysisBounds, () => {
    syncLayers()
    syncMarkers()
    fitContext()
})

watch(() => props.selectedPoi, () => syncPoiSelection())
watch(() => props.layerOrder, () => applyLayerOrder(), { deep: true })
watch(() => props.showStations, () => {
    focusedStation = null
    fitContext()
})
watch(() => props.stationFocusRequest, () => {
    focusedStation = props.selectedStation
    centerStation()
})

watch(
    () => [
        props.showPlacePin, props.geometryStale, props.tab, props.showObjects, props.showSatellite, props.showStations, props.showRadius,
        props.satelliteMode, props.satelliteScope, props.satelliteOpacity, props.satelliteLayers, props.categoryFilter, props.selectedStation, props.pendingPoint, props.pois, props.poiDistancesKnown, props.analysisArea, props.stations,
    ],
    () => {
        syncLayers()
        syncMarkers()
    },
)

function focusMap() {
    container.value?.focus()
}

defineExpose({ focusMap })

onMounted(initMap)
onBeforeUnmount(() => {
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
        <p v-if="rasterError" class="pa-map-alert" role="alert">
            <TriangleAlert :size="16" aria-hidden="true" />
            <span>Не удалось загрузить изображение. Аналитика по кругу сохранена.</span>
            <button type="button" class="pa-outline" @click="emit('retry-satellite')">Повторить</button>
        </p>
        <p v-if="mapStatus !== 'ready'" class="pa-map-status" role="status">{{ mapStatusText }}</p>
    </div>
</template>
