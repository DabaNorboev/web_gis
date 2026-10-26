<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useComparisonView } from '@/composables/useComparisonView'
import PlaceLayout from '@/layouts/PlaceLayout.vue'
import AddressPicker from '@/components/AddressPicker.vue'
import ComparisonMetricRow from '@/components/ComparisonMetricRow.vue'
import OverviewTopics from '@/components/OverviewTopics.vue'
import ComparisonFacts from '@/components/ComparisonFacts.vue'
import { useOverviewTopics } from '@/composables/useOverviewTopics'
import ComparisonData from '@/components/ComparisonData.vue'
import ComparisonMapSplit from '@/components/ComparisonMapSplit.vue'
import CityMap from '@/components/map/CityMap.vue'
import MapThemeControl from '@/components/map/MapThemeControl.vue'
import MapLayersPanel from '@/components/map/MapLayersPanel.vue'
import type { LinearVisibility, AreaVisibility } from '@/types/profile'
import { useAddressComparison } from '@/composables/useAddressComparison'
import { parseComparison, type SideKey } from '@/utils/comparison'
import { comparisonGroups, comparisonExtraRows, type ComparisonRow } from '@/utils/comparisonPresentation'
import { profileUrl } from '@/utils/metricDisplay'
import type { AddressResult } from '@/types/address'
import type { AddressMapState } from '@/utils/addressMap'
import type { MapLayerKey } from '@/types/mapLayers'
import { mappedNearestId } from '@/utils/mapAnalysis'
import ComparisonTrips from '@/components/ComparisonTrips.vue'
import ComparisonShare from '@/components/ComparisonShare.vue'
import ComparisonTripData from '@/components/ComparisonTripData.vue'
import { useComparisonTrips } from '@/composables/useComparisonTrips'
import { useComparisonLink } from '@/composables/useComparisonLink'
import { tripMapData } from '@/utils/tripMap'
import type { TripMapOverlay } from '@/utils/tripOverlay'
import type { Coordinates } from '@/types/transport'

