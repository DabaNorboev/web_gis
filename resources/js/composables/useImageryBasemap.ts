import { ref, shallowRef } from 'vue'
import type { Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl'

const imageryBasemapLayer = 'pa-imagery-basemap'

const googleSatelliteTiles = 'https://mt1.google.com/vt/lyrs=s&hl=ru&x={x}&y={y}&z={z}'
const googleTiles = '/api/v1/basemap/imagery/{z}/{x}/{y}?style=satellite'

type Imagery = {
    provider: 'google_direct' | 'google'
    attribution: string
    maxZoom: number
    tileSize: number
    tiles: string
}

function viewport(instance: MapLibreMap) {
    const bounds = instance.getBounds()
    const west = bounds.getWest(), east = bounds.getEast()
    const wrap = (longitude: number) => ((longitude + 180) % 360 + 360) % 360 - 180
    const clampLat = (latitude: number) => Math.max(-85.051129, Math.min(85.051129, latitude))
    return {
        west: east - west >= 360 ? -180 : wrap(west),
        east: east - west >= 360 ? 180 : wrap(east),
        north: clampLat(bounds.getNorth()),
        south: clampLat(bounds.getSouth()),
        zoom: Math.max(0, Math.min(22, Math.floor(instance.getZoom()))),
    }
}

async function loadImagery(instance: MapLibreMap, signal: AbortSignal): Promise<Imagery> {
    const result = await fetch('/api/v1/basemap/imagery/viewport', {
        method: 'POST', signal, cache: 'no-store',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(viewport(instance)),
    })
    if (!result.ok) throw new Error('Imagery metadata unavailable')
    const data = await result.json()
    if (data?.provider === 'google_direct') {
        return {
            provider: 'google_direct', tiles: googleSatelliteTiles, maxZoom: 21, tileSize: 256,
            attribution: '© Google',
        }
    }
    if (data?.provider === 'google' && typeof data.attribution === 'string' && data.attribution.trim()
        && Number.isInteger(data.max_zoom) && data.max_zoom >= 0 && data.max_zoom <= 22
        && [256, 512].includes(data.tile_size)) {
        return {
            provider: 'google', tiles: googleTiles, maxZoom: data.max_zoom,
            tileSize: data.tile_size, attribution: data.attribution,
        }
    }
    throw new Error('Invalid imagery metadata')
}

export function useImageryBasemap(options: {
    map: () => MapLibreMap | null
    replacedBaseLayers: () => string[]
    beforeLayer: (instance: MapLibreMap) => string | undefined
}) {
    const mode = ref<'map' | 'loading' | 'satellite'>('map')
    const imagery = shallowRef<Imagery | null>(null)
    const error = ref(false)
    let sourceId: string | null = null
    let sourceGeneration = 0
    let currentRequest: AbortController | null = null
    let firstTileTimer: ReturnType<typeof setTimeout> | undefined
    let moveTimer: ReturnType<typeof setTimeout> | undefined
    const baseVisibility = new Map<string, 'none' | 'visible'>()

    function removeRaster(instance: MapLibreMap) {
        if (instance.getLayer(imageryBasemapLayer)) instance.removeLayer(imageryBasemapLayer)
        if (sourceId && instance.getSource(sourceId)) instance.removeSource(sourceId)
        sourceId = null
    }

    function restoreMap(failed = false) {
        clearTimeout(firstTileTimer)
        clearTimeout(moveTimer)
        currentRequest?.abort()
        currentRequest = null
        const instance = options.map()
        if (instance) {
            removeRaster(instance)
            for (const [id, visibility] of baseVisibility) {
                if (instance.getLayer(id)) instance.setLayoutProperty(id, 'visibility', visibility)
            }
        }
        baseVisibility.clear()
        imagery.value = null
        mode.value = 'map'
        error.value = failed
    }

    async function refresh() {
        const instance = options.map()
        if (!instance || mode.value === 'map') return

        currentRequest?.abort()
        const controller = new AbortController()
        currentRequest = controller
        try {
            const next = await loadImagery(instance, AbortSignal.any([controller.signal, AbortSignal.timeout(11_000)]))
            if (currentRequest !== controller) return
            const previous = imagery.value
            imagery.value = next
            if (sourceId && previous?.maxZoom === next.maxZoom && previous.tileSize === next.tileSize && previous.tiles === next.tiles) return

            removeRaster(instance)
            sourceId = `${imageryBasemapLayer}-${++sourceGeneration}`
            instance.addSource(sourceId, { type: 'raster', tiles: [next.tiles], tileSize: next.tileSize, maxzoom: next.maxZoom })
            instance.addLayer({
                id: imageryBasemapLayer, type: 'raster', source: sourceId,
                paint: {
                    'raster-opacity': mode.value === 'satellite' ? 1 : 0,
                    'raster-opacity-transition': { duration: 0 },
                    'raster-fade-duration': 0,
                },
            }, options.beforeLayer(instance))
            clearTimeout(firstTileTimer)
            firstTileTimer = setTimeout(() => restoreMap(true), 8000)
        } catch {
            if (currentRequest === controller) restoreMap(true)
        } finally {
            if (currentRequest === controller) currentRequest = null
        }
    }

    function select(enabled: boolean) {
        if (!enabled) {
            if (mode.value !== 'map' || error.value) restoreMap()
            return
        }
        if (!options.map() || mode.value !== 'map') return
        mode.value = 'loading'
        error.value = false
        void refresh()
    }

    function onSourceData(event: MapSourceDataEvent) {
        const instance = options.map()
        if (!instance || !sourceId || sourceId !== event.sourceId || !event.tile?.hasData()) return

        clearTimeout(firstTileTimer)
        if (mode.value !== 'loading') return
        for (const id of options.replacedBaseLayers()) {
            if (!instance.getLayer(id)) continue
            const visibility = instance.getLayoutProperty(id, 'visibility') === 'none' ? 'none' : 'visible'
            baseVisibility.set(id, visibility)
            if (visibility === 'visible') instance.setLayoutProperty(id, 'visibility', 'none')
        }
        instance.setPaintProperty(imageryBasemapLayer, 'raster-opacity', 1)
        mode.value = 'satellite'
    }

    function onMoveEnd() {
        if (mode.value === 'map' || imagery.value?.provider === 'google_direct') return
        clearTimeout(moveTimer)
        moveTimer = setTimeout(() => void refresh(), 250)
    }

    return { mode, imagery, error, select, onSourceData, onMoveEnd, dispose: restoreMap }
}
