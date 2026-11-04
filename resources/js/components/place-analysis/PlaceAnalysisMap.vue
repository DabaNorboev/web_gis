<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
    Map as MapLibreMap,
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
import {
    categoryMeta,
    demoPois,
    demoStations,
    type AnalysisTab,
    type DemoPoint,
    type PoiCategory,
    type SatelliteMode,
} from '@/place-analysis-demo'
import type { Feature, Polygon } from 'geojson'

const props = withDefaults(defineProps<{
    center: DemoPoint
    radius: number
    tab: AnalysisTab
    showObjects: boolean
    showSatellite: boolean
    showStations: boolean
    showRadius: boolean
    satelliteMode: SatelliteMode
    satelliteOpacity: number
    categoryFilter: PoiCategory | null
    selectedStation: string | null
    pendingPoint: DemoPoint | null
}>(), { satelliteOpacity: .75 })

const emit = defineEmits<{ 'select-point': [point: DemoPoint] }>()
const container = ref<HTMLElement | null>(null)
const mapStatus = ref<'loading' | 'ready' | 'error'>('loading')
const mapStatusText = ref('Загрузка карты…')
let map: MapLibreMap | null = null
let ready = false
let poiMarkers: Marker[] = []
let stationMarkers: Marker[] = []
let pinMarker: Marker | null = null
let pendingMarker: Marker | null = null
let radiusLabel: Marker | null = null
let resizeObserver: ResizeObserver | null = null
let statusTimer: ReturnType<typeof setTimeout> | null = null

setWorkerUrl(workerUrl)

function circlePoint(center: DemoPoint, radiusM: number, bearingDeg: number): DemoPoint {
    const earth = 6378137
    const lat1 = center.lat * Math.PI / 180
    const lon1 = center.lon * Math.PI / 180
    const bearing = bearingDeg * Math.PI / 180
    const distance = radiusM / earth
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing))
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1), Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2))
    return { lon: lon2 * 180 / Math.PI, lat: lat2 * 180 / Math.PI }
}

function circleCoords(center: DemoPoint, radiusM: number, steps = 96): [number, number][] {
    const coordinates: [number, number][] = []
    for (let index = 0; index <= steps; index += 1) {
        const point = circlePoint(center, radiusM, index * 360 / steps)
        coordinates.push([point.lon, point.lat])
    }
    return coordinates
}

function sectorCoords(center: DemoPoint, radiusM: number): [number, number][] {
    const startDeg = 15
    const endDeg = 115
    const coordinates: [number, number][] = [[center.lon, center.lat]]
    for (let index = 0; index <= 28; index += 1) {
        const point = circlePoint(center, radiusM, startDeg + (endDeg - startDeg) * index / 28)
        coordinates.push([point.lon, point.lat])
    }
    coordinates.push([center.lon, center.lat])
    return coordinates
}

function circleFeature(center: DemoPoint, radiusM: number): Feature<Polygon> {
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circleCoords(center, radiusM)] } }
}

function sectorFeature(center: DemoPoint, radiusM: number): Feature<Polygon> {
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [sectorCoords(center, radiusM)] } }
}

function addHatchImage(instance: MapLibreMap) {
    if (instance.hasImage('pa-unknown-hatch')) return
    const size = 10
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) return
    context.strokeStyle = 'rgba(62, 79, 68, .58)'
    context.lineWidth = 1.2
    context.beginPath()
    context.moveTo(-size, size)
    context.lineTo(size, -size)
    context.moveTo(0, size * 2)
    context.lineTo(size * 2, 0)
    context.stroke()
    const data = context.getImageData(0, 0, size, size)
    instance.addImage('pa-unknown-hatch', { width: size, height: size, data: new Uint8Array(data.data) })
}

function addLayers() {
    if (!map || map.getSource('pa-radius')) return
    map.addSource('pa-radius', { type: 'geojson', data: circleFeature(props.center, props.radius) })
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
    map.addSource('pa-satellite', { type: 'geojson', data: circleFeature(props.center, props.radius) })
    map.addLayer({
        id: 'pa-satellite-fill',
        type: 'fill',
        source: 'pa-satellite',
        paint: { 'fill-color': '#4d8f52', 'fill-opacity': 0.35 },
    })
    map.addSource('pa-unknown', { type: 'geojson', data: sectorFeature(props.center, props.radius) })
    map.addLayer({
        id: 'pa-unknown-hatch',
        type: 'fill',
        source: 'pa-unknown',
        paint: { 'fill-pattern': 'pa-unknown-hatch', 'fill-opacity': 1 },
    })
}

function setVisibility(id: string, visible: boolean) {
    if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
}