const { radius, sides, choose, setRadius, restore, loadSide, load } = useAddressComparison(parseComparison(window.location.search), selection => {
    personalLink.saveAddresses(selection)
})
const keys: SideKey[] = ['left', 'right']
const names = { left: 'А', right: 'Б' } as const
const trips = useComparisonTrips()
const personalPanel = ref<InstanceType<typeof ComparisonTrips> | null>(null)
const sharing = ref<InstanceType<typeof ComparisonShare> | null>(null)
const mapTripIds = reactive<Record<SideKey, string | null>>({ left: null, right: null })
const selectedTripId = ref<string | null>(null)
const pickingTrip = ref<{ id: string; side?: SideKey; end?: 'start' | 'target' } | null>(null)
let tripMapSequence = 0
const tripMapSequences = reactive({ left: 0, right: 0 })
const personalLink = useComparisonLink({ radius, sides, restore }, trips, {
    changed: () => sharing.value?.reset(),
    restored: personal => {
        clearPersonalMap()
        if (personal) void changeSection('trips', false)
    },
    addressesRestored: () => { for (const key of keys) { searchOpen[key] = false; pickers[key]?.reset() } },
})
const { invalidPersonalLink, shareUrl, personalShareUrl } = personalLink
function clearPersonalMap() {
    tripMapSequence++
    mapTripIds.left = null; mapTripIds.right = null; selectedTripId.value = null; pickingTrip.value = null
}
watch(trips.mode, clearPersonalMap, { flush: 'sync' })
function resetPersonal() { personalLink.resetPersonal(); clearPersonalMap() }
const selectedTrip = computed(() => trips.places.value.find(p => p.id === selectedTripId.value))
const tripOverlays = computed<Record<SideKey, TripMapOverlay | null>>(() => Object.fromEntries(keys.map(side => {
    const id = mapTripIds[side], place = trips.places.value.find(p => p.id === id), start = trips.starts[side].point
    if (!place?.point || !start) return [side, null]
    const value = trips.cell(side, place.id), row = value.row
    const data = tripMapData([{ key: 'S', point: start, road: value.hints.start }, { key: '1', point: place.point, road: value.hints.target }],
        row ? { mode: trips.mode.value, ...(trips.mode.value === 'walking' ? { route_scope: 'street_points' as const } : {}), start, results: [{ ...row, index: 0 }], source: value.source, limitation: value.limitation } : null,
        (['start', 'target'] as const).flatMap(end => value.options[end].length ? [{ key: end === 'start' ? 'S' : '1', label: `${names[side]} · ${end === 'start' ? 'Старт' : place.label || 'Цель'}`, candidates: value.options[end], selected: row?.road_choices?.[end]?.status === 'SELECTED' ? row.road_choices[end]?.point ?? null : null }] : []),
        trips.mode.value
    )
    // Request-local indices and scenario labels stop at this adapter.
    for (const feature of data.features) {
        if (feature.properties?.kind === 'original')
            feature.properties.label = feature.properties.label === 'Старт' ? `Старт ${names[side]}` : 'Цель'
        if (feature.properties?.kind === 'candidate')
            feature.properties.id = JSON.stringify([side, place.id, feature.properties.key, feature.geometry])
    }
    return [side, { data, sequence: tripMapSequences[side] }]
})) as Record<SideKey, TripMapOverlay | null>)
async function showPersonalTrip(side: SideKey, id: string) {
    selectTripContext(id)
    view.value = 'trips'
    activeSide.value = side; mapTripIds[side] = id; pickingTrip.value = null
    const sequence = tripMapSequences[side] = ++tripMapSequence
    await showMap()
    await nextTick()
    if (sequence === tripMapSequence && mapTripIds[side] === id) void maps[side]?.focusTrip()
}
async function pickPersonalPoint(id: string, side?: SideKey, end?: 'start' | 'target') {
    view.value = 'trips'
    selectTripContext(id)
    pickingTrip.value = { id, side, end }
    if (side) activeSide.value = side
    mapTripIds[activeSide.value] = id; tripMapSequences[activeSide.value] = ++tripMapSequence
    await showMap()
}
function selectTripContext(id: string) {
    // A shared mobile goal must never caption a line to a different goal on
    // the sibling map. Keep its results, but close that old map overlay.
    for (const side of keys) if (mapTripIds[side] !== id) mapTripIds[side] = null
    selectedTripId.value = id
}
function selectPersonalPoint(point: Coordinates | null) {
    const pick = pickingTrip.value
    if (!pick || !point) return
    if (pick.side && pick.end) trips.setRoad(pick.side, pick.id, pick.end, point)
    else { trips.setPoint(pick.id, point); personalPanel.value?.closeEditor(pick.id) }
}
async function roadCandidate(side: SideKey, key: string, point: Coordinates) {
    const id = mapTripIds[side]
    if (!id || view.value !== 'trips' || editing.value) return
    trips.setRoad(side, id, key === 'S' ? 'start' : 'target', point)
    await trips.calculate(side, id)
}
async function returnToPersonal() {
    const id = pickingTrip.value?.id
    pickingTrip.value = null
    await showIndicators()
    if (view.value === 'trips' && id) await personalPanel.value?.focusGoal(id)
}
async function closePersonalMap() { await changeSection('overview', false) }
const activeSide = ref<SideKey>(sides.left.id || !sides.right.id ? 'left' : 'right')
async function switchMapSide(side: SideKey) {
    activeSide.value = side
    if (pickingTrip.value?.side && pickingTrip.value.side !== side) pickingTrip.value = null
    await nextTick()
    if (!mapDisplayed[side]) await mapReady(side)
}
watch(() => trips.places.value.map(place => place.id), ids => {
    for (const side of keys) if (mapTripIds[side] && !ids.includes(mapTripIds[side]!)) mapTripIds[side] = null
    if (selectedTripId.value && !ids.includes(selectedTripId.value)) selectedTripId.value = null
    if (pickingTrip.value && !ids.includes(pickingTrip.value.id)) pickingTrip.value = null
})
const activeProfile = computed(() => sides[activeSide.value].profile)
// One editor at a time; both chosen-address cards always remain mounted.
const searchOpen = reactive({ left: !sides.left.id, right: false })
if (sides.left.id && !sides.right.id) searchOpen.right = true
const editing = computed(() => keys.find(key => searchOpen[key]) ?? null)
const view = ref<'overview' | 'trips' | 'data'>('overview')
const tabs = ['overview', 'trips', 'data'] as const
const tabNames = { overview: 'Окружение', trips: 'Поездки', data: 'О данных' }
const { toolbar, mapPanel, results, toolbarHeight, mapTop, mapFocused, showMap: revealMap, showIndicators, rememberReading, restoreReading } = useComparisonView(() => view.value)
const { includes, selection } = useOverviewTopics()
const mapDisplayed = { left: false, right: false }
async function showMap() {
    await revealMap()
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (!mapDisplayed[activeSide.value]) await mapReady(activeSide.value)
    if (view.value === 'trips' && tripOverlays.value[activeSide.value]) void maps[activeSide.value]?.focusTrip()
}
async function changeSection(next: typeof view.value, focusTab = true) {
    if (focusTab) for (const side of keys) searchOpen[side] = false
    if (next !== view.value) {
        rememberReading?.()
        view.value = next
        await nextTick()
        if (!mapFocused.value) await restoreReading?.(false)
    }
    if (focusTab) document.getElementById(`compare-tab-${next}`)?.focus({ preventScroll: true })
}
watch(view, async (next, previous) => {
    if ((next === 'trips') === (previous === 'trips')) return
    mapDisplayed.left = false; mapDisplayed.right = false
    cameraReady.left = false; cameraReady.right = false; sharedView.value = null
    await nextTick()
    await Promise.allSettled(keys.map(mapReady))
})
const hiddenAreas: AreaVisibility = { parks: false, vegetation: false, water: false }
const hiddenLines: LinearVisibility = { roads: false, railways: false }
const canCompare = computed(() => !!sides.left.id && !!sides.right.id && !!(sides.left.profile || sides.right.profile))
const pickers = reactive<Partial<Record<SideKey, InstanceType<typeof AddressPicker>>>>({})
const choices = reactive<Record<SideKey, AddressMapState>>({ left: { groups: [], selectedId: null, highlightedId: null, highlightedGroupId: null }, right: { groups: [], selectedId: null, highlightedId: null, highlightedGroupId: null } })
function addressLabel(key: SideKey): string {
    return sides[key].profile?.address.label ?? (sides[key].knownAddress?.id === sides[key].id ? sides[key].knownAddress?.label : null) ?? (sides[key].id ? 'Адрес ещё не загружен' : 'Адрес не выбран')
}
async function toggleSearch(key: SideKey) {
    const open = !searchOpen[key]
    for (const side of keys) searchOpen[side] = side === key && open
    activeSide.value = key
    if (open && mapFocused.value) await showIndicators()
    await nextTick()
    if (open) document.getElementById(`compare-picker-${key}`)?.querySelector('input')?.focus()
    else document.getElementById(`compare-change-${key}`)?.focus({ preventScroll: true })
}
async function chooseAddress(key: SideKey, id: string | null) {
    choose(key, id)
    for (const side of keys) searchOpen[side] = side === key && !id
    activeSide.value = key
    if (mapFocused.value) await showIndicators()
    await nextTick()
    if (id) {
        const panel = results.value?.closest<HTMLElement>('.comparison-sidebar')
        if (panel) panel.scrollTop = 0
        document.getElementById(`compare-change-${key}`)?.focus({ preventScroll: true })
    }
    else document.getElementById(`compare-picker-${key}`)?.querySelector('input')?.focus()
}
const showStops = ref(false)
const linearVisibility = ref<LinearVisibility>({ roads: false, railways: false })
const areaVisibility = ref<AreaVisibility>({ parks: false, vegetation: false, water: false })
const mapFocus = reactive<Record<SideKey, { layer: MapLayerKey; id?: string; sequence: number } | null>>({ left: null, right: null })
function focusLayer(side: SideKey, layer: MapLayerKey, id?: string) {
    view.value = 'overview'
    activeSide.value = side
    if (layer === 'stops') showStops.value = true
    else if (layer === 'roads' || layer === 'railways') linearVisibility.value = { ...linearVisibility.value, [layer]: true }
    else areaVisibility.value = { ...areaVisibility.value, [layer]: true }
    mapFocus[side] = { layer, id, sequence: (mapFocus[side]?.sequence ?? 0) + 1 }
    void showMap()
}
function rowMap(side: SideKey, row: ComparisonRow) {
    if (row.category === 'transport') {
        const transport = sides[side].profile?.blocks.transport.data
        selectedStopIds[side] = transport?.stops_in_radius.some(stop => stop.id === transport.nearest_stop?.id) ? transport.nearest_stop!.id : null
    }
    focusLayer(side, row.category === 'transport' ? 'stops' : row.category, row.category === 'transport' ? (selectedStopIds[side] === null ? undefined : String(selectedStopIds[side])) : mappedNearestId(sides[side].profile, row.category))
}
const cameraReady = { left: false, right: false }
const readySequence = { left: 0, right: 0 }
let disposed = false
const selectedObjects = reactive<Record<SideKey, { layer: MapLayerKey; id: string } | null>>({ left: null, right: null })
function selectedItem(side: SideKey) {
    const profile = sides[side].profile, selected = selectedObjects[side]
    if (selected && profile && selected.layer !== 'stops') {
        const data = selected.layer === 'roads' || selected.layer === 'railways' ? profile.map.linear_layers?.[selected.layer]?.data : profile.map.area_layers?.[selected.layer]?.data
        const feature = data?.features.find(feature => feature.properties.id === selected.id)
        if (feature) return { ...selected, name: feature.properties.name || 'Объект без названия' }
    }
    const stop = profile?.map?.stops_in_radius?.find(stop => stop.id === selectedStopIds[side])
    return stop ? { layer: 'stops' as const, id: String(stop.id), name: stop.name || 'Остановка без названия' } : null
}
const selectedStopIds = reactive<Record<SideKey, number | null>>({ left: null, right: null })
for (const key of keys) watch(() => sides[key].profile, () => { selectedStopIds[key] = null; selectedObjects[key] = null; mapFocus[key] = null; cameraReady[key] = false; mapDisplayed[key] = false; readySequence[key]++ })
watch([selectedObjects, selectedStopIds], async () => {
    await nextTick()
    for (const selected of results.value?.querySelectorAll<HTMLElement>('.comparison-row [aria-pressed="true"]') ?? [])
        for (let parent = selected.parentElement; parent && parent !== results.value; parent = parent.parentElement)
            if (parent instanceof HTMLDetailsElement) parent.open = true
}, { deep: true })
watch(showStops, visible => { if (!visible) { selectedStopIds.left = null; selectedStopIds.right = null } })
function addressForMap(key: SideKey): AddressResult | null {
    const address = sides[key].profile?.address
    return address ? { id: address.id, label: address.label, match_type: 'exact', object_count: 1, bounds: address.bounds, objects: [address.object] } : null
}
const mapAddresses = { left: computed(() => addressForMap('left')), right: computed(() => addressForMap('right')) }
function mapAddress(key: SideKey): AddressResult | null { return mapAddresses[key].value }
function searching(key: SideKey) { return searchOpen[key] && choices[key].groups.length > 0 }
const sameObject = computed(() => !!sides.left.id && sides.left.id === sides.right.id)
function stateMessage(key: SideKey): string {
    return ({ empty: 'Выберите адрес для этого варианта.', loading: 'Загружаем профиль…', ready: '', not_found: 'Объект не найден в активном наборе. Выберите другой адрес; отсутствие в наборе не доказывает отсутствие на местности.', unavailable: 'Набор адресов недоступен. Попробуйте повторить запрос.', error: 'Не удалось загрузить профиль. Повторите запрос или выберите другой адрес.' })[sides[key].status]
}
type CameraView = { zoom: number; bearing: number; pitch: number }
const sharedView = ref<CameraView | null>(null)
const maps = reactive<Partial<Record<SideKey, InstanceType<typeof CityMap>>>>({})
const split = ref<InstanceType<typeof ComparisonMapSplit> | null>(null)
function cameraChanged(side: SideKey, camera: CameraView) {
    if (searching(side) || !cameraReady[side] || !document.getElementById(`compare-map-${side}`)?.clientWidth) return
    const current = sharedView.value
    if (!current || Math.abs(current.zoom - camera.zoom) > 1e-9 || Math.abs(current.bearing - camera.bearing) > 1e-9 || Math.abs(current.pitch - camera.pitch) > 1e-9) sharedView.value = camera
}
async function resetMaps() {
    split.value?.reset()
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const cameras = keys.filter(key => !searching(key)).map(key => {
        const camera = maps[key]?.resetView()
        return document.getElementById(`compare-map-${key}`)?.clientWidth ? camera : null
    }).filter((value): value is CameraView => !!value)
    if (cameras.length) sharedView.value = { zoom: Math.min(...cameras.map(camera => camera.zoom)), bearing: 0, pitch: 0 }
}
async function mapReady(key: SideKey) {
    const sequence = ++readySequence[key]
    cameraReady[key] = false
    if (searching(key)) return
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (disposed || sequence !== readySequence[key] || searching(key)) return
    if (!document.getElementById(`compare-map-${key}`)?.clientWidth) { return }
    const camera = maps[key]?.resetView()
    if (camera) {
        const sibling = key === 'left' ? 'right' : 'left'
        sharedView.value = { zoom: Math.min(cameraReady[sibling] && sharedView.value ? sharedView.value.zoom : camera.zoom, camera.zoom), bearing: sharedView.value?.bearing ?? 0, pitch: sharedView.value?.pitch ?? 0 }
        cameraReady[key] = true; mapDisplayed[key] = true
        if (view.value !== 'trips' && (selectedObjects[key] || selectedStopIds[key] !== null)) void maps[key]?.focusSelection()
        if (view.value === 'trips' && tripOverlays.value[key]) void maps[key]?.focusTrip()
    }
}
function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(view.value) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    void changeSection(tabs[index]!)
}
onMounted(() => {
    document.title = 'Сравнение адресов — PlaceLens'
    void load()
})
onBeforeUnmount(() => { disposed = true })
</script>

