<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Map, NavigationControl, ScaleControl, setWorkerUrl, type StyleSpecification } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import basemap from '@/maps/basemap.json'

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
