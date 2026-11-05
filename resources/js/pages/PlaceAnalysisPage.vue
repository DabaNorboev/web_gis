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
import PointAddressReference from '@/components/place-analysis/PointAddressReference.vue'
import { useAnalysisPointAddress } from '@/composables/useAnalysisPointAddress'
import PlaceAnalysisResults from '@/components/place-analysis/PlaceAnalysisResults.vue'
import { usePlaceAnalysis } from '@/composables/usePlaceAnalysis'
import { searchAddresses } from '@/api/addresses'
import type { AddressResult } from '@/types/address'
import type { AddressMapState } from '@/utils/addressMap'
import type { AnalysisBlockKey, PlaceAnalysisInput, PlaceAnalysisResponse } from '@/types/placeAnalysis'
import '../../css/place-analysis.css'

const analysis = usePlaceAnalysis()
const hasSelection = ref(false)
const displayedGeometry = shallowRef<PlaceAnalysisResponse | null>(null)
const geometryStale = computed(() => !!displayedGeometry.value && !analysis.map.value)
let radiusTimer: ReturnType<typeof setTimeout> | null = null
const realDate = ref('')
const stationRadius = ref(5000)
const selectedStationIds = ref<string[]>([])
type AddressSuggestion = PlaceSelection & { groupId?: string; objectLabel?: string; floorLabel?: string; multiple?: boolean; number?: number }
const realAddresses = ref<AddressSuggestion[]>([])
const addressGroups = ref<AddressResult[]>([])
const hoveredAddressId = ref<string | null>(null)
const selectedBuildingLabel = ref('')
const searchPending = ref(false)
let searchController: AbortController | null = null
let searchEpoch = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null
const realPoi = computed(() => analysis.blocks.poi.response?.blocks.poi)
const realStations = computed(() => {
    const block = analysis.blocks.air.response?.blocks.air
    return block?.status === 'READY' ? block.data.stations.map((s, i) => ({ ...s, number: i + 1, distance_km: s.distance_m / 1000 })) : []
})
const mapCenter = computed(() => displayedGeometry.value ? displayedGeometry.value.place.point : place.value)
const realMapPois = computed(() => realPoi.value?.status === 'READY' ? realPoi.value.data.items.map(p => ({
    id: p.id, category: p.category, name: p.name ?? 'Без названия', ...p.point, distance_m: p.distance_m, geometry: p.geometry,
})) : [])
function syncInput() {
    const valid = hasSelection.value && Number.isInteger(radius.value) && radius.value >= 200 && radius.value <= 1000
        && Number.isInteger(stationRadius.value) && stationRadius.value >= 1000 && stationRadius.value <= 20000
    const input: PlaceAnalysisInput | null = !valid ? null : {
        place: place.value.id ? { kind: 'address', address_id: place.value.id } : { kind: 'point', lon: place.value.lon, lat: place.value.lat },
        radius_m: radius.value, ...(realDate.value ? { date: realDate.value } : {}),
        stations: { selected_ids: selectedStationIds.value, radius_m: stationRadius.value },
    }
    analysis.setInput(input)
}
function runAnalysis() {
    if (radiusTimer) { clearTimeout(radiusTimer); radiusTimer = null }
    syncInput(); void analysis.loadAll()
}
function floorLabel(levels: string | null): string {
    if (!levels) return ''
    const number = Number(levels)
    if (!Number.isInteger(number) || number <= 0) return `Этажность: ${levels}`
    const plural = new Intl.PluralRules('ru').select(number)
    return `${levels} ${plural === 'one' ? 'этаж' : plural === 'few' ? 'этажа' : 'этажей'}`
}
function setStationRadius(value: number) {
    stationRadius.value = Number.isInteger(value) ? Math.max(1000, Math.min(20000, value)) : 5000
}
function loadBlock(key: AnalysisBlockKey) { syncInput(); void analysis.load(key) }