<template>
    <PlaceLayout document>
        <main id="main-content" tabindex="-1" class="comparison-page" :class="{ 'is-map-focused': mapFocused, 'is-editing': editing }" :style="{ '--comparison-toolbar-height': `${toolbarHeight}px`, '--comparison-map-top': `${mapTop}px` }">
            <header ref="toolbar" class="comparison-toolbar">
                <div class="comparison-title"><h1>Сравнение адресов</h1><ComparisonShare ref="sharing" :address-url="shareUrl" :personal-url="personalShareUrl" /></div>
                <div id="compare-choices" class="comparison-addresses">
                    <section v-for="key in keys" :key="key" :aria-label="`Вариант ${names[key]}`" :aria-busy="sides[key].status === 'loading'">
                        <h2 :title="addressLabel(key)"><span class="variant-badge" :class="key === 'left' ? 'variant-badge--a' : 'variant-badge--b'">{{ names[key] }}</span><span class="comparison-address-label">{{ addressLabel(key) }}</span></h2>
                        <div class="comparison-address-actions"><button :id="`compare-change-${key}`" type="button" :aria-label="`${sides[key].id ? 'Заменить' : 'Выбрать'} адрес ${names[key]}`" :aria-expanded="searchOpen[key]" :aria-controls="`compare-picker-${key}`" @click="toggleSearch(key)">{{ sides[key].id ? 'Заменить' : 'Выбрать' }}</button><a v-if="sides[key].id" :href="profileUrl(sides[key].id!, radius)" :aria-label="`Открыть профиль ${names[key]}`">Профиль</a></div>
                    </section>
                </div>
            </header>
            <div class="comparison-workspace">
                <div class="comparison-sidebar">
                    <div class="comparison-navigation"><div role="tablist" aria-label="Раздел сравнения" class="comparison-data-tabs" @keydown="tabKey"><button v-for="tab in tabs" :id="`compare-tab-${tab}`" :key="tab" type="button" role="tab" :aria-selected="view === tab" :tabindex="view === tab ? 0 : -1" :aria-controls="`compare-panel-${tab}`" @click="changeSection(tab)">{{ tabNames[tab] }}</button></div><button type="button" class="comparison-open-map" aria-controls="compare-maps" @click="showMap">На карту</button></div>
                    <div class="comparison-searches" :hidden="!editing">
                        <section v-for="key in keys" :id="`compare-picker-${key}`" :key="key" :hidden="!searchOpen[key]" :aria-label="`Поиск адреса ${names[key]}`">
                            <div class="comparison-search-heading"><h2>Выбрать адрес {{ names[key] }}</h2><button type="button" class="profile-action" @click="toggleSearch(key)">Закрыть поиск {{ names[key] }}</button></div>
                            <p v-if="!sides.left.id && !sides.right.id" class="comparison-category-note comparison-start-note">Найдите А и выберите конкретный объект, затем добавьте Б. Номера объектов на карте совпадают со списком.</p>
                            <AddressPicker :ref="el => { if (el) pickers[key] = el as InstanceType<typeof AddressPicker>; else delete pickers[key] }" :selected-id="sides[key].id" external-map @map-state="choices[key] = $event" @select="chooseAddress(key, $event)" />
                            <button v-if="choices[key].groups.length" type="button" class="profile-action" @click="activeSide = key; showMap()">Варианты на карте {{ names[key] }}</button><button v-if="sides[key].id" type="button" class="profile-action" @click="chooseAddress(key, null)">Убрать вариант {{ names[key] }}</button>
                        </section>
                    </div>
                    <div id="compare-results" ref="results" tabindex="-1" class="comparison-results" :hidden="!!editing">
                        <p v-if="sameObject" class="result-notice">В обоих вариантах один объект. Замените адрес, чтобы сравнить разные места.</p>
                        <div class="comparison-side-states" aria-live="polite"><div v-for="key in keys" :key="key" :aria-label="`Состояние варианта ${names[key]}`"><template v-if="sides[key].id && sides[key].status !== 'ready'"><strong>{{ names[key] }}:</strong> {{ stateMessage(key) }} <button v-if="['not_found', 'unavailable', 'error'].includes(sides[key].status)" type="button" class="profile-action" @click="loadSide(key)">Повторить {{ names[key] }}</button></template></div></div>
                        <div id="compare-panel-overview" role="tabpanel" aria-labelledby="compare-tab-overview" :hidden="view !== 'overview'">
                            <div v-if="!canCompare" class="comparison-empty"><h2>Два адреса — одинаковые критерии</h2><p>Выберите А и Б, чтобы сравнить окружение без общего балла.</p><button v-if="!sides.left.id || !sides.right.id" type="button" class="profile-action" @click="toggleSearch(!sides.left.id ? 'left' : 'right')">Выбрать адрес {{ !sides.left.id ? 'А' : 'Б' }}</button></div>
                            <div v-show="canCompare">
                                <ComparisonFacts :sides="sides" :radius="radius" :selected="selection" />
                                <div class="comparison-settings"><OverviewTopics compact /><fieldset class="comparison-radius"><legend>Круг окружения</legend><button v-for="value in [300, 500]" :key="value" type="button" :aria-pressed="radius === value" @click="setRadius(value)">{{ value }} м</button></fieldset></div>
                                <component :is="all ? 'details' : 'div'" v-for="all in [false, true]" :key="String(all)" class="comparison-all">
                                    <summary v-if="all">Все показатели</summary>
                                    <p v-if="all" class="address-note">Скрытые темы и дополнительные сведения; расчёты сохранены.</p>
                                    <section v-for="group in comparisonGroups.filter(group => group.rows.some(row => all ? !includes(row.category) : includes(row.category)))" :key="group.title" class="comparison-category" :aria-label="group.title"><h2>{{ group.title }}</h2>
                                        <ComparisonMetricRow v-for="row in group.rows.filter(row => all ? !includes(row.category) : includes(row.category))" :key="row.category + row.key" :selected-objects="selectedObjects" :selected-stops="selectedStopIds" :row="row" :sides="sides" :radius="radius" @retry="loadSide" @show-map="rowMap($event, row)" />
                                        <p class="comparison-category-note">{{ group.note }}</p>
                                    </section>
                                    <details v-if="all" class="comparison-extra"><summary>Растительные территории и доли круга</summary><p class="comparison-category-note">Контуры OSM, а не измеренная растительность. Категории могут пересекаться; доли не складываются.</p><ComparisonMetricRow v-for="row in comparisonExtraRows" :key="row.category + row.key" :selected-objects="selectedObjects" :selected-stops="selectedStopIds" :row="row" :sides="sides" :radius="radius" @retry="loadSide" @show-map="rowMap($event, row)" /></details>
                                </component>
                                <div v-for="side in keys" :key="`selected-${side}`">
                                    <p v-if="selectedItem(side)" class="address-note" role="status">Выбрано на карте {{ names[side] }}: <button type="button" class="profile-action" aria-pressed="true" @click="focusLayer(side, selectedItem(side)!.layer, selectedItem(side)!.id)">{{ selectedItem(side)!.name }}</button></p>
                                </div>
                                <p class="comparison-category-note">Радиус {{ radius }} м задаёт круг подсчёта; ближайший объект может быть дальше. Полнота наборов, входы и доступ не проверены. Даты и методы — в «О данных».</p>
                            </div>
                        </div>
                        <div id="compare-panel-trips" role="tabpanel" aria-labelledby="compare-tab-trips" :hidden="view !== 'trips'"><ComparisonTrips ref="personalPanel" :model="trips" :invalid-link="invalidPersonalLink" @show="showPersonalTrip" @pick="pickPersonalPoint" @reset="resetPersonal" /></div>
                        <div id="compare-panel-data" role="tabpanel" aria-labelledby="compare-tab-data" :hidden="view !== 'data'"><h2 class="comparison-data-heading">Окружение адресов</h2><p class="comparison-category-note">Расстояния по прямой, источники, даты и качество каждого показателя. Полнота, входы и доступ не подтверждаются.</p><template v-for="key in keys" :key="key"><ComparisonData v-if="sides[key].profile" :profile="sides[key].profile!" :side="names[key]" /></template><ComparisonTripData :model="trips" /></div>
                    </div>
                </div>
                <aside id="compare-maps" ref="mapPanel" class="comparison-map-panel" aria-label="Карта сравнения">
                    <div class="comparison-map-tools">
                        <div class="comparison-map-heading"><h2 tabindex="-1">{{ editing ? 'Выбор адреса на карте' : view === 'trips' ? 'Поездки на карте' : 'Окружение на карте' }}</h2><div role="group" aria-label="Показываемый адрес на карте"><button v-for="key in keys" :key="key" type="button" :aria-pressed="activeSide === key" :aria-label="`Карта ${names[key]}`" @click="switchMapSide(key)">{{ names[key] }}</button></div><button type="button" class="comparison-reset" @click="view === 'trips' ? closePersonalMap() : resetMaps()">{{ view === 'trips' ? 'К окружению' : 'К радиусу' }}</button></div>
                        <div class="comparison-map-controls"><MapThemeControl /><MapLayersPanel v-show="view !== 'trips' && !editing" v-model:stops="showStops" v-model:areas="areaVisibility" v-model:lines="linearVisibility" floating comparison :contexts="keys.map(key => ({ key, label: `Вариант ${names[key]}`, profile: sides[key].profile, loading: sides[key].status === 'loading', selectedStop: selectedStopIds[key] !== null }))" @focus-layer="focusLayer(activeSide, $event)" /></div>
                    </div>
                    <ComparisonMapSplit ref="split" :active-side="activeSide">
                        <template v-for="key in keys" :key="key" #[key]>
                            <p class="comparison-map-address"><strong>{{ names[key] }}</strong> · {{ searching(key) ? 'Выберите объект · номера как в списке' : addressLabel(key) }}<template v-if="view !== 'trips'"> · {{ radius }} м</template></p>
                            <div :id="`compare-map-${key}`" class="comparison-map-frame placelens-map" :aria-label="`Карта варианта ${names[key]}`" :aria-busy="sides[key].status === 'loading'">
                                <CityMap :trip-overlay="view === 'trips' && !editing ? tripOverlays[key] : null" :show-analysis-area="view !== 'trips'" :trip-picking="view === 'trips' && !editing && !!pickingTrip && (!pickingTrip.side || pickingTrip.side === key)" @select="selectPersonalPoint" @road-candidate="(end, point) => roadCandidate(key, end, point)" :selection-zoom-limit="keys.some(side => side !== key && (view === 'trips' ? tripOverlays[side] : selectedObjects[side] || selectedStopIds[side] !== null)) ? sharedView?.zoom : undefined" :profile="sides[key].profile" @select-object="selectedObjects[key] = $event" @clear-stop="selectedStopIds[key] = null" v-if="searching(key) || sides[key].profile" :ref="el => { if (el) maps[key] = el as InstanceType<typeof CityMap>; else delete maps[key] }" :key="searching(key) ? `search-${key}` : `profile-${key}-${sides[key].id}`" :point="searching(key) ? null : sides[key].profile!.point" :address-group="searching(key) ? null : mapAddress(key)" :address-groups="searching(key) ? choices[key].groups : undefined" :selected-address-id="searching(key) ? choices[key].selectedId : sides[key].id" :highlighted-address-id="searching(key) ? choices[key].highlightedId : null" :highlighted-group-id="searching(key) ? choices[key].highlightedGroupId : null" :place-label="searching(key) ? undefined : names[key]" :analysis="searching(key) ? null : sides[key].profile!.map" :radius="radius" :selected-stop-id="selectedStopIds[key]" :show-stops="view !== 'trips' && !searching(key) && showStops" :area-layers="searching(key) ? null : sides[key].profile!.map.area_layers ?? null" :area-visibility="view === 'trips' ? hiddenAreas : areaVisibility" :linear-layers="searching(key) ? null : sides[key].profile!.map.linear_layers ?? null" :linear-visibility="view === 'trips' ? hiddenLines : linearVisibility" :focus-request="mapFocus[key]" :selectable="false" overlay-controls hide-theme :shared-view="searching(key) ? null : sharedView" @view-change="cameraChanged(key, $event)" @view-ready="mapReady(key)" @select-stop="selectedStopIds[key] = $event" @select-address-object="pickers[key]?.selectObjectById($event)" @highlight-address-object="pickers[key]?.highlightObjectById($event)" />
                                <div v-else class="comparison-map-placeholder" role="status">{{ stateMessage(key) }}<button v-if="['not_found', 'unavailable', 'error'].includes(sides[key].status)" type="button" class="profile-action" @click="loadSide(key)">Повторить {{ names[key] }}</button><button v-else-if="!sides[key].id && !searchOpen[key]" type="button" class="profile-action" @click="toggleSearch(key)">Выбрать адрес {{ names[key] }}</button></div>
                            </div>
                        </template>
                    </ComparisonMapSplit>
                    <div v-if="view === 'trips' && selectedTrip && !editing" class="comparison-trip-context" aria-live="polite"><p><span class="comparison-map-context-label">{{ pickingTrip ? 'Выбор точки' : 'Цель' }}</span><strong :title="selectedTrip.label">{{ selectedTrip.label || 'Без названия' }}</strong><span>{{ pickingTrip?.end ? `${pickingTrip.end === 'start' ? (trips.mode.value === 'walking' ? 'Уличный старт' : 'Дорожный старт') : (trips.mode.value === 'walking' ? 'Уличная цель' : 'Дорожная цель')} ${names[pickingTrip.side!]}` : tripOverlays[activeSide] ? `Поездка ${names[activeSide]}` : `Для ${names[activeSide]}` }}</span></p><template v-if="pickingTrip"><p class="comparison-pick-hint">Нажмите на карту или переместите её стрелками. Исходный адрес сохранится.</p><button type="button" @click="selectPersonalPoint(maps[activeSide]?.centerPoint()!)">Выбрать центр карты</button></template><button v-else-if="mapTripIds[activeSide] !== selectedTrip.id" type="button" @click="showPersonalTrip(activeSide, selectedTrip.id)">Показать поездку {{ names[activeSide] }} к этой цели</button></div>
                    <div class="comparison-map-footer"><p>{{ view === 'trips' ? (trips.mode.value === 'walking' ? 'Уличная часть · подходы от объектов неизвестны и не нарисованы' : 'Белые точки — дорога · пунктир — нерассчитанный подход') : 'Общий масштаб · независимые центры. Слои окружения ограничены кругом.' }}</p><button type="button" class="comparison-map-return" @click="returnToPersonal">{{ pickingTrip && view === 'trips' ? 'Готово · к поездкам' : 'К результатам' }}</button></div>
                </aside>
            </div>
        </main>
    </PlaceLayout>
