<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Map, NavigationControl, ScaleControl, setWorkerUrl, type StyleSpecification, type GeoJSONSource } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import basemap from '@/maps/basemap.json'
import type { FeatureCollection } from 'geojson'
import type { Coordinates, TransportAnalysis } from '@/types/transport'

const props = defineProps<{ point: Coordinates | null; analysis: TransportAnalysis | null }>()
const emit = defineEmits<{ select: [point: Coordinates] }>()
function updateSelection() {
    const source = map?.getSource('transport-selection') as GeoJSONSource | undefined
    if (!source) return
    const data: FeatureCollection = { type: 'FeatureCollection', features: [] }
    if (props.point) data.features.push({ type: 'Feature', properties: { kind: 'point' }, geometry: { type: 'Point', coordinates: [props.point.lon, props.point.lat] } })
    if (props.analysis) {
        data.features.push({ type: 'Feature', properties: { kind: 'area' }, geometry: props.analysis.analysis_area })
        const stop = props.analysis.nearest_stop
        if (stop) data.features.push({ type: 'Feature', properties: { kind: 'stop' }, geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] } })
    }
    source.setData(data)
}
watch(() => [props.point, props.analysis], updateSelection)
function selectCenter() {
    const center = map?.getCenter()
    if (center) emit('select', { lon: center.lng, lat: center.lat })
}

const container = ref<HTMLDivElement | null>(null)
const status = ref<'loading' | 'ready' | 'error'>('loading')
let map: Map | undefined
let observer: ResizeObserver | undefined
let timeout: ReturnType<typeof setTimeout> | undefined

function initialize() {
    if (!container.value) return
    map?.remove()
    status.value = 'loading'
    clearTimeout(timeout)
    try {
        setWorkerUrl(workerUrl)
        map = new Map({
            container: container.value,
            style: basemap as unknown as StyleSpecification,
            center: [92.87, 56.01],
            zoom: 12.3,
            minZoom: 3,
            maxZoom: 18,
            attributionControl: { compact: false },
            locale: {
                'NavigationControl.ZoomIn': 'Приблизить',
                'NavigationControl.ZoomOut': 'Отдалить',
                'NavigationControl.ResetBearing': 'Север сверху',
                'AttributionControl.ToggleAttribution': 'Источники карты',
                'Map.Title': 'Карта Красноярска',
            },
        })
        map.on('click', (event) => emit('select', { lon: event.lngLat.lng, lat: event.lngLat.lat }))
        map.on('load', () => {
            if (!map) return
            map.addSource('transport-selection', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
            map.addLayer({ id: 'analysis-area-fill', type: 'fill', source: 'transport-selection', filter: ['==', 'kind', 'area'], paint: { 'fill-color': '#2d6450', 'fill-opacity': 0.1 } })
            map.addLayer({ id: 'analysis-area-outline', type: 'line', source: 'transport-selection', filter: ['==', 'kind', 'area'], paint: { 'line-color': '#2d6450', 'line-width': 2, 'line-dasharray': [3, 2] } })
            map.addLayer({ id: 'nearest-stop', type: 'circle', source: 'transport-selection', filter: ['==', 'kind', 'stop'], paint: { 'circle-radius': 7, 'circle-color': '#c27630', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
            map.addLayer({ id: 'selected-point', type: 'circle', source: 'transport-selection', filter: ['==', 'kind', 'point'], paint: { 'circle-radius': 7, 'circle-color': '#2d6450', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } })
            updateSelection()
        })
        map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
        map.addControl(new ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left')
        map.on('error', () => { status.value = 'error' })
        map.on('idle', () => {
            if (map?.areTilesLoaded()) {
                status.value = 'ready'
                clearTimeout(timeout)
            }
        })
        timeout = setTimeout(() => {
            if (status.value === 'loading') status.value = 'error'
        }, 15000)
    } catch {
        status.value = 'error'
    }
}

onMounted(() => {
    initialize()
    observer = new ResizeObserver(() => map?.resize())
    if (container.value) observer.observe(container.value)
})
onBeforeUnmount(() => {
    clearTimeout(timeout)
    observer?.disconnect()
    map?.remove()
})
</script>

<template>
    <div class="absolute inset-0 bg-[#edf0e9]">
        <div ref="container" class="h-full w-full" aria-label="Интерактивная карта Красноярска" />
        <div class="map-selection-tools">
            <button type="button" class="result-action" @click="selectCenter">Анализировать центр карты</button>
            <div v-if="point" class="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#637769]">
                <span><span class="inline-block size-2 rounded-full bg-[#2d6450]" /> Выбранная точка · 500 м</span>
                <span v-if="analysis?.nearest_stop"><span class="inline-block size-2 rounded-full bg-[#c27630]" /> Ближайшая остановка</span>
            </div>
        </div>
        <div v-if="status !== 'ready'" class="map-status" role="status" aria-live="polite">
            <template v-if="status === 'loading'">
                <span class="h-2 w-2 animate-pulse rounded-full bg-[#2d6450]" /> Загрузка карты…
            </template>
            <template v-else>
                <span>Не удалось загрузить карту. Проверьте подключение.</span>
                <button type="button" class="font-semibold text-[#2d6450] underline underline-offset-4" @click="initialize">Повторить</button>
            </template>
        </div>
    </div>
</template>