const tabOrder: AnalysisTab[] = ['overview', 'objects', 'satellite', 'air']
const activeTab = ref<AnalysisTab>('overview')
const place = ref<PlaceSelection>({ id: null, label: 'Выберите место', lon: 92.85, lat: 56.01 })
const addressQuery = ref('')
const suggestionsOpen = ref(false)
const activeSuggestion = ref(-1)
const suggestionsVisible = computed(() => suggestionsOpen.value && addressQuery.value.trim().length > 0)
const searchHint = ref('')
const radius = ref(500)
const pendingPoint = ref<AnalysisPoint | null>(null)
const pickMode = ref(false)
const referencePoint = computed(() => pendingPoint.value
    ?? (hasSelection.value && !place.value.id ? { lon: place.value.lon, lat: place.value.lat } : null))
const pointAddress = useAnalysisPointAddress(referencePoint, address => {
    selectAddress({ id: address.id, label: address.label, lon: address.object.lon, lat: address.object.lat })
    void nextTick(() => placeButton.value?.focus())
})
const activeCategory = ref<PoiCategory | 'all'>('grocery')
const selectedPoiId = ref<string | null>(null)
const selectedStationId = ref<string | null>(null)
const stationFocusRequest = ref(0)
const satelliteMode = ref<SatelliteMode>('ndvi')
const satelliteOpacity = ref(0.35)
const showObjects = ref(true)
const showSatellite = ref(true)
const showStations = ref(true)
const showRadius = ref(true)
const layersOpen = ref(true)
const objectList = ref<HTMLElement | null>(null)
const mapRef = ref<{ focusMap: () => void } | null>(null)
const placeButton = ref<HTMLButtonElement | null>(null)
const analyzeButton = ref<HTMLButtonElement | null>(null)
const layerOrder = ref<AnalysisLayer[]>(['objects', 'satellite', 'stations', 'radius'])

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
    if (key === 'satellite') return mapSatelliteMode.value === 'ndvi' ? 'NDVI (Sentinel-2)' : 'Спутниковый снимок'
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
const filteredAddresses = realAddresses
const suggestionGroups = computed(() => {
    const groups: { id: string; label: string; items: { address: AddressSuggestion; index: number }[] }[] = []
    filteredAddresses.value.forEach((address: AddressSuggestion, index) => {
        const key = address.groupId ?? address.id ?? address.label
        let group = groups.find(g => g.id === key)
        if (!group) { group = { id: key, label: address.label, items: [] }; groups.push(group) }
        group.items.push({ address, index })
    })
    return groups
})
const addressPreview = computed<AddressMapState | null>(() => {
    if (!suggestionsVisible.value || !addressGroups.value.length) return null
    const highlighted = hoveredAddressId.value ?? filteredAddresses.value[activeSuggestion.value]?.id ?? null
    const group = addressGroups.value.find(g => g.objects.some(o => o.id === highlighted)) ?? addressGroups.value[0]!
    return { groups: [group], selectedId: place.value.id, highlightedId: highlighted, highlightedGroupId: null }
})
function selectPreviewAddress(id: string) {
    const address = realAddresses.value.find(a => a.id === id)
    if (address) selectAddress(address)
}
watch(filteredAddresses, () => { activeSuggestion.value = -1; hoveredAddressId.value = null })
watch(realMapPois, () => { selectedPoiId.value = null })
watch(analysis.map, value => { if (value) displayedGeometry.value = value }, { flush: 'sync' })
watch(place, () => { displayedGeometry.value = null }, { flush: 'sync' })
watch(() => Object.values(analysis.blocks).some(block => block.error?.code === 'ADDRESS_POINT_CHANGED'), changed => {
    if (changed) displayedGeometry.value = null
}, { flush: 'sync' })
watch([place, radius, realDate, stationRadius, selectedStationIds, hasSelection], syncInput, { deep: true, flush: 'sync' })
watch(radius, () => {
    if (radiusTimer) clearTimeout(radiusTimer)
    if (hasSelection.value) radiusTimer = setTimeout(() => {
        radiusTimer = null
        if (analysis.input.value) void analysis.loadAll()
    }, 350)
}, { flush: 'sync' })
watch(addressQuery, query => {
    const epoch = ++searchEpoch
    searchController?.abort()
    if (searchTimer) clearTimeout(searchTimer)
    realAddresses.value = []
    addressGroups.value = []
    hoveredAddressId.value = null
    searchPending.value = false
    if (query.trim().length < 2 || query === place.value.label) return
    searchTimer = setTimeout(async () => {
        const controller = new AbortController()
        searchController = controller
        searchPending.value = true
        try {
            const response = await searchAddresses(query.trim(), controller.signal)
            if (epoch !== searchEpoch) return
            addressGroups.value = response.data.filter(group => Array.isArray(group.bounds) && group.bounds.length === 4 && group.bounds.every(Number.isFinite))
                .map(group => ({ ...group, objects: group.objects.filter(object =>
                    /^osm:(node|way|relation):[1-9][0-9]{0,18}$/.test(object.id) && Number.isFinite(object.lon) && Number.isFinite(object.lat)
                ) })).filter(group => group.objects.length > 0)
            realAddresses.value = addressGroups.value.flatMap(group => group.objects.map((object, index) => ({
                id: object.id, label: group.label, lon: object.lon, lat: object.lat, groupId: group.id, number: index + 1, multiple: group.objects.length > 1, floorLabel: floorLabel(object.levels),
                objectLabel: `${object.object_type === 'building' ? 'Здание' : object.object_type === 'address_point' ? 'Адресная точка' : 'Объект'} ${index + 1}`,
            })))
        } catch { if (epoch === searchEpoch) searchHint.value = 'Адресный поиск недоступен. Можно явно выбрать точку на карте.' }
        finally { if (epoch === searchEpoch) searchPending.value = false }
    }, 300)
})
watch(showObjects, value => { if (!value) selectedPoiId.value = null })
const mapSatelliteMode = computed<SatelliteMode>(() => activeTab.value === 'overview' ? 'snapshot' : satelliteMode.value)
const mapShowObjects = computed(() => showObjects.value)
const mapShowStations = computed(() => showStations.value)
const mapCategoryFilter = computed<PoiCategory | null>(() => activeTab.value === 'objects' && activeCategory.value !== 'all' ? activeCategory.value : null)