</template>
<style scoped>
.comparison-page{display:flex;flex-direction:column;width:100%;min-width:0;min-height:0;color:#263f35;background:#f7f9f3;overflow-anchor:none}.comparison-toolbar{padding:8px 16px;background:#fcfdf9;border-bottom:1px solid #d9e2d4;z-index:12;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px}.comparison-title{grid-column:2;grid-row:1;display:flex;align-items:center;gap:8px}.comparison-title h1{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.comparison-addresses{grid-column:1;grid-row:1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.comparison-addresses section{min-width:0;padding:6px 10px;border:1px solid #d9e2d4;border-radius:9px;background:#f7f9f3}.comparison-addresses h2{display:flex;gap:7px;align-items:center;font-size:12px;font-weight:600}.comparison-addresses .variant-badge{width:22px;height:22px;font-size:11px;flex:none}.comparison-address-label{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.comparison-address-actions{display:flex;gap:5px 10px;align-items:center;margin-left:29px;font-size:11px}.comparison-address-actions button{padding:3px 7px;border:1px solid #cbdace;border-radius:6px;min-height:28px;background:#fff}.comparison-address-actions a{padding:4px 0;color:#2d6450;text-decoration:underline}.comparison-workspace{flex:1;min-height:0;display:grid;grid-template-columns:clamp(360px,30vw,420px) minmax(0,1fr)}.comparison-sidebar{min-width:0;min-height:0;overflow-y:auto;border-right:1px solid #d9e2d4;scroll-padding:12px;overscroll-behavior:contain;scrollbar-gutter:stable}.comparison-sidebar [hidden]{display:none}.comparison-navigation{display:flex;align-items:center;gap:8px;padding:0 14px;background:#fcfdf9;border-bottom:1px solid #d9e2d4;position:sticky;top:0;z-index:8}.comparison-data-tabs{display:flex;flex:1;gap:4px;min-width:0}.comparison-data-tabs button{flex:1;min-height:44px;padding:8px 6px;border-bottom:3px solid transparent;font-size:13px;font-weight:600;white-space:nowrap;color:#607366}.comparison-data-tabs button[aria-selected=true]{border-color:#2d6450;color:#2d6450;background:transparent}.comparison-open-map{font-size:11px;min-height:36px;padding:5px 7px;border:1px solid #cbdace;border-radius:7px;white-space:nowrap;color:#2d6450}.comparison-results,.comparison-searches{padding:14px}.comparison-results{outline:none;min-width:0}.comparison-search-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.comparison-search-heading h2{font-size:15px;font-weight:650}.comparison-settings{display:flex;align-items:start;gap:12px;margin:16px 0 8px;padding-block:10px;border-block:1px solid #dce5da}.comparison-settings :deep(.overview-topics){flex:1;min-width:0;margin:0}.comparison-settings:has(details[open]){flex-wrap:wrap}.comparison-settings:has(details[open]) :deep(.overview-topics){flex-basis:100%}.comparison-radius{flex:none;font-size:11px}.comparison-radius legend{margin-bottom:4px;color:#607366}.comparison-radius button{min-height:32px;padding:4px 7px;border:1px solid #cbdace;border-radius:6px;margin-right:3px;font-size:11px}.comparison-radius button[aria-pressed=true]{background:#2d6450;color:#fff}.comparison-category{margin-top:16px}.comparison-category>h2,.comparison-data-heading{font-size:16px;font-weight:650}.comparison-category-note{margin-top:8px;font-size:11px;color:#637769;line-height:1.6}.comparison-all>summary,.comparison-extra>summary{cursor:pointer;padding:10px 0;font-size:13px;font-weight:600}.comparison-extra{margin-top:16px}.comparison-empty h2{font-size:19px;font-weight:600}.comparison-empty p{margin:12px 0;font-size:13px;line-height:1.7;color:#637769}.comparison-side-states{color:#705629;font-size:12px;line-height:1.6}.comparison-side-states>div:not(:empty){margin-bottom:10px;padding:8px;background:#f6efdf;border-radius:8px}.comparison-map-panel{display:flex;position:relative;flex-direction:column;min-width:0;min-height:0;container-type:size}.comparison-map-tools{flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;padding:8px 10px;background:#fcfdf9;z-index:7}.comparison-map-heading,.comparison-map-controls{display:contents}.comparison-map-heading h2{font-size:12px;font-weight:600;margin-right:auto;outline:none}.comparison-map-heading [role=group]{display:none}.comparison-reset{order:3;min-height:36px;padding:6px 9px;border:1px solid #cbdace;border-radius:7px;font-size:11px;color:#2d6450;background:#fff}.comparison-map-controls :deep(.map-theme-control){order:1;flex:none}.comparison-map-controls :deep(.map-layers-panel){order:2;flex:none;margin-left:0}.comparison-map-controls :deep(.map-layers-body){max-height:min(360px,calc(100cqh - 100px))}.comparison-map-split{flex:1}.comparison-map-address{flex:none;min-height:29px;padding:5px 10px;background:#eef2e8;font-size:11px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.comparison-map-frame{position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}.comparison-map-placeholder{display:flex;height:100%;flex-direction:column;justify-content:center;align-items:center;padding:20px;text-align:center;font-size:13px;line-height:1.7;gap:12px}.comparison-trip-context{flex:none;padding:7px 12px;background:#edf4ed;font-size:12px;border-top:1px solid #d9e2d4}.comparison-trip-context>p:first-child{display:flex;align-items:center;gap:8px;min-width:0}.comparison-trip-context strong{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere;flex:1}.comparison-map-context-label{font-size:10px;text-transform:uppercase;color:#607366;flex:none}.comparison-trip-context button{min-height:36px;padding:5px 8px;border:1px solid #a9c5b4;border-radius:7px;margin-top:6px;background:#fff;color:#2d6450}.comparison-pick-hint{font-size:11px;color:#607366;margin-top:5px}.comparison-map-footer{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 12px;background:#fcfdf9}.comparison-map-footer p{font-size:10px;color:#637769;line-height:1.4}.comparison-map-return{flex:none;min-height:34px;padding:5px 9px;border:1px solid #cbdace;border-radius:7px;font-size:11px;color:#2d6450;background:#fff}.comparison-page :is(button,a,summary,input,h2[tabindex],h3[tabindex],#compare-results):focus-visible{outline:3px solid #2d6450;outline-offset:2px}
@media(min-width:1100px){.comparison-page{height:calc(100dvh - 75px);overflow:hidden}.comparison-open-map{padding-inline:6px}}
@media(max-width:1099px){.comparison-toolbar{position:sticky;top:0;padding:6px 12px;display:flex;flex-direction:column;align-items:stretch;gap:6px}.comparison-title{justify-content:space-between}.comparison-title h1{position:static;width:auto;height:auto;clip-path:none;font-size:14px;font-weight:600}.comparison-title :deep(.comparison-share summary){min-height:32px;padding:5px 9px;font-size:11px}.comparison-addresses{gap:6px}.comparison-addresses section{padding:5px 6px}.comparison-addresses h2{align-items:start;font-size:11px;gap:5px}.comparison-address-actions{margin:3px 0 0;gap:5px 8px}.comparison-address-actions button{min-height:26px;padding:2px 5px}.comparison-addresses .variant-badge{width:20px;height:20px;font-size:10px}.comparison-workspace{display:block}.comparison-sidebar{overflow:visible;border:0;scrollbar-gutter:auto}.comparison-navigation{top:var(--comparison-toolbar-height);padding:0 10px;gap:6px}.comparison-data-tabs button{padding-inline:5px;font-size:12px}.comparison-open-map{padding-inline:7px}.comparison-results,.comparison-searches{padding:14px 12px 24px}.comparison-map-panel{display:none}.is-map-focused{position:fixed;inset:0;z-index:30;height:100dvh;background:#fcfdf9}.is-map-focused .comparison-toolbar{position:relative;flex:none}.is-map-focused .comparison-workspace{display:flex;flex-direction:column;flex:1;min-height:0}.is-map-focused .comparison-sidebar{display:none}.is-map-focused .comparison-map-panel{display:flex;flex:1;min-height:0}.is-map-focused .comparison-title h1{font-size:12px}.comparison-map-tools{display:block;padding:6px 8px}.comparison-map-heading{display:flex;align-items:center;gap:8px}.comparison-map-heading h2{margin-right:auto;font-size:12px}.comparison-map-heading [role=group]{display:flex;gap:3px}.comparison-map-heading [role=group] button{min-height:32px;min-width:30px;border:1px solid #cbdace;border-radius:7px;padding:4px 7px;font-size:12px}.comparison-map-heading [role=group] button[aria-pressed=true]{background:#2d6450;color:white}.comparison-reset{min-height:32px;font-size:10px;padding:4px 7px}.comparison-map-controls{display:flex;align-items:start;gap:6px;margin-top:6px}.comparison-map-controls :deep(.map-layers-panel){margin-left:auto}.comparison-map-controls :deep(.map-theme-control button){padding-inline:6px}.comparison-map-controls :deep(.map-layers-body){max-height:min(360px,calc(100cqh - 120px))}.comparison-map-footer p{max-width:60%;font-size:9px}.comparison-trip-context{padding:6px 10px;font-size:11px}.comparison-map-footer{padding:5px 10px}.comparison-settings{gap:8px}.comparison-radius button{padding-inline:5px}}
</style>
