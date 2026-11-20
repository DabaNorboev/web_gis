<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Component } from 'vue'
import {
    BusFront, Camera, ChevronDown, ChevronRight, ChevronUp, CircleDashed, Layers, LayoutDashboard,
    Leaf, Map as MapIcon, MapPin, Palette, Pill, RadioTower, RotateCw, Satellite, Search,
    ShoppingBasket, Trees, TriangleAlert, Wind, X,
} from '@lucide/vue'
import MapThemeControl from '@/components/map/MapThemeControl.vue'
import PlaceAnalysisMap from '@/components/place-analysis/PlaceAnalysisMap.vue'
import { categoryMeta, categoryOrder, type AnalysisLayer, type AnalysisTab, type PlaceSelection, type AnalysisPoint, type PoiCategory, type SatelliteMode } from '@/place-analysis'
import GeocodingSearch from '@/components/place-analysis/GeocodingSearch.vue'
import type { GeocodingSelection } from '@/types/geocoding'
import PlaceAnalysisResults from '@/components/place-analysis/PlaceAnalysisResults.vue'
import { usePlaceAnalysis } from '@/composables/usePlaceAnalysis'
import type {
    AnalysisBlockKey, PlaceAnalysisInput, PlaceAnalysisResponse, SatelliteData, SatelliteRasterSource,
} from '@/types/placeAnalysis'
import { satelliteLayerLabel } from '@/utils/satellite'
import '../../css/place-analysis.css'