function selectTab(tab: AnalysisTab) {
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

function selectAddress(address: AddressSuggestion) {
    selectedBuildingLabel.value = address.multiple ? address.objectLabel ?? '' : ''
    place.value = { ...address }
    hasSelection.value = true
    addressQuery.value = address.label
    suggestionsOpen.value = false
    activeSuggestion.value = -1
    searchHint.value = ''
    pendingPoint.value = null
    pickMode.value = false
    runAnalysis()
}

function submitSearch() {
    const address = activeSuggestion.value >= 0 ? filteredAddresses.value[activeSuggestion.value]
        : filteredAddresses.value.length === 1 ? filteredAddresses.value[0] : undefined
    if (address) selectAddress(address)
    else {
        suggestionsOpen.value = true
        searchHint.value = filteredAddresses.value.length ? 'Выберите адрес из списка.' : 'Выберите конкретный адресный объект или точку на карте.'
    }
}

function searchKey(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Escape') {
        suggestionsOpen.value = false
        activeSuggestion.value = -1
        return
    }
    suggestionsOpen.value = true
    const count = filteredAddresses.value.length
    if (!count) return
    activeSuggestion.value = event.key === 'ArrowDown' ? (activeSuggestion.value + 1) % count
        : activeSuggestion.value <= 0 ? count - 1 : activeSuggestion.value - 1
}

function closeSearch(event: FocusEvent) {
    const form = event.currentTarget as HTMLFormElement
    if (event.relatedTarget instanceof Node && form.contains(event.relatedTarget)) return
    if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest('.pa-address-marker')) return
    suggestionsOpen.value = false
    activeSuggestion.value = -1
}

function clearSearch() {
    addressQuery.value = ''
    searchHint.value = ''
    suggestionsOpen.value = true
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
    pendingPoint.value = point
    pickMode.value = false
    void nextTick(() => analyzeButton.value?.focus())
}