function syncLayers() {
    if (!map || !ready) return
    const radiusSource = map.getSource('pa-radius') as GeoJSONSource | undefined
    const satelliteSource = map.getSource('pa-satellite') as GeoJSONSource | undefined
    const unknownSource = map.getSource('pa-unknown') as GeoJSONSource | undefined
    radiusSource?.setData(circleFeature(props.center, props.radius))
    satelliteSource?.setData(circleFeature(props.center, props.radius))
    unknownSource?.setData(sectorFeature(props.center, props.radius))
    setVisibility('pa-radius-fill', props.showRadius)
    setVisibility('pa-radius-line', props.showRadius)
    setVisibility('pa-satellite-fill', props.showSatellite)
    setVisibility('pa-unknown-hatch', props.showSatellite)
    if (map.getLayer('pa-satellite-fill')) {
        map.setPaintProperty('pa-satellite-fill', 'fill-color', props.satelliteMode === 'ndvi' ? '#2f8f3d' : '#b29a78')
        map.setPaintProperty('pa-satellite-fill', 'fill-opacity', Math.max(0, Math.min(1, props.satelliteOpacity)))
    }
    map.triggerRepaint()
}

function markerElement(className: string, text: string, label: string): HTMLDivElement {
    const element = document.createElement('div')
    element.className = className
    element.textContent = text
    element.title = label
    element.setAttribute('aria-label', label)
    return element
}

function clearMarkers(markers: Marker[]) {
    for (const marker of markers) marker.remove()
}

function syncMarkers() {
    if (!map || !ready) return
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
        for (const poi of demoPois) {
            if (filter && poi.category !== filter) continue
            const element = markerElement(
                `pa-map-marker pa-map-marker--${poi.category}`,
                categoryMeta[poi.category].glyph,
                `${poi.name} · ${poi.distance_m} м по прямой`,
            )
            poiMarkers.push(new Marker({ element }).setLngLat([poi.lon, poi.lat]).addTo(map))
        }
    }

    if (props.showStations) {
        for (const station of demoStations) {
            const element = markerElement(
                `pa-map-station${station.id === props.selectedStation ? ' is-selected' : ''}`,
                String(station.number),
                `${station.name} · ${station.distance_km} км`,
            )
            stationMarkers.push(new Marker({ element, anchor: 'center' }).setLngLat([station.lon, station.lat]).addTo(map))
        }
    }

    const pinElement = document.createElement('div')
    pinElement.className = 'pa-map-pin'
    pinElement.innerHTML = '<span class="pa-map-pin__pulse"></span><span class="pa-map-pin__dot"></span>'
    pinMarker = new Marker({ element: pinElement, anchor: 'center' }).setLngLat([props.center.lon, props.center.lat]).addTo(map)

    if (props.pendingPoint) {
        const pendingElement = document.createElement('div')
        pendingElement.className = 'pa-map-pending'
        pendingMarker = new Marker({ element: pendingElement, anchor: 'center' })
            .setLngLat([props.pendingPoint.lon, props.pendingPoint.lat]).addTo(map)
    }

    if (props.showRadius) {
        const anchor = circlePoint(props.center, props.radius, 42)
        const label = markerElement('pa-map-radius-label', `R = ${props.radius} м`, `Радиус анализа ${props.radius} метров`)
        radiusLabel = new Marker({ element: label }).setLngLat([anchor.lon, anchor.lat]).addTo(map)
    }
}

function initMap() {
    if (!container.value || map) return
    const baseStyle = basemap as unknown as StyleSpecification
    const style = { ...baseStyle, sprite: new URL(String(baseStyle.sprite), window.location.href).href }
    map = new MapLibreMap({
        container: container.value,
        style,
        center: [props.center.lon, props.center.lat],
        zoom: 15.15,
        pitch: 0,
        bearing: 0,
        attributionControl: false,
    })
    statusTimer = setTimeout(() => {
        if (mapStatus.value === 'loading') {
            mapStatus.value = 'error'
            mapStatusText.value = 'Не удалось загрузить подложку. Проверьте сеть и повторите страницу.'
        }
    }, 8000)
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left')
    map.on('click', event => emit('select-point', { lon: event.lngLat.lng, lat: event.lngLat.lat }))
    map.on('style.load', () => {
        if (!map || ready) return
        ready = true
        if (statusTimer) { clearTimeout(statusTimer); statusTimer = null }
        mapStatus.value = 'ready'
        addHatchImage(map)
        addLayers()
        syncLayers()
        syncMarkers()
    })
    map.on('error', event => {
        if (mapStatus.value === 'ready') return
        mapStatus.value = 'error'
        mapStatusText.value = event?.error?.message || 'Подложка карты недоступна.'
    })
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => map?.resize())
        resizeObserver.observe(container.value)
    }
}

watch(() => [props.center.lon, props.center.lat], () => {
    map?.jumpTo({ center: [props.center.lon, props.center.lat] })
    syncLayers()
    syncMarkers()
})

watch(() => props.radius, () => {
    syncLayers()
    syncMarkers()
})

watch(
    () => [
        props.tab, props.showObjects, props.showSatellite, props.showStations, props.showRadius,
        props.satelliteMode, props.satelliteOpacity, props.categoryFilter, props.selectedStation, props.pendingPoint,
    ],
    () => {
        syncLayers()
        syncMarkers()
    },
)

onMounted(initMap)
onBeforeUnmount(() => {
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
    <div class="pa-map-host">
        <div ref="container" class="pa-map" role="application" aria-label="Демонстрационная карта анализа места"></div>
        <p v-if="mapStatus !== 'ready'" class="pa-map-status" role="status">{{ mapStatusText }}</p>
    </div>
</template>