const analysis = usePlaceAnalysis()
const hasSelection = ref(false)
const displayedGeometry = shallowRef<PlaceAnalysisResponse | null>(null)
const geometryStale = computed(() => !!displayedGeometry.value && !analysis.map.value)
let radiusTimer: ReturnType<typeof setTimeout> | null = null
const realDate = ref('')
const stationRadius = ref(5000)
const selectedStationIds = ref<string[]>([])
const geocodingRef = ref<{ clearSelection: () => void; clearDraft: () => void } | null>(null)
const geocodingSelection = shallowRef<GeocodingSelection | null>(null)
const geocodingAuthorizationExpired = ref(false)
const geocodingPreview = shallowRef<AnalysisPoint | null>(null)
const selectionError = computed(() => Object.values(analysis.blocks).find(b => ['SELECTION_EXPIRED', 'SNAPSHOT_EXPIRED'].includes(b.error?.code ?? ''))?.error?.code ?? null)
function acceptGeocodingSelection(value: GeocodingSelection) {
    const same = geocodingSelection.value?.selection_id === value.selection_id
    geocodingAuthorizationExpired.value = false
    geocodingSelection.value = value
    if (same) {
        const retry = (['poi', 'satellite', 'air'] as const).filter(key => analysis.blocks[key].phase === 'loading' || analysis.blocks[key].error?.code === 'SELECTION_EXPIRED')
        syncInput()
        for (const key of retry) void analysis.load(key)
        return
    }
    place.value = { id: value.selection_id, label: value.place.label, ...value.place.point }
    hasSelection.value = true; pendingPoint.value = null; pickMode.value = false
    runAnalysis()
}
const realPoi = computed(() => analysis.blocks.poi.response?.blocks.poi)
const satelliteCatalog = shallowRef<SatelliteData | null>(null)
const satelliteData = computed<SatelliteData | null>(() => {
    const block = analysis.blocks.satellite.response?.blocks.satellite
    return block?.status === 'READY' ? block.data : null
})
const satelliteSelected = computed(() => satelliteData.value?.selected ?? null)
const satelliteLayers = computed<Partial<Record<'true-color' | 'ndvi', SatelliteRasterSource>> | null>(() => satelliteSelected.value?.layers ?? null)
const satelliteCatalogData = computed(() => satelliteData.value ?? satelliteCatalog.value)
const satelliteLegend = computed(() => satelliteCatalogData.value?.legend ?? null)
const realStations = computed(() => {
    const block = analysis.blocks.air.response?.blocks.air
    return block?.status === 'READY' ? block.data.stations.map((s, i) => ({ ...s, number: i + 1, distance_km: s.distance_m / 1000 })) : []
})
const mapCenter = computed(() => displayedGeometry.value ? displayedGeometry.value.place.point : place.value)
const realMapPois = computed(() => realPoi.value?.status === 'READY' ? realPoi.value.data.items.map(p => ({
    id: p.id, category: p.category, name: p.name ?? 'Без названия', ...p.point, distance_m: p.distance_m, geometry: p.geometry,
})) : [])
function retireGeocodingSelection() {
    if (geocodingSelection.value) geocodingSelection.value = { ...geocodingSelection.value, selection_token: '' }
    analysis.retireSelection()
}
function syncInput() {
    if (geocodingSelection.value && !geocodingSelection.value.selection_token) return
    const valid = hasSelection.value && Number.isInteger(radius.value) && radius.value >= 200 && radius.value <= 1000
        && Number.isInteger(stationRadius.value) && stationRadius.value >= 1000 && stationRadius.value <= 20000
    const input: PlaceAnalysisInput | null = !valid ? null : {
        ...(geocodingSelection.value ? { analysis_version: 2 as const, expected_place: geocodingSelection.value.place } : {}),
        place: geocodingSelection.value ? { kind: 'address', selection_token: geocodingSelection.value.selection_token } : place.value.id ? { kind: 'address', address_id: place.value.id } : { kind: 'point', lon: place.value.lon, lat: place.value.lat },
        radius_m: radius.value, ...(realDate.value ? { date: realDate.value } : {}),
        stations: { selected_ids: selectedStationIds.value, radius_m: stationRadius.value },
    }
    analysis.setInput(input)
}
function runAnalysis() {
    if (geocodingSelection.value && (!geocodingSelection.value.selection_token || geocodingAuthorizationExpired.value)) return
    if (radiusTimer) { clearTimeout(radiusTimer); radiusTimer = null }
    syncInput(); void analysis.loadAll()
}
function setStationRadius(value: number) {
    stationRadius.value = Number.isInteger(value) ? Math.max(1000, Math.min(20000, value)) : 5000
}
function loadBlock(key: AnalysisBlockKey) { syncInput(); void analysis.load(key) }
function chooseSatelliteDate(value: string) {
    if (value !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return
    if (realDate.value === value) return
    // The watcher on realDate updates the request synchronously; only satellite is invalidated/loaded.
    realDate.value = value
    if (analysis.input.value) void analysis.load('satellite')
}


const tabOrder: AnalysisTab[] = ['overview', 'objects', 'satellite', 'air']
const activeTab = ref<AnalysisTab>('overview')
const place = ref<PlaceSelection>({ id: null, label: 'Выберите место', lon: 92.85, lat: 56.01 })
const radius = ref(500)
const pendingPoint = ref<AnalysisPoint | null>(null)
const pickMode = ref(false)
const referencePoint = computed(() => pendingPoint.value
    ?? (hasSelection.value && !place.value.id ? { lon: place.value.lon, lat: place.value.lat } : null))
const activeCategory = ref<PoiCategory | 'all'>('grocery')
const selectedPoiId = ref<string | null>(null)
const selectedStationId = ref<string | null>(null)
const stationFocusRequest = ref(0)
const satelliteMode = ref<SatelliteMode>('ndvi')
const satelliteOpacity = ref(0.7)
const showObjects = ref(true)
const showSatellite = ref(true)
const showStations = ref(true)
const showRadius = ref(true)
const layersOpen = ref(true)
const ndviLegendOpen = ref(true)
const ndviLegendVisible = computed(() => showSatellite.value && satelliteOpacity.value > 0
    && satelliteMode.value === 'ndvi' && satelliteSelected.value?.status === 'READY'
    && !!satelliteLayers.value?.ndvi && !!satelliteLegend.value)
const objectList = ref<HTMLElement | null>(null)
const mapRef = ref<{ focusMap: () => void } | null>(null)
const placeButton = ref<HTMLButtonElement | null>(null)
const analyzeButton = ref<HTMLButtonElement | null>(null)
const satelliteScope = ref<'territory' | 'circle'>('territory')
const layerOrder = ref<AnalysisLayer[]>(['objects', 'stations', 'radius', 'satellite'])

const mapPois = realMapPois
const tabLabels: Record<AnalysisTab, string> = {
    overview: 'Обзор', objects: 'Объекты', satellite: 'Спутник', air: 'Воздух',
}
const tabIcons: Record<AnalysisTab, Component> = {
    overview: LayoutDashboard, objects: MapPin, satellite: Satellite, air: Wind,
}
const categoryIcons: Record<PoiCategory, Component> = {
    grocery: ShoppingBasket, pharmacy: Pill, official_stop: BusFront, park: Trees,
}
const layerIcons: Record<AnalysisLayer, Component> = {
    objects: MapPin, satellite: Satellite, stations: RadioTower, radius: CircleDashed,
}
function layerLabel(key: AnalysisLayer) {
    if (key === 'objects') return 'Объекты (POI)'
    if (key === 'satellite') return satelliteLayerLabel(mapSatelliteMode.value, satelliteData.value)
    if (key === 'stations') return 'Станции мониторинга'
    return `Радиус анализа (${radius.value} м)`
}
function moveLayer(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= layerOrder.value.length) return
    const next = [...layerOrder.value]
    const [item] = next.splice(index, 1)
    if (!item) return
    next.splice(target, 0, item)
    layerOrder.value = next
}
watch(realMapPois, () => { selectedPoiId.value = null })
watch(analysis.map, value => { if (value) displayedGeometry.value = value }, { flush: 'sync' })
watch(satelliteData, value => { if (value) satelliteCatalog.value = value }, { flush: 'sync' })
watch(place, () => { displayedGeometry.value = null; satelliteCatalog.value = null }, { flush: 'sync' })
watch(() => Object.values(analysis.blocks).some(block => block.error?.code === 'ADDRESS_POINT_CHANGED'), changed => {
    if (changed) displayedGeometry.value = null
}, { flush: 'sync' })
watch([place, radius, realDate, stationRadius, selectedStationIds, hasSelection], syncInput, { deep: true, flush: 'sync' })
watch(radius, () => {
    satelliteCatalog.value = null
    if (radiusTimer) clearTimeout(radiusTimer)
    if (hasSelection.value) radiusTimer = setTimeout(() => {
        radiusTimer = null
        if (analysis.input.value) void analysis.loadAll()
    }, 350)
}, { flush: 'sync' })
watch(showObjects, value => { if (!value) selectedPoiId.value = null })
const mapSatelliteMode = computed<SatelliteMode>(() => satelliteMode.value)
const mapShowObjects = computed(() => showObjects.value)
const mapShowStations = computed(() => showStations.value)
const mapCategoryFilter = computed<PoiCategory | null>(() => activeTab.value === 'objects' && activeCategory.value !== 'all' ? activeCategory.value : null)

