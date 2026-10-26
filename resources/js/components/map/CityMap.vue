<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Map, NavigationControl, ScaleControl, setWorkerUrl, type StyleSpecification, type GeoJSONSource } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import basemap from '@/maps/basemap.json'
import MapThemeControl from './MapThemeControl.vue'
import { scrollMapSidebar } from '@/utils/mapSidebarScroll'
import AddressMapLabels from './AddressMapLabels.vue'
import { useMapTheme } from '@/composables/useMapTheme'
import { themedBasemap, applyBasemapTheme, placeColors } from '@/utils/mapTheme'
import { placeMapLabels, type ScreenLabel } from '@/utils/mapLabels'
import { mapLayerDefinitions } from '@/utils/mapLayerPresentation'
import type { MapLayerKey } from '@/types/mapLayers'
import { addressFeatures, addressBounds } from '@/utils/addressMap'
import type { AddressResult } from '@/types/address'
import type { AddressProfile, AreaLayers, AreaVisibility, LinearLayers, LinearVisibility } from '@/types/profile'
import type { Coordinates, TransportAnalysis } from '@/types/transport'
import { createTripOverlay, tripOverlayBounds, type TripMapOverlay } from '@/utils/tripOverlay'

const props = withDefaults(defineProps<{ point: Coordinates | null; addressGroup: AddressResult | null; selectedAddressId: string | null; analysis: Pick<TransportAnalysis, 'analysis_area' | 'analysis_bounds' | 'stops_in_radius'> | null; radius: number; selectedStopId: number | null; selectable?: boolean; showStops?: boolean; showAnalysisArea?: boolean; areaLayers?: AreaLayers | null; areaVisibility?: AreaVisibility; linearLayers?: LinearLayers | null; linearVisibility?: LinearVisibility; addressGroups?: AddressResult[]; highlightedAddressId?: string | null; highlightedGroupId?: string | null; placeLabel?: 'А' | 'Б'; scrollTarget?: HTMLElement | null; overlayControls?: boolean; hideTheme?: boolean; sharedView?: { zoom: number; bearing: number; pitch: number } | null; selectionZoomLimit?: number; profile?: AddressProfile | null; tripOverlay?: TripMapOverlay | null; tripPicking?: boolean; focusRequest?: { layer: MapLayerKey; id?: string; sequence: number } | null }>(), { selectable: true, showStops: true, showAnalysisArea: true })
const emit = defineEmits<{ select: [point: Coordinates]; roadCandidate: [key: string, point: Coordinates]; selectStop: [id: number]; clearStop: []; selectObject: [selection: { layer: MapLayerKey; id: string } | null]; selectAddressObject: [id: string]; highlightAddressObject: [id: string | null]; viewChange: [view: { zoom: number; bearing: number; pitch: number }]; viewReady: [view: { zoom: number; bearing: number; pitch: number }] }>()
const { theme } = useMapTheme()
const placeColor = computed(() => placeColors[props.placeLabel ?? 'default'])
const groups = computed(() => props.addressGroups ?? (props.addressGroup ? [props.addressGroup] : []))
const labels = ref<ScreenLabel[]>([])
const selectedFeature = ref<{ layer: MapLayerKey; id: string; name: string } | null>(null)
function clearObjectSelection() { selectedFeature.value = null }
watch(selectedFeature, selection => emit('selectObject', selection))
async function closeSelection() {
    clearObjectSelection(); emit('clearStop')
    await nextTick()
    map?.getCanvas().focus({ preventScroll: true })
}
const selectionDistance = computed(() => {
    if (selectedGeometry.value && selectedFeature.value) {
        const block = props.profile?.blocks[selectedFeature.value.layer as keyof AddressProfile['blocks']]?.data
        if (block && 'nearest' in block && block.nearest?.id === selectedFeature.value.id) {
            const metric = block.metrics.nearest_distance
            if (metric?.value !== null && metric?.value !== undefined && metric.quality.availability === 'AVAILABLE')
                return `${Math.round(metric.value)} м · ${['roads', 'railways'].includes(selectedFeature.value.layer) ? 'до линии' : 'до контура'} по прямой`
        }
        return 'Расстояние до этого объекта в ответе отсутствует.'
    }
    return selectedStop.value && Number.isFinite(selectedStop.value.distance_m) ? `${Math.round(selectedStop.value.distance_m)} м · по прямой до точки остановки` : 'Расстояние до этого объекта в ответе отсутствует.'
})
function cameraView() { return map ? { zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() } : null }
let applyingView = false
function applySharedView() {
    const view = props.sharedView
    if (!map || !view) return
    if (Math.abs(map.getZoom() - view.zoom) < 1e-9 && Math.abs(map.getBearing() - view.bearing) < 1e-9 && Math.abs(map.getPitch() - view.pitch) < 1e-9) return
    applyingView = true
    // Deliberately omit center: these are two different neighbourhoods.
    map.jumpTo({ zoom: view.zoom, bearing: view.bearing, pitch: view.pitch })
    applyingView = false
}
watch(() => props.sharedView, applySharedView)
function resetView() {
    selectionSequence++
    if (!map || !props.analysis) return null
    applyingView = true
    map.resize()
    const [west, south, east, north] = props.analysis.analysis_bounds
    map.fitBounds([[west, south], [east, north]], { padding: mapPadding(), maxZoom: 16, duration: 0, bearing: 0, pitch: 0 })
    applyingView = false
    return cameraView()
}
defineExpose({ clearObjectSelection, resetView, focusSelection: focusSelected, focusTrip, centerPoint: () => { const p = map?.getCenter(); return p ? { lon: p.lng, lat: p.lat } : null } })
async function focusTrip() {
    const sequence = ++selectionSequence
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (!map || !props.tripOverlay || sequence !== selectionSequence) return
    const bounds = tripOverlayBounds(props.tripOverlay.data)
    if (!bounds) return
    map.resize()
    const height = map.getContainer().clientHeight, width = map.getContainer().clientWidth
    map.fitBounds(bounds, { padding: { top: Math.min(40, Math.max(20, height / 7)), bottom: Math.min(64, Math.max(36, height / 3)), left: Math.min(55, width / 6), right: Math.min(110, width * .6) }, maxZoom: Math.min(17, props.selectionZoomLimit ?? 17), duration: 0 })
}
watch(() => props.tripOverlay, (value, previous) => {
    selectionSequence++
    tripOverlay?.update()
    if (value && value.sequence !== previous?.sequence) void focusTrip()
}, { deep: true })
const activeCategory = ref<MapLayerKey | null>(props.focusRequest?.layer ?? null)
const legendOpen = ref(false)
const visibleLayers = computed(() => mapLayerDefinitions.filter(layer => layer.key === 'stops' ? props.showStops && !!props.analysis?.stops_in_radius.length : layer.key === 'roads' || layer.key === 'railways' ? props.linearVisibility?.[layer.key] && !!props.linearLayers?.[layer.key]?.data?.features.length : props.areaVisibility?.[layer.key] && !!props.areaLayers?.[layer.key]?.data?.features.length))
const selectedStop = computed(() => props.showStops ? props.analysis?.stops_in_radius.find(stop => stop.id === props.selectedStopId) : null)
const selectedGeometry = computed(() => {
    const selected = selectedFeature.value
    if (!selected || !visibleLayers.value.some(layer => layer.key === selected.layer)) return null
    const data = selected.layer === 'roads' || selected.layer === 'railways' ? props.linearLayers?.[selected.layer]?.data : selected.layer === 'stops' ? null : props.areaLayers?.[selected.layer]?.data
    return data?.features.find(feature => feature.properties.id === selected.id) ?? null
})
function updateLabels() {
    if (!map || !container.value || groups.value.length !== 1) { labels.value = []; return }
    const surface = container.value.getBoundingClientRect()
    const blocked = [...(container.value.closest('.city-map')?.querySelectorAll<HTMLElement>('.city-map-toolbar, .city-map-legend, .city-map-overview, .map-layers-body, .map-layer-details, .maplibregl-ctrl') ?? [])]
        .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > surface.top && rect.top < surface.bottom)
        .map(rect => ({ left: rect.left - surface.left, top: rect.top - surface.top, right: rect.right - surface.left, bottom: rect.bottom - surface.top }))
    labels.value = placeMapLabels(groups.value[0]!.objects.map((object, index) => {
        const point = map!.project([object.lon, object.lat])
        return { id: object.id, number: index + 1, x: point.x, y: point.y }
    }), container.value.clientWidth, container.value.clientHeight, props.showStops ? (props.analysis?.stops_in_radius ?? []).map(stop => map!.project([stop.lon, stop.lat])) : [], groups.value[0]!.objects.length === 1 && !props.placeLabel ? 116 : 32, blocked)
}
function selectFeature(layer: MapLayerKey, id: string) {
    const data = layer === 'roads' || layer === 'railways' ? props.linearLayers?.[layer]?.data : layer === 'stops' ? null : props.areaLayers?.[layer]?.data
    const feature = data?.features.find(feature => feature.properties.id === id)
    if (!feature) return
    activeCategory.value = layer
    emit('clearStop')
    selectedFeature.value = { layer, id, name: feature.properties.name || `${mapLayerDefinitions.find(item => item.key === layer)?.label}: ${id}` }
    void focusSelected()
}
function updateSelectedGeometry() {
    const source = map?.getSource('analysis-object-selection') as GeoJSONSource | undefined
    source?.setData({ type: 'FeatureCollection', features: selectedGeometry.value ? [selectedGeometry.value] : [] })
}
watch(selectedGeometry, updateSelectedGeometry)
watch(() => props.focusRequest, request => {
    if (!request) return
    activeCategory.value = request.layer
    selectedFeature.value = null
    if (request.layer === 'stops' && request.id) { void focusSelected(); return }
    if (request.id) { selectFeature(request.layer, request.id); return }
    focusAnalysis()
})
watch(() => [props.point, props.areaLayers, props.linearLayers, props.analysis], () => { selectionSequence++; selectedFeature.value = null; activeCategory.value = null })
watch(() => props.selectedStopId, id => { if (id !== null) { selectedFeature.value = null; void focusSelected() } })
function updateSelection() {
    const source = map?.getSource('transport-selection') as GeoJSONSource | undefined
    if (!source) return
    const data = addressFeatures({ groups: groups.value, selectedId: props.selectedAddressId, highlightedId: props.highlightedAddressId ?? null, highlightedGroupId: props.highlightedGroupId ?? null })
    if (props.point) data.features.push({ type: 'Feature', properties: { kind: 'point' }, geometry: { type: 'Point', coordinates: [props.point.lon, props.point.lat] } })
    if (props.analysis) {
        if (props.showAnalysisArea) data.features.push({ type: 'Feature', properties: { kind: 'area' }, geometry: props.analysis.analysis_area })
        for (const stop of props.analysis.stops_in_radius) {
            data.features.push({ type: 'Feature', properties: { id: stop.id, kind: stop.id === props.selectedStopId ? 'selected-stop' : 'stop' }, geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] } })
        }
    }
    source.setData(data)
}
watch(() => [props.point, props.analysis, props.showAnalysisArea, props.selectedStopId, groups.value, props.selectedAddressId, props.highlightedAddressId, props.highlightedGroupId], updateSelection)
watch(groups, updateLabels, { flush: 'post' })
watch(() => [props.showStops, props.analysis], updateLabels, { flush: 'post' })
function updateStopVisibility() {
    for (const id of ['nearby-stops', 'selected-stop']) {
        if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', props.showStops ? 'visible' : 'none')
    }
}
watch(() => props.showStops, updateStopVisibility)
const areaKinds = ['vegetation', 'parks', 'water'] as const
const areaColors = { parks: '#247346', vegetation: '#879326', water: '#287db0' }
function updateAreaLayers() {
    for (const kind of areaKinds) {
        const source = map?.getSource(`area-${kind}`) as GeoJSONSource | undefined
        const block = props.areaLayers?.[kind]
        source?.setData(block?.data ?? { type: 'FeatureCollection', features: [] })
        for (const suffix of ['fill', 'outline']) {
            const id = `area-${kind}-${suffix}`
            if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', props.areaVisibility?.[kind] ? 'visible' : 'none')
        }
    }
}
watch(() => [props.areaLayers, props.areaVisibility], updateAreaLayers, { deep: true })
const linearKinds = ['roads', 'railways'] as const
const linearColors = { roads: '#b45d17', railways: '#68427f' }
function updateLinearData() {
    for (const kind of linearKinds) {
        const source = map?.getSource(`linear-${kind}`) as GeoJSONSource | undefined
        source?.setData(props.linearLayers?.[kind]?.data ?? { type: 'FeatureCollection', features: [] })
    }
}
function updateLinearVisibility() {
    for (const kind of linearKinds) for (const suffix of ['casing', 'line']) {
        const id = `linear-${kind}-${suffix}`
        if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', props.linearVisibility?.[kind] ? 'visible' : 'none')
    }
}
watch(() => props.linearLayers, updateLinearData)
watch(() => props.linearVisibility, updateLinearVisibility, { deep: true })
function updateEmphasis() {
    for (const kind of areaKinds) {
        if (map?.getLayer(`area-${kind}-fill`)) map.setPaintProperty(`area-${kind}-fill`, 'fill-opacity', activeCategory.value === kind ? 0.36 : 0.2)
        if (map?.getLayer(`area-${kind}-outline`)) map.setPaintProperty(`area-${kind}-outline`, 'line-width', activeCategory.value === kind ? 3.5 : 2)
    }
    for (const kind of linearKinds) if (map?.getLayer(`linear-${kind}-line`)) map.setPaintProperty(`linear-${kind}-line`, 'line-width', activeCategory.value === kind ? 4.5 : 3)
}
watch(activeCategory, updateEmphasis)
function focusAddress() {
    if (props.selectable === false && props.analysis) { focusAnalysis(); return }
    const bounds = addressBounds(groups.value)
    if (bounds && map) {
        const [west, south, east, north] = bounds
        map.fitBounds([[west, south], [east, north]], { padding: mapPadding(), maxZoom: 16, duration: 500 })
    }
}
watch(groups, focusAddress, { flush: 'post' })
function focusPoint() {
    if (props.selectable !== false && props.point && map && !props.analysis && !groups.value.length) {
        const center: [number, number] = [props.point.lon, props.point.lat]
        if (!map.getBounds().contains(center)) map.jumpTo({ center, zoom: 14 })
    }
}
watch(() => props.point, focusPoint, { flush: 'post' })
function mapPadding() {
    return { top: 55, bottom: 55, left: 40, right: 40 }
}
let selectionSequence = 0
async function focusSelected() {
    const sequence = ++selectionSequence
    legendOpen.value = false
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (sequence !== selectionSequence || !map || !props.point || !props.analysis) return
    const coordinates: number[][] = [[props.point.lon, props.point.lat]]
    const collect = (value: unknown) => {
        if (!Array.isArray(value)) return
        if (typeof value[0] === 'number' && typeof value[1] === 'number') coordinates.push(value as number[])
        else value.forEach(collect)
    }
    if (selectedGeometry.value) collect(selectedGeometry.value.geometry.coordinates)
    else if (selectedStop.value) coordinates.push([selectedStop.value.lon, selectedStop.value.lat])
    else return
    map.resize()
    map.fitBounds([[Math.min(...coordinates.map(p => p[0]!)), Math.min(...coordinates.map(p => p[1]!))], [Math.max(...coordinates.map(p => p[0]!)), Math.max(...coordinates.map(p => p[1]!))]], { padding: { top: props.overlayControls && !props.hideTheme ? 108 : 55, bottom: 55, left: 40, right: 65 }, maxZoom: Math.min(16, props.selectionZoomLimit ?? 16), duration: props.sharedView === undefined ? 350 : 0 })
}
function focusAnalysis() {
    if (props.analysis && map) {
        const [west, south, east, north] = props.analysis.analysis_bounds
        map.fitBounds([[west, south], [east, north]], { padding: mapPadding(), maxZoom: 16, duration: props.sharedView === undefined ? 500 : 0 })
    }
}
watch(() => props.analysis, focusAnalysis, { flush: 'post' })
function wheel(event: WheelEvent) {
    // Address labels sit above the MapLibre container. Forward modified wheel
    // to its canvas so a caption does not create a dead zone for map zoom.
    if ((event.ctrlKey || event.metaKey) && map && event.target instanceof Element && event.target.closest('.map-address-labels')) {
        event.preventDefault()
        event.stopPropagation()
        map.getCanvas().dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true,
            clientX: event.clientX, clientY: event.clientY,
            deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
            ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
        }))
        return
    }
    scrollMapSidebar(event, props.scrollTarget)
}
function selectCenter() {
    const center = map?.getCenter()
    if (center) emit('select', { lon: center.lng, lat: center.lat })
}

