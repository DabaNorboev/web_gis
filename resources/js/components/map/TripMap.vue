<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Map as LibreMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { installTripLayers, tripMapData, type TripMapPoint } from '@/utils/tripMap'
import { candidateId, sameRoadPoint, candidateMarkerOffsets, type TripCandidateGroup } from '@/utils/tripCandidates'
import type { TripRoadCandidate } from '@/types/trips'
import type { Coordinates } from '@/types/transport'
import type { TripAnalysis } from '@/types/trips'
import MapThemeControl from '@/components/map/MapThemeControl.vue'
import { useMapTheme } from '@/composables/useMapTheme'
import { applyBasemapTheme } from '@/utils/mapTheme'
import basemap from '@/maps/basemap.json'
import 'maplibre-gl/dist/maplibre-gl.css'

const props = defineProps<{ points: TripMapPoint[]; analysis: TripAnalysis | null; activeLabel: string; candidateGroups: TripCandidateGroup[]; highlightedCandidate: string | null }>()
const emit = defineEmits<{ select: [point: Coordinates]; candidate: [key: string, point: Coordinates]; 'candidate-focus': [id: string | null, source: 'pointer' | 'focus'] }>()
const container = ref<HTMLDivElement | null>(null)
const failed = ref(false)
let map: LibreMap | undefined
const { theme } = useMapTheme()
watch(theme, value => { if (map?.getSource('trips')) applyBasemapTheme(map, basemap as unknown as StyleSpecification, value) })
interface CandidateMarker { marker: Marker; button: HTMLButtonElement; line: SVGLineElement; group: TripCandidateGroup; candidate: TripRoadCandidate }
const candidateMarkers = new Map<string, CandidateMarker>()
function clearCandidateMarkers() { for (const entry of candidateMarkers.values()) entry.marker.remove(); candidateMarkers.clear() }
function layoutCandidateMarkers() {
    if (!map) return
    const entries = [...candidateMarkers.values()]
    const pixels = entries.map(e => map!.project([e.candidate.point.lon, e.candidate.point.lat]))
    const offsets = candidateMarkerOffsets(pixels, props.points.map(p => map!.project([p.point.lon, p.point.lat])))
    entries.forEach((entry, i) => {
        const [dx, dy] = offsets[i]!
        entry.button.style.transform = `translate(${dx}px,${dy}px)`
        entry.line.setAttribute('x2', String(dx)); entry.line.setAttribute('y2', String(dy))
    })
}
function updateCandidateMarkers() {
    if (!map?.getSource('trips')) return
    const present = new Set<string>()
    for (const group of props.candidateGroups) group.candidates.forEach((candidate, index) => {
        const id = candidateId(group.key, index); present.add(id)
        let entry = candidateMarkers.get(id)
        if (!entry) {
            const element = document.createElement('div'); element.className = 'trip-candidate-anchor'
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', '1'); svg.setAttribute('height', '1')
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.setAttribute('x1', '0'); line.setAttribute('y1', '0'); svg.append(line)
            const button = document.createElement('button'); button.type = 'button'; button.className = 'trip-candidate-marker'; button.dataset.candidateMapId = id
            element.append(svg, button)
            entry = { marker: new Marker({ element, anchor: 'center' }).setLngLat([candidate.point.lon, candidate.point.lat]).addTo(map!), button, line, group, candidate }
            const current = entry
            button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); emit('candidate', current.group.key, current.candidate.point) })
            button.addEventListener('mouseenter', () => emit('candidate-focus', id, 'pointer'))
            button.addEventListener('mouseleave', () => emit('candidate-focus', null, 'pointer'))
            button.addEventListener('focus', () => emit('candidate-focus', id, 'focus'))
            button.addEventListener('blur', () => emit('candidate-focus', null, 'focus'))
            candidateMarkers.set(id, entry)
        }
        entry.group = group; entry.candidate = candidate
        entry.marker.setLngLat([candidate.point.lon, candidate.point.lat])
        const selected = sameRoadPoint(group.selected, candidate.point)
        entry.button.textContent = selected ? `${group.label} ✓` : `${group.label} · Вариант ${index + 1}`
        entry.button.setAttribute('aria-pressed', String(selected))
        entry.button.setAttribute('aria-label', `${group.label}, вариант ${index + 1}, ${Math.round(candidate.distance_m * 10) / 10} м от исходной точки${candidate.name ? ', ' + candidate.name : ''}${selected ? ', выбран' : ''}`)
        entry.button.classList.toggle('is-selected', selected)
        entry.button.classList.toggle('is-highlighted', props.highlightedCandidate === id)
        entry.button.title = entry.button.getAttribute('aria-label')!
    })
    for (const [id, entry] of candidateMarkers) if (!present.has(id)) { entry.marker.remove(); candidateMarkers.delete(id) }
    layoutCandidateMarkers()
}
let observer: ResizeObserver | undefined
let timeout: ReturnType<typeof setTimeout> | undefined
function data() { return tripMapData(props.points, props.analysis, props.candidateGroups) }
function update() { (map?.getSource('trips') as GeoJSONSource | undefined)?.setData(data()); updateCandidateMarkers() }
function fit() {
    if (!map || !props.points.length) return
    // Fit camera padding to the available canvas; fixed padding can consume
    // almost the entire map on a short screen. Coordinates and routes stay intact.
    const routePadding = Math.min(55, Math.max(16, Math.floor(map.getContainer().clientHeight / 7)))
    const choicePadding = Math.min(65, Math.max(24, Math.floor(map.getContainer().clientHeight / 4)))
    const candidateFeatures = data().features.filter(f => f.properties?.kind === 'candidate')
    const firstKey = props.candidateGroups.find(g => !g.selected)?.key
    if (firstKey) {
        const origin = props.points.find(p => p.key === firstKey)?.point
        const coords = candidateFeatures.filter(f => f.properties?.key === firstKey && f.geometry.type === 'Point').map(f => f.geometry.type === 'Point' ? f.geometry.coordinates : [])
        if (origin) coords.push([origin.lon, origin.lat])
        map.fitBounds([[Math.min(...coords.map(p => p[0]!)), Math.min(...coords.map(p => p[1]!))], [Math.max(...coords.map(p => p[0]!)), Math.max(...coords.map(p => p[1]!))]], { padding: choicePadding, maxZoom: 18, duration: 0 })
        return
    }
    const points = props.points.map(p => [p.point.lon, p.point.lat])
    for (const row of props.analysis?.results ?? []) if (row.status === 'AVAILABLE' && row.route) points.push(...row.route.geometry.coordinates)
    map.fitBounds([[Math.min(...points.map(p => p[0]!)), Math.min(...points.map(p => p[1]!))], [Math.max(...points.map(p => p[0]!)), Math.max(...points.map(p => p[1]!))]], { padding: routePadding, maxZoom: 18, duration: 0 })
}
watch(() => props.points, () => { update(); if (props.points.some(p => !map?.getBounds().contains([p.point.lon, p.point.lat]))) fit() }, { deep: true })
watch(() => props.analysis, () => { update(); if (props.analysis) fit() })
watch(() => props.candidateGroups, update, { deep: true })
watch(() => props.highlightedCandidate, updateCandidateMarkers)
function focusPoint(key: string) {
    const point = props.points.find(p => p.key === key)
    if (point && map) map.jumpTo({ center: [point.point.lon, point.point.lat], zoom: 18 })
}
defineExpose({ focusPoint })
function center() { const value = map?.getCenter(); if (value) emit('select', { lon: value.lng, lat: value.lat }) }
function initialize() {
    if (!container.value) return
    clearCandidateMarkers()
    map?.remove()
    observer?.disconnect()
    clearTimeout(timeout)
    failed.value = false
    setWorkerUrl(workerUrl)
    try {
        map = new LibreMap({ container: container.value, style: { ...basemap, sprite: new URL(basemap.sprite, window.location.origin).href } as unknown as StyleSpecification,
            center: [92.87, 56.01], zoom: 12, maxZoom: 18, cooperativeGestures: true, attributionControl: { compact: false },
            locale: { 'NavigationControl.ZoomIn': 'Приблизить', 'NavigationControl.ZoomOut': 'Отдалить', 'Map.Title': 'Карта поездок в Красноярске',
                'CooperativeGesturesHandler.WindowsHelpText': 'Для масштаба карты удерживайте Ctrl и прокручивайте',
                'CooperativeGesturesHandler.MacHelpText': 'Для масштаба карты удерживайте ⌘ и прокручивайте',
                'CooperativeGesturesHandler.MobileHelpText': 'Перемещайте карту двумя пальцами' } })
        map.on('click', event => emit('select', { lon: event.lngLat.lng, lat: event.lngLat.lat }))
        map.on('move', layoutCandidateMarkers)
        map.on('load', () => {
            clearTimeout(timeout)
            if (!map) return
            installTripLayers(map, data())
            applyBasemapTheme(map, basemap as unknown as StyleSpecification, theme.value)
            updateCandidateMarkers()
            fit()
        })
        map.on('error', () => { if (!map?.loaded()) failed.value = true })
        map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
        observer = new ResizeObserver(() => { map?.resize(); if (props.analysis) fit() })
        observer.observe(container.value)
        timeout = setTimeout(() => { if (!map?.loaded()) failed.value = true }, 15000)
    } catch { failed.value = true }
}
onMounted(initialize)
onBeforeUnmount(() => { clearTimeout(timeout); observer?.disconnect(); clearCandidateMarkers(); map?.remove() })
</script>