function selectTab(tab: AnalysisTab) {
    if (!hasSelection.value) return
    // Tabs change the analytical content only; layer choices belong to the user
    // and survive tab switches until the page is reloaded.
    activeTab.value = tab
}

function openAnalysisTab(key: AnalysisBlockKey) {
    const tab = key === 'poi' ? 'objects' : key
    selectTab(tab)
    void nextTick(() => document.getElementById(`pa-tab-${tab}`)?.focus())
}

function tabKey(event: KeyboardEvent) {
    if (!hasSelection.value) return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = tabOrder.indexOf(activeTab.value)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabOrder.length - 1
        : event.key === 'ArrowLeft' ? (index - 1 + tabOrder.length) % tabOrder.length
            : (index + 1) % tabOrder.length
    const tab = tabOrder[next]!
    selectTab(tab)
    void nextTick(() => document.getElementById(`pa-tab-${tab}`)?.focus())
}

function normalizeRadius() {
    const value = Number(radius.value)
    radius.value = Number.isFinite(value) ? Math.min(1000, Math.max(200, Math.round(value))) : 500
}

function selectCategory(category: PoiCategory | 'all') {
    activeCategory.value = category
    selectedPoiId.value = null
}

function scrollToPoi(id: string, focus = false) {
    void nextTick(() => {
        const row = Array.from((objectList.value ?? document.querySelector('.pa-panel__scroll'))?.querySelectorAll<HTMLElement>('[data-poi-id]') ?? [])
            .find(element => element.dataset.poiId === id)
        row?.scrollIntoView({ block: 'nearest' })
        if (focus) row?.querySelector<HTMLElement>('button')?.focus()
    })
}