const container = ref<HTMLDivElement | null>(null)
const status = ref<'loading' | 'ready' | 'error'>('loading')
const mapUnavailable = ref(false)
let map: Map | undefined
let tripOverlay: ReturnType<typeof createTripOverlay> | undefined
let observer: ResizeObserver | undefined
let controlsObserver: MutationObserver | undefined
let timeout: ReturnType<typeof setTimeout> | undefined
let failedResource = false
let mapLoaded = false
function beginLoading() {
    failedResource = false
    status.value = 'loading'
    clearTimeout(timeout)
    timeout = setTimeout(() => { if (status.value === 'loading') status.value = 'error' }, 15000)
}
function retryBasemap() {
    if (!map) { initialize(); return }
    // A full resource retry retains the serialized analytical sources/layers and
    // the existing camera. Normal theme changes never reload the style.
    const style = map.getStyle()
    beginLoading()
    map.setStyle(style, { diff: false })
}
watch(theme, value => {
    if (!map) return
    applyBasemapTheme(map, basemap as unknown as StyleSpecification, value)
})

function initialize() {
    if (!container.value) return
    selectionSequence++
    tripOverlay?.dispose()
    tripOverlay = undefined
    map?.remove()
    map = undefined
    mapUnavailable.value = false
    mapLoaded = false
    beginLoading()
    try {
        setWorkerUrl(workerUrl)
        map = new Map({
            container: container.value,
            style: themedBasemap({ ...basemap, sprite: new URL(basemap.sprite, window.location.href).href } as unknown as StyleSpecification, theme.value),
            center: [92.87, 56.01],
            zoom: 12.3,
            minZoom: 3,
            maxZoom: 18,
            cooperativeGestures: props.selectable === false,
            attributionControl: { compact: false },
            locale: {
                'NavigationControl.ZoomIn': 'Приблизить',
                'NavigationControl.ZoomOut': 'Отдалить',
                'NavigationControl.ResetBearing': 'Север сверху',
                'AttributionControl.ToggleAttribution': 'Источники карты',
                'Map.Title': 'Карта Красноярска',
                'CooperativeGesturesHandler.WindowsHelpText': 'Для масштаба карты удерживайте Ctrl и прокручивайте',
                'CooperativeGesturesHandler.MacHelpText': 'Для масштаба карты удерживайте ⌘ и прокручивайте',
                'CooperativeGesturesHandler.MobileHelpText': 'Перемещайте карту двумя пальцами',
            },
        })
        tripOverlay = createTripOverlay(map, {
            data: () => props.tripOverlay?.data ?? null,
            picking: () => !!props.tripPicking,
            select: point => emit('select', point),
            candidate: (key, point) => emit('roadCandidate', key, point),
        })
        map.on('click', (event) => {
            if (tripOverlay?.click(event)) return

            const stop = map?.getLayer('nearby-stops') ? map.queryRenderedFeatures(event.point, { layers: ['nearby-stops', 'selected-stop'] })[0] : undefined
            const address = map?.getLayer('address-contours') ? map.queryRenderedFeatures(event.point, { layers: ['address-contours', 'address-points'] })[0] : undefined
            if (stop) { selectedFeature.value = null; emit('selectStop', Number(stop.properties.id)); void focusSelected() }
            else if (address) emit('selectAddressObject', String(address.properties.id))
            else {
                for (const kind of [...linearKinds, ...areaKinds]) {
                    const id = kind === 'roads' || kind === 'railways' ? `linear-${kind}-line` : `area-${kind}-fill`
                    const object = map?.getLayer(id) ? map.queryRenderedFeatures(event.point, { layers: [id] })[0] : null
                    if (object) { selectFeature(kind, String(object.properties.id)); return }
                }
                if (props.selectable !== false) emit('select', { lon: event.lngLat.lng, lat: event.lngLat.lat })
            }
        })
        map.on('mousemove', event => {
            const object = map?.getLayer('address-contours') ? map.queryRenderedFeatures(event.point, { layers: ['address-contours', 'address-points'] })[0] : null
            emit('highlightAddressObject', object ? String(object.properties.id) : null)
        })
        map.on('mouseout', () => emit('highlightAddressObject', null))
        map.on('move', updateLabels)
        map.on('resize', updateLabels)
        map.on('style.load', () => {
            if (!map) return
            applyBasemapTheme(map, basemap as unknown as StyleSpecification, theme.value)
            if (mapLoaded && props.tripOverlay !== undefined) tripOverlay?.install()
            updateSelection(); updateAreaLayers(); updateLinearData(); updateLinearVisibility(); updateStopVisibility(); updateSelectedGeometry(); updateEmphasis()
        })
        map.on('load', () => {
            if (!map) return
            mapLoaded = true
            if (map.getSource('transport-selection')) { updateLabels(); return }
            map.addSource('transport-selection', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
            if (props.areaLayers !== undefined) {
                for (const kind of areaKinds) {
                    map.addSource(`area-${kind}`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
                    map.addLayer({ id: `area-${kind}-fill`, type: 'fill', source: `area-${kind}`, layout: { visibility: 'none' }, paint: { 'fill-color': areaColors[kind], 'fill-opacity': 0.2 } })
                    map.addLayer({ id: `area-${kind}-outline`, type: 'line', source: `area-${kind}`, layout: { visibility: 'none' }, paint: { 'line-color': areaColors[kind], 'line-width': 2, ...(kind === 'vegetation' ? { 'line-dasharray': [2, 2] } : {}) } })
                }
                updateAreaLayers()
            }
            map.addLayer({ id: 'analysis-area-fill', type: 'fill', source: 'transport-selection', filter: ['==', 'kind', 'area'], paint: { 'fill-color': '#2d6450', 'fill-opacity': 0.1 } })
            map.addLayer({ id: 'analysis-area-outline', type: 'line', source: 'transport-selection', filter: ['==', 'kind', 'area'], paint: { 'line-color': '#2d6450', 'line-width': 2, 'line-dasharray': [3, 2] } })
            if (props.linearLayers !== undefined) {
                for (const kind of linearKinds) {
                    map.addSource(`linear-${kind}`, { type: 'geojson', tolerance: 0, data: { type: 'FeatureCollection', features: [] } })
                    map.addLayer({ id: `linear-${kind}-casing`, type: 'line', source: `linear-${kind}`, layout: { visibility: 'none' }, paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9 } })
                    map.addLayer({ id: `linear-${kind}-line`, type: 'line', source: `linear-${kind}`, layout: { visibility: 'none' }, paint: { 'line-color': linearColors[kind], 'line-width': 3, ...(kind === 'railways' ? { 'line-dasharray': [4, 2] } : {}) } })
                }
                updateLinearData()
                updateLinearVisibility()
            }
            map.addLayer({ id: 'address-contours', type: 'fill', source: 'transport-selection', filter: ['all', ['==', 'kind', 'address-object'], ['==', '$type', 'Polygon']], paint: { 'fill-color': ['case', ['get', 'selected'], placeColor.value, ['get', 'highlighted'], '#d39a36', '#73849b'], 'fill-opacity': ['case', ['get', 'selected'], 0.5, ['get', 'highlighted'], 0.4, 0.18] } })
            map.addLayer({ id: 'address-outline-halo', type: 'line', source: 'transport-selection', filter: ['all', ['==', 'kind', 'address-object'], ['==', '$type', 'Polygon']], paint: { 'line-color': '#ffffff', 'line-width': ['case', ['get', 'selected'], 8, ['get', 'highlighted'], 7, 3] } })
            map.addLayer({ id: 'address-outlines', type: 'line', source: 'transport-selection', filter: ['all', ['==', 'kind', 'address-object'], ['==', '$type', 'Polygon']], paint: { 'line-color': ['case', ['get', 'selected'], placeColor.value, ['get', 'highlighted'], '#ae711c', '#64758a'], 'line-width': ['case', ['get', 'selected'], 4, ['get', 'highlighted'], 4, 1.5] } })
            map.addLayer({ id: 'address-points', type: 'circle', source: 'transport-selection', filter: ['all', ['==', 'kind', 'address-object'], ['==', '$type', 'Point']], paint: { 'circle-radius': ['case', ['get', 'selected'], 9, ['get', 'highlighted'], 8, 5], 'circle-color': ['case', ['get', 'selected'], placeColor.value, ['get', 'highlighted'], '#ae711c', '#64758a'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
            map.addLayer({ id: 'nearby-stops', type: 'circle', source: 'transport-selection', filter: ['==', 'kind', 'stop'], paint: { 'circle-radius': 5, 'circle-color': '#356494', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } })
            map.addLayer({ id: 'selected-stop', type: 'circle', source: 'transport-selection', filter: ['==', 'kind', 'selected-stop'], paint: { 'circle-radius': 9, 'circle-color': '#2d6450', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
            map.addLayer({ id: 'selected-point', type: 'circle', source: 'transport-selection', filter: ['==', 'kind', 'point'], paint: { 'circle-radius': 7, 'circle-color': placeColor.value, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } })
            map.addSource('analysis-object-selection', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
            map.addLayer({ id: 'analysis-object-fill', type: 'fill', source: 'analysis-object-selection', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#2d6450', 'fill-opacity': 0.2 } })
            map.addLayer({ id: 'analysis-object-halo', type: 'line', source: 'analysis-object-selection', paint: { 'line-color': '#ffffff', 'line-width': 8 } })
            map.addLayer({ id: 'analysis-object-outline', type: 'line', source: 'analysis-object-selection', paint: { 'line-color': '#2d6450', 'line-width': 4, 'line-dasharray': [2, 1] } })
            if (props.tripOverlay !== undefined) tripOverlay?.install()
            updateStopVisibility()
            updateSelection()
            if (props.focusRequest?.id) selectFeature(props.focusRequest.layer, props.focusRequest.id)
            updateSelectedGeometry()
            updateEmphasis()
            if (props.analysis) focusAnalysis()
            else { focusAddress(); focusPoint() }
            if (selectedStop.value || selectedGeometry.value) void focusSelected()
            updateLabels()
            if (props.tripOverlay) void focusTrip()
            const initialView = props.sharedView !== undefined ? cameraView() : null
            if (initialView) emit('viewReady', initialView)
            applySharedView()
        })
        map.on('moveend', () => {
            const view = props.sharedView !== undefined ? cameraView() : null
            if (!applyingView && view) emit('viewChange', view)
        })
        map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
        map.addControl(new ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left')
        map.on('error', (event) => {
            console.warn('Map resource failed:', event.error.message)
            failedResource = true
            status.value = 'error'
        })
        map.on('idle', () => {
            if (!failedResource && map?.areTilesLoaded()) {
                status.value = 'ready'
                clearTimeout(timeout)
            }
        })
    } catch {
        mapUnavailable.value = true
        status.value = 'error'
    }
}

onMounted(() => {
    initialize()
    observer = new ResizeObserver(() => map?.resize())
    if (container.value) {
        observer.observe(container.value)
        controlsObserver = new MutationObserver(() => { void nextTick(updateLabels) })
        const root = container.value.closest('.city-map')
        if (root) controlsObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'open'] })
    }
})
onBeforeUnmount(() => {
    selectionSequence++
    clearTimeout(timeout)
    observer?.disconnect()
    controlsObserver?.disconnect()
    tripOverlay?.dispose()
    tripOverlay = undefined
    map?.remove()
    map = undefined
})
</script>

<template>
    <div class="city-map" @wheel.capture="wheel" :class="{ 'city-map--overlay-controls': overlayControls }" :data-map-theme="theme" :style="{ '--place-color': placeColor }">
        <div class="city-map-toolbar">
            <MapThemeControl v-if="!hideTheme" />
            <slot name="controls" />
            <button v-if="selectable !== false" type="button" class="result-action city-map-center" @click="selectCenter">Анализировать центр карты</button>
        </div>
        <div v-if="status !== 'ready'" class="city-map-resource-status map-status" role="status" aria-live="polite">
            <template v-if="status === 'loading'"><span class="h-2 w-2 animate-pulse rounded-full bg-[#2d6450]" /> Загрузка подложки…</template>
            <template v-else><span>{{ mapUnavailable ? 'Карта недоступна в этом браузере.' : 'Подложка загружена не полностью. Анализ сохранён.' }}</span><button type="button" class="result-action" aria-label="Повторить загрузку подложки" @click="retryBasemap">Повторить</button></template>
        </div>
        <div class="city-map-surface">
            <button v-if="analysis && !placeLabel" type="button" class="result-action city-map-overview" @click="resetView">К радиусу {{ radius }} м</button>
            <p v-if="scrollTarget" class="city-map-wheel-hint">Колесо — прокрутка профиля · Ctrl/⌘ + колесо — масштаб</p>
            <div ref="container" class="h-full w-full" aria-label="Интерактивная карта Красноярска" />
            <AddressMapLabels :labels="labels" :selected-id="selectedAddressId" :highlighted-id="highlightedAddressId" :place-label="placeLabel" :multiple="(groups[0]?.objects.length ?? 0) > 1" @select="$emit('selectAddressObject', $event)" @highlight="$emit('highlightAddressObject', $event)" />
            <details class="city-map-legend" :open="legendOpen" @toggle="legendOpen = ($event.target as HTMLDetailsElement).open">
                <summary>Обозначения<span v-if="visibleLayers.length"> · {{ visibleLayers.length }}</span></summary>
                <div class="city-map-legend-body">
                    <p v-if="groups.length"><span class="map-key-house" />{{ placeLabel ? `Адрес ${placeLabel}` : selectedAddressId ? 'Выбранный объект' : 'Варианты адреса' }}<span v-if="!selectedAddressId"> · номера как в списке</span></p>
                    <p v-if="point && !groups.length"><span class="map-key-house" />Точка анализа</p>
                    <p v-if="point"><span class="map-key-radius" />Радиус {{ radius }} м по прямой</p>
                    <p v-for="layer in visibleLayers" :key="layer.key"><span class="layer-symbol" :class="`layer-symbol--${layer.symbol}`" :style="{ '--layer-color': layer.color }" />{{ layer.label }}</p>
                    <p v-if="selectedStop"><span class="map-key-stop" />Выбранная остановка</p>
                    <p v-if="selectedGeometry"><span class="map-key-selection" />Выбранный объект слоя</p>
                    <p class="city-map-legend-note">Контур не обозначает вход. Обозначения подложки — отдельная справочная карта.</p>
                </div>
            </details>
            <div v-if="!selectedStop && !selectedGeometry && activeCategory && visibleLayers.some(layer => layer.key === activeCategory)" class="city-map-active-category" role="status">{{ mapLayerDefinitions.find(layer => layer.key === activeCategory)?.label }} · в области анализа</div>
        </div>
        <div v-if="selectedStop || selectedGeometry" class="city-map-object" role="status" aria-live="polite" :data-selected-id="selectedGeometry ? selectedFeature?.id : selectedStop?.id">
            <span class="city-map-object-kind">{{ selectedGeometry ? mapLayerDefinitions.find(layer => layer.key === selectedFeature?.layer)?.label : 'Выбранная остановка' }} · слой включён</span>
            <strong>{{ selectedGeometry ? selectedFeature?.name : selectedStop?.name ?? 'Остановка без названия' }}</strong>
            <p>{{ placeLabel ? `От адреса ${placeLabel}` : selectedAddressId ? 'От выбранного адреса' : 'От точки анализа' }}: {{ selectionDistance }}</p>
            <p v-if="selectedGeometry">Показана часть {{ ['roads', 'railways'].includes(selectedFeature?.layer ?? '') ? 'линии' : 'контура' }} в круге анализа. Вход и доступ не подтверждены.</p>
            <button type="button" :aria-label="selectedGeometry ? 'Снять выделение объекта слоя' : 'Снять выделение остановки'" @click="closeSelection">×</button>
        </div>
    </div>
</template>