<template>
    <MapThemeControl />
    <div class="trip-map-controls"><p aria-live="polite">Выбираете: <strong>{{ activeLabel }}</strong></p><button type="button" @click="center">Выбрать центр карты</button></div>
    <div ref="container" class="trip-map-canvas" aria-describedby="trip-map-help" aria-label="Карта выбора старта и важных мест" />
    <div v-if="failed" class="trip-map-error" role="status">Подложка карты не загрузилась. Поиск адреса и локальный расчёт доступны. <button type="button" @click="initialize">Повторить карту</button></div>
    <slot name="after-map" />
    <details class="trip-map-legend"><summary>Обозначения карты</summary><p>Старт и места — исходные точки. Белые точки — проверенные дорожные привязки; пунктир — соединитель, не маршрут. Варианты дороги выбираются явно. Серые точки из ссылки ожидают проверки.</p></details>
</template>

<style scoped>
.trip-map-canvas{height:490px;border:1px solid #dce5da;border-radius:14px;overflow:hidden}.trip-map-controls{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;font-size:13px}.trip-map-controls p{margin:0}.trip-map-controls button,.trip-map-error button{min-height:40px;padding:8px 10px;border:1px solid #cbdace;border-radius:8px;background:#fcfdf9;color:#2d6450}.trip-map-legend{font-size:12px;line-height:1.6;color:#607366;margin:10px 0}.trip-map-error{font-size:13px;padding:12px;background:#fff2d8;border-radius:10px;margin-top:10px}@media(max-width:900px){.trip-map-canvas{height:clamp(240px,38dvh,340px)}.trip-map-controls{flex-wrap:wrap}}:deep(.maplibregl-canvas:focus-visible){outline:3px solid #2d6450;outline-offset:-3px}

:deep(.trip-candidate-anchor){width:40px;height:40px}
:deep(.trip-candidate-anchor::before){content:'';position:absolute;left:17px;top:17px;width:6px;height:6px;border-radius:50%;background:#815c27;border:1px solid white}
:deep(.trip-candidate-anchor svg){position:absolute;left:20px;top:20px;overflow:visible;pointer-events:none}
:deep(.trip-candidate-anchor line){stroke:#6c776d;stroke-width:1.5}
:deep(.trip-candidate-marker){position:absolute;left:-32px;top:0;width:104px;min-height:44px;border-radius:8px;border:2px solid #835b23;background:#fff1c9;color:#513b17;font-size:11px;font-weight:700;cursor:pointer;padding:3px}
:deep(.trip-candidate-marker.is-highlighted),:deep(.trip-candidate-marker:focus-visible){outline:3px solid #397b9d;outline-offset:3px;background:#eaf5fb}
:deep(.trip-candidate-marker.is-selected){width:80px;left:-20px;background:#247056;border-color:white;color:white;box-shadow:0 0 0 2px #247056}
</style>