function selectPoi(id: string) {
    selectedPoiId.value = id
}

function selectPoiFromMap(id: string) {
    const poi = mapPois.value.find(item => item.id === id)
    if (!poi) return
    const changedTab = activeTab.value !== 'objects'
    activeTab.value = 'objects'
    if (activeCategory.value !== 'all') activeCategory.value = poi.category
    selectedPoiId.value = id
    scrollToPoi(id, changedTab)
}

function startPointPick() {
    if (pickMode.value) {
        cancelPick()
        return
    }
    pickMode.value = true
    void nextTick(() => mapRef.value?.focusMap())
}

function onMapPoint(point: AnalysisPoint) {
    geocodingRef.value?.clearDraft(); geocodingPreview.value = null
    pendingPoint.value = point
    pickMode.value = false
    void nextTick(() => analyzeButton.value?.focus())
}

function analyzePoint() {
    if (!pendingPoint.value) return
    geocodingRef.value?.clearSelection(); geocodingSelection.value = null
    place.value = { id: null, label: 'Точка на карте', ...pendingPoint.value }
    hasSelection.value = true
    runAnalysis()
    pendingPoint.value = null
    pickMode.value = false
    void nextTick(() => placeButton.value?.focus())
}

function cancelPoint() {
    pendingPoint.value = null
    pickMode.value = false
    void nextTick(() => placeButton.value?.focus())
}

function cancelPick() {
    pickMode.value = false
    void nextTick(() => placeButton.value?.focus())
}

function formatCoord(value: number) {
    return value.toFixed(4)
}

function selectStation(id: string) {
    selectedStationId.value = id
    showStations.value = true
    stationFocusRequest.value += 1
}

onMounted(() => {
    document.title = 'Анализ места — PlaceLens'
})
onBeforeUnmount(() => {
    if (radiusTimer) clearTimeout(radiusTimer)
})
</script>