function analyzePoint() {
    if (!pendingPoint.value) return
    place.value = { id: null, label: 'Точка на карте', ...pendingPoint.value }
    hasSelection.value = true
    runAnalysis()
    addressQuery.value = 'Точка на карте'
    suggestionsOpen.value = false
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
    searchEpoch++
    searchController?.abort()
    if (searchTimer) clearTimeout(searchTimer)
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
                <form class="pa-search" role="search" @submit.prevent="submitSearch" @focusout="closeSearch">
                    <Search class="pa-search__icon" :size="18" aria-hidden="true" />
                    <input
                        v-model="addressQuery"
                        class="pa-search__input"
                        type="search"
                        role="combobox"
                        aria-autocomplete="list"
                        placeholder="Поиск адреса в Красноярске"
                        aria-label="Поиск адреса"
                        :aria-expanded="suggestionsVisible"
                        aria-controls="pa-address-suggestions"
                        :aria-activedescendant="suggestionsVisible && activeSuggestion >= 0 ? `pa-address-${activeSuggestion}` : undefined"
                        @focus="suggestionsOpen = true"
                        @input="suggestionsOpen = true; searchHint = ''"
                        @keydown="searchKey"
                    >
                    <button v-if="addressQuery" class="pa-search__clear" type="button" aria-label="Очистить поиск" @click="clearSearch"><X :size="15" aria-hidden="true" /></button>
                    <div v-if="suggestionsVisible" class="pa-suggestions">
                        <p class="pa-suggestions__note">Выберите конкретный объект из локального адресного набора</p>
                        <div id="pa-address-suggestions" role="listbox" aria-label="Адреса">
                        <div v-for="group in suggestionGroups" :key="group.id" role="group" :aria-label="group.label" class="pa-address-group">
                            <p v-if="group.items.length > 1" class="pa-address-group__title"><strong class="pa-address-title">{{ group.label }}</strong><small>{{ group.items.length > 1 ? `Один адрес · ${group.items.length} объекта` : 'Один объект' }}</small></p>
                            <button v-for="{ address, index } in group.items" :id="`pa-address-${index}`" :key="address.id ?? address.label"
                                class="pa-suggestion" :class="{ 'is-active': activeSuggestion === index || hoveredAddressId === address.id, 'pa-suggestion--single': group.items.length === 1 }"
                                role="option" :aria-label="group.items.length === 1 ? address.label : `${address.label} · ${address.objectLabel}`" :aria-selected="activeSuggestion === index"
                                type="button" @click="selectAddress(address)" @pointerenter="hoveredAddressId = address.id" @pointerleave="hoveredAddressId = null" @focus="activeSuggestion = index">
                                <span v-if="group.items.length > 1" class="pa-address-number" aria-hidden="true">{{ address.number }}</span>
                                <span class="pa-suggestion__body"><span :class="{ 'pa-address-title': group.items.length === 1 }">{{ group.items.length === 1 ? address.label : address.objectLabel }}</span><small v-if="address.floorLabel">{{ address.floorLabel }}</small></span>
                            </button>
                        </div>
                        </div>
                        <p v-if="!filteredAddresses.length" class="pa-suggestions__empty">{{ searchPending ? 'Поиск…' : 'Адресные объекты не найдены.' }}</p>
                        <p v-if="searchHint" class="pa-suggestions__empty">{{ searchHint }}</p>
                    </div>
                </form>
                </div>
                <div class="pa-api-actions">
                    <p v-if="!referencePoint || pendingPoint" class="pa-note">{{ hasSelection ? place.label : 'Выберите адресный объект или точку карты.' }}<span v-if="hasSelection && place.id && selectedBuildingLabel"> · {{ selectedBuildingLabel }}</span></p>
                    <div class="pa-api-actions__main">
                    <button class="pa-primary" type="button" :disabled="!analysis.input.value" @click="runAnalysis">Анализировать место</button>
                    <PointAddressReference v-if="referencePoint && !pendingPoint" compact :candidates="pointAddress.candidates.value" :status="pointAddress.status.value"
                        :transition-pending="pointAddress.transitionPending.value" :transition-error="pointAddress.transitionError.value"
                        :coverage-reason="pointAddress.result.value?.meta?.coverage?.reason"
                        @analyze="pointAddress.analyzeAddress" @retry="pointAddress.retry" />
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
                        :aria-selected="activeTab === tab"
                        :aria-controls="`pa-panel-${tab}`"
                        :tabindex="activeTab === tab ? 0 : -1"
                        @click="selectTab(tab)"
                        @keydown="tabKey"
                    ><component :is="tabIcons[tab]" :size="15" aria-hidden="true" />{{ tabLabels[tab] }}</button>
                </nav>

                <div :id="`pa-panel-${activeTab}`" class="pa-panel__scroll" role="tabpanel" :aria-labelledby="`pa-tab-${activeTab}`">
                    <PlaceAnalysisResults :tab="activeTab" :blocks="analysis.blocks" :selected-poi="selectedPoiId" :category="activeCategory"
                        :can-load="!!analysis.input.value" :date="realDate" :station-radius="stationRadius" :selected-ids="selectedStationIds"
                        @load="loadBlock" @open="openAnalysisTab" @poi="selectPoi" @category="selectCategory" @station="selectStation"
                        @date="realDate = $event" @station-radius="setStationRadius" @station-selection="selectedStationIds = $event" />
                </div>
            </aside>

            <section class="pa-map-shell" aria-label="Карта анализа">
                <PlaceAnalysisMap
                    ref="mapRef"
                    :center="mapCenter"

                    :address-preview="addressPreview"
                    @highlight-address="hoveredAddressId = $event"
                    @select-address="selectPreviewAddress"
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
                    :satellite-opacity="satelliteOpacity"
                    :category-filter="mapCategoryFilter"
                    :selected-poi="selectedPoiId"
                    :selected-station="selectedStationId"
                    :station-focus-request="stationFocusRequest"
                    :pending-point="pendingPoint"
                    :pick-mode="pickMode"
                    @select-point="onMapPoint"
                    @cancel-pick="cancelPick"
                    @select-poi="selectPoiFromMap"
                    @select-station="selectStation"
                />

                <div v-if="pendingPoint" class="pa-point-card" role="dialog" aria-label="Выбранная точка" @keydown.esc="cancelPoint">
                    <div class="pa-point-card__head">
                        <strong>Точка на карте</strong>
                        <button type="button" class="pa-icon-button" aria-label="Закрыть карточку точки" @click="cancelPoint"><X :size="15" aria-hidden="true" /></button>
                    </div>
                    <p>Координаты: {{ formatCoord(pendingPoint.lat) }}, {{ formatCoord(pendingPoint.lon) }}</p>
                    <PointAddressReference compact :candidates="pointAddress.candidates.value" :status="pointAddress.status.value"
                        :transition-pending="pointAddress.transitionPending.value" :transition-error="pointAddress.transitionError.value"
                        :coverage-reason="pointAddress.result.value?.meta?.coverage?.reason"
                        @analyze="pointAddress.analyzeAddress" @retry="pointAddress.retry" />
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
                        </div>
                        <div class="pa-layer-row pa-layer-row--static">
                            <input type="checkbox" checked disabled>
                            <MapIcon class="pa-layer-icon" :size="15" aria-hidden="true" />
                            <span>Базовая карта</span>
                        </div>
                        <label v-if="showSatellite" class="pa-opacity">
                            <span>Прозрачность:</span>
                            <input v-model.number="satelliteOpacity" type="range" min="0" max="1" step="0.05" aria-label="Прозрачность спутникового слоя">
                            <output>{{ Math.round(satelliteOpacity * 100) }}%</output>
                        </label>

                        <div v-if="activeTab === 'air'" class="pa-legend">
                            <strong class="pa-legend__title">Условные обозначения</strong>
                            <div class="pa-legend__row"><RadioTower class="pa-legend__icon" :size="14" aria-hidden="true" /> Станция мониторинга</div>
                            <div class="pa-legend__row"><CircleDashed class="pa-legend__icon" :size="14" aria-hidden="true" /> Радиус анализа ({{ radius }} м)</div>
                        </div>
                        <div v-else class="pa-legend">
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