<template>
    <div class="pa-page">
        <a class="pa-skip" href="#pa-panel">К содержанию анализа</a>
        <header class="pa-header">
            <a class="pa-brand" href="/" aria-label="PlaceLens — главная">
                <svg class="pa-brand__mark" viewBox="0 0 32 32" aria-hidden="true">
                    <rect width="32" height="32" rx="9" fill="#245b45" />
                    <path d="M9 10h7a5.5 5.5 0 0 1 0 11h-2.5v4H9V10Z" fill="#eaf2df" />
                    <circle cx="20" cy="14" r="4.5" stroke="#eaf2df" stroke-width="1.8" fill="none" />
                    <path d="m23.5 17.5 3 3" stroke="#eaf2df" stroke-width="1.8" stroke-linecap="round" />
                </svg>
                <span>Place<span>Lens</span></span>
            </a>
            <div class="pa-header__controls">
                <div class="pa-radius">
                    <label for="pa-radius-number">Радиус анализа:</label>
                    <input id="pa-radius-number" v-model.number="radius" class="pa-radius__number" type="number" min="200" max="1000" step="50" @change="normalizeRadius">
                    <span class="pa-radius__unit">м</span>
                    <span class="pa-radius__edge">200 м</span>
                    <input v-model.number="radius" class="pa-radius__range" type="range" min="200" max="1000" step="50" aria-label="Радиус анализа" @change="normalizeRadius">
                    <span class="pa-radius__edge">1 000 м</span>
                </div>
                <p v-if="pickMode" class="pa-pick-hint" role="status">Выберите точку на карте: клик или Enter в текущем центре. Escape — отмена.</p>
            </div>
        </header>

        <div class="pa-body">
            <aside id="pa-panel" class="pa-panel" aria-label="Панель анализа места">
                <div class="pa-sidebar-search">
                <GeocodingSearch ref="geocodingRef" :point="referencePoint" :selection-error="selectionError"
                    @selected="acceptGeocodingSelection" @retired="retireGeocodingSelection" @authorization-expired="geocodingAuthorizationExpired = $event" @preview="geocodingPreview = $event" @point="onMapPoint" />
                </div>
                <div class="pa-api-actions">
                    <p v-if="!geocodingSelection && (!referencePoint || pendingPoint)" class="pa-note">{{ hasSelection ? place.label : 'Выберите адресный объект или точку карты.' }}</p>
                    <div class="pa-api-actions__main">
                    <button class="pa-primary" type="button" :disabled="!analysis.input.value || !!geocodingSelection && geocodingAuthorizationExpired" :aria-describedby="!hasSelection ? 'pa-selection-hint' : undefined" @click="runAnalysis">Анализировать место</button>

                    </div>

                </div>
                <nav class="pa-tabs" role="tablist" aria-label="Разделы анализа">
                    <button
                        v-for="tab in tabOrder"
                        :id="`pa-tab-${tab}`"
                        :key="tab"
                        class="pa-tab"
                        :class="{ 'is-active': activeTab === tab }"
                        type="button"
                        role="tab"
                        :disabled="!hasSelection"
                        :aria-describedby="!hasSelection ? 'pa-selection-hint' : undefined"
                        :aria-selected="activeTab === tab"
                        :aria-controls="`pa-panel-${tab}`"
                        :tabindex="activeTab === tab ? 0 : -1"
                        @click="selectTab(tab)"
                        @keydown="tabKey"
                    ><component :is="tabIcons[tab]" :size="15" aria-hidden="true" />{{ tabLabels[tab] }}</button>
                </nav>

                <div :id="`pa-panel-${activeTab}`" class="pa-panel__scroll" role="tabpanel" :aria-labelledby="`pa-tab-${activeTab}`">
                    <div v-if="!hasSelection" id="pa-selection-hint" class="pa-selection-hint">
                        <MapPin :size="28" aria-hidden="true" />
                        <h2>Сначала выберите место</h2>
                        <p>Найдите и выберите адрес в поиске или нажмите «Точка на карте». После выбора станут доступны разделы и анализ места.</p>
                    </div>
                    <PlaceAnalysisResults v-else :tab="activeTab" :blocks="analysis.blocks" :selected-poi="selectedPoiId" :category="activeCategory"
                        :satellite-scope="satelliteScope" :can-load="!!analysis.input.value" :date="realDate" :satellite-mode="satelliteMode" :satellite-catalog="satelliteCatalog"
                        :station-radius="stationRadius" :selected-ids="selectedStationIds"
                        @load="loadBlock" @open="openAnalysisTab" @poi="selectPoi" @category="selectCategory" @station="selectStation"
                        @date="chooseSatelliteDate" @satellite-mode="satelliteMode = $event" @satellite-scope="satelliteScope = $event"
                        @station-radius="setStationRadius" @station-selection="selectedStationIds = $event" />
                </div>
            </aside>

            <section class="pa-map-shell" aria-label="Карта анализа">
                <PlaceAnalysisMap
                    ref="mapRef"
                    :center="mapCenter"

                    :analysis-area="displayedGeometry?.analysis_area ?? null"
                    :show-place-pin="hasSelection"
                    :geometry-stale="geometryStale"
                    :analysis-bounds="displayedGeometry?.analysis_bounds ?? null"
                    :stations="realStations"
                    :radius="displayedGeometry?.radius_m ?? radius"
                    :pois="mapPois"
                    :poi-distances-known="true"
                    :tab="activeTab"
                    :show-objects="mapShowObjects"
                    :show-satellite="showSatellite"
                    :show-stations="mapShowStations"
                    :show-radius="showRadius"
                    :layer-order="layerOrder"
                    :satellite-mode="mapSatelliteMode"
                    :satellite-scope="satelliteScope"
                    :satellite-opacity="satelliteOpacity"
                    :satellite-layers="satelliteLayers"
                    :category-filter="mapCategoryFilter"
                    :selected-poi="selectedPoiId"
                    :selected-station="selectedStationId"
                    :station-focus-request="stationFocusRequest"
                    :pending-point="geocodingPreview ?? pendingPoint"
                    :pending-draggable="!!geocodingPreview"
                    :pick-mode="pickMode"
                    @select-point="onMapPoint"
                    @cancel-pick="cancelPick"
                    @select-poi="selectPoiFromMap"
                    @select-station="selectStation"
                    @retry-satellite="loadBlock('satellite')"
                />

                <div v-if="pendingPoint" class="pa-point-card" role="dialog" aria-label="Выбранная точка" @keydown.esc="cancelPoint">
                    <div class="pa-point-card__head">
                        <strong>Точка на карте</strong>
                        <button type="button" class="pa-icon-button" aria-label="Закрыть карточку точки" @click="cancelPoint"><X :size="15" aria-hidden="true" /></button>
                    </div>
                    <p>Координаты: {{ formatCoord(pendingPoint.lat) }}, {{ formatCoord(pendingPoint.lon) }}</p>
                    <div class="pa-point-card__actions">
                        <button class="pa-outline" type="button" @click="cancelPoint">Отмена</button>
                        <button ref="analyzeButton" class="pa-primary" type="button" @click="analyzePoint">Анализировать</button>
                    </div>
                </div>

                <button ref="placeButton" class="pa-map-pick" type="button" :class="{ 'is-picking': pickMode }" :aria-pressed="pickMode" aria-label="Точка на карте" title="Выбрать точку на карте" @click="startPointPick"><MapPin :size="18" aria-hidden="true" /></button>
                <div class="pa-map-style">
                    <span class="pa-map-style__label"><Palette :size="14" aria-hidden="true" /> Тема</span>
                    <MapThemeControl />
                </div>

                <aside class="pa-layers" :class="{ 'is-collapsed': !layersOpen }" aria-label="Слои карты">
                    <h2 class="pa-layers__title">
                        <button
                            class="pa-layers__toggle"
                            type="button"
                            :aria-expanded="layersOpen"
                            aria-controls="pa-layers-body"
                            @click="layersOpen = !layersOpen"
                        >
                            <Layers class="pa-layers__icon" :size="16" aria-hidden="true" />
                            <span>Слои карты</span>
                            <ChevronDown class="pa-layers__chevron" :class="{ 'is-open': layersOpen }" :size="16" aria-hidden="true" />
                        </button>
                    </h2>
                    <div v-show="layersOpen" id="pa-layers-body" class="pa-layers__body">
                        <p class="pa-layers__hint">Порядок — сверху вниз. Стрелки меняют порядок слоёв.</p>
                        <div v-for="(key, index) in layerOrder" :key="key" class="pa-layer-item" :data-layer-key="key">
                            <label class="pa-layer-row">
                                <input v-if="key === 'objects'" v-model="showObjects" type="checkbox">
                                <input v-else-if="key === 'satellite'" v-model="showSatellite" type="checkbox">
                                <input v-else-if="key === 'stations'" v-model="showStations" type="checkbox">
                                <input v-else v-model="showRadius" type="checkbox">
                                <component :is="layerIcons[key]" class="pa-layer-icon" :size="15" aria-hidden="true" />
                                <span>{{ layerLabel(key) }}</span>
                                <span v-if="key === 'objects'" class="pa-layer-swatches" aria-hidden="true">
                                    <i v-for="category in categoryOrder" :key="category" class="pa-swatch" :class="`pa-swatch--${category}`">
                                        <component :is="categoryIcons[category]" :size="10" />
                                    </i>
                                </span>
                            </label>
                            <div class="pa-layer-order" role="group" :aria-label="`Порядок слоя «${layerLabel(key)}»`">
                                <button
                                    type="button"
                                    class="pa-layer-move"
                                    :disabled="index === 0"
                                    :aria-label="`Поднять слой «${layerLabel(key)}»`"
                                    @click="moveLayer(index, -1)"
                                ><ChevronUp :size="13" aria-hidden="true" /></button>
                                <button
                                    type="button"
                                    class="pa-layer-move"
                                    :disabled="index === layerOrder.length - 1"
                                    :aria-label="`Опустить слой «${layerLabel(key)}»`"
                                    @click="moveLayer(index, 1)"
                                ><ChevronDown :size="13" aria-hidden="true" /></button>
                            </div>
                            <label v-if="key === 'satellite' && showSatellite" class="pa-opacity">
                                <span>Непрозрачность:</span>
                                <input v-model.number="satelliteOpacity" type="range" min="0" max="1" step="0.05" aria-label="Непрозрачность спутникового слоя" title="0% — слой невидим, 100% — полностью непрозрачен">
                                <output>{{ Math.round(satelliteOpacity * 100) }}%</output>
                            </label>
                        </div>
                        <div class="pa-layer-row pa-layer-row--static">
                            <input type="checkbox" checked disabled>
                            <MapIcon class="pa-layer-icon" :size="15" aria-hidden="true" />
                            <span>Базовая карта</span>
                        </div>

                        <section v-if="ndviLegendVisible" class="pa-legend" aria-label="Легенда NDVI">
                            <h3 class="pa-legend__heading">
                                <button class="pa-legend__toggle" type="button" :aria-expanded="ndviLegendOpen"
                                    aria-controls="pa-ndvi-legend-body" @click="ndviLegendOpen = !ndviLegendOpen">
                                    <span>Легенда NDVI</span>
                                    <ChevronDown :size="14" :class="{ 'is-open': ndviLegendOpen }" aria-hidden="true" />
                                </button>
                            </h3>
                            <div v-show="ndviLegendOpen" id="pa-ndvi-legend-body">
                                <div v-for="legendClass in satelliteLegend!.classes" :key="legendClass.label" class="pa-legend__row">
                                    <span class="pa-legend__swatch" :style="{ background: legendClass.color }" aria-hidden="true" />
                                    {{ legendClass.label }}
                                </div>
                                <div class="pa-legend__row">
                                    <span class="pa-legend__swatch pa-legend__swatch--unknown" aria-hidden="true" />
                                    {{ satelliteLegend!.unknown.label }}
                                </div>
                            </div>
                        </section>
                        <div v-if="activeTab === 'air'" class="pa-legend">
                            <strong class="pa-legend__title">Условные обозначения</strong>
                            <div class="pa-legend__row"><RadioTower class="pa-legend__icon" :size="14" aria-hidden="true" /> Станция мониторинга</div>
                            <div class="pa-legend__row"><CircleDashed class="pa-legend__icon" :size="14" aria-hidden="true" /> Радиус анализа ({{ radius }} м)</div>
                        </div>
                        <div v-else-if="activeTab !== 'satellite'" class="pa-legend">
                            <strong class="pa-legend__title">Категории</strong>
                            <div v-for="category in categoryOrder" :key="category" class="pa-legend__row">
                                <component :is="categoryIcons[category]" class="pa-legend__icon" :size="14" :style="{ color: categoryMeta[category].color }" aria-hidden="true" />
                                {{ categoryMeta[category].label }}
                            </div>
                        </div>
                    </div>
                </aside>
            </section>
        </div>
    </div>
</template>
