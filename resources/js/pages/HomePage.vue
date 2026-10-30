<script setup lang="ts">
import '../../css/home-workspace.css'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { AddressMapState } from '@/utils/addressMap'
import type { Coordinates } from '@/types/transport'
import { MapPin, MoveUpRight } from '@lucide/vue'
import PlaceLayout from '@/layouts/PlaceLayout.vue'
import SidebarResizeHandle from '@/components/SidebarResizeHandle.vue'
import { useSidebarWidth } from '@/composables/useSidebarWidth'
import { profileUrl } from '@/utils/metricDisplay'
import AddressPicker from '@/components/AddressPicker.vue'
import HomeWorkspaceMap from '@/components/home/HomeWorkspaceMap.vue'
import HomeTripsPanel from '@/components/home/HomeTripsPanel.vue'
import HomeTripCell from '@/components/home/HomeTripCell.vue'
import type { HomeResultView } from '@/types/homeResults'
import ComparisonShare from '@/components/ComparisonShare.vue'
import { useHomeTrips } from '@/composables/useHomeTrips'
import { useHomeLocation } from '@/composables/useHomeLocation'
import type { HomeTripsInput, HomeWorkspaceMapHandle, HomeMapContext, HomeTripMapSelection } from '@/types/homeWorkspace'
import TransportResults from '@/components/TransportResults.vue'
import { useHomeWorkspace } from '@/composables/useHomeWorkspace'
import HomeAddressResults from '@/components/home/HomeAddressResults.vue'
import type { AddressResult } from '@/types/address'
import type { SideKey } from '@/utils/comparison'
import type { MapLayerKey } from '@/types/mapLayers'
import type { AreaVisibility, LinearVisibility } from '@/types/profile'
import MapLayersPanel from '@/components/map/MapLayersPanel.vue'
import { useInterfacePreference } from '@/composables/useInterfacePreference'

const { isWorkspace } = useInterfacePreference()
const mobileView = ref<'results' | 'map'>('results')
const expandedResults = ref(false)
const workspaceScenario = ref<'addresses' | 'standalone' | 'stops'>('addresses')
const section = ref<HomeResultView>('overview')
const mapReady = ref(false)
const pendingTripFocus = ref<string | null>(null)
const mapView = ref<HomeWorkspaceMapHandle | null>(null)
async function changeMobileView(value: 'results' | 'map') {
    mobileView.value = value
    await nextTick()
    const target = document.getElementById(value === 'map' ? 'home-map-title' : workspaceScenario.value === 'standalone' && isWorkspace.value ? 'home-trips-title' : showPoint.value && point.value ? 'transport-title' : selectedSides.value.length ? 'home-address-title' : 'home-panel')
    if (target) {
        target.tabIndex = -1
        target.focus({ preventScroll: true })
        if (value === 'results' && isWorkspace.value && window.matchMedia('(max-width: 767px)').matches) target.scrollIntoView({ block: 'start' })
    }
}
function useMapCenter() {
    const coordinates = mapView.value?.centerPoint()
    if (coordinates) {
        const current = context.value
        if (isWorkspace.value && (current.kind === 'pick-start' || current.kind === 'pick-goal' || current.kind === 'pick-street')) selectTripMap({ context: current, point: coordinates })
        else if (!isWorkspace.value || current.kind === 'point' || current.kind === 'profile') selectMapPoint(coordinates)
    }
}
const workspace = ref<HTMLElement | null>(null)
const sidebar = reactive(useSidebarWidth(workspace, 'home'))
const home = useHomeWorkspace(selection => location.saveHome(selection))
const tripsInput: HomeTripsInput = {
    sides: home.sides, radius: home.radius, activeSide: home.activeSide, context: home.context,
    activate: home.activate,
    saveAddressTrips: (value, mode) => location.saveAddressTrips(value, mode),
    standaloneEffects: {
        saveSelection: (value, mode) => location.saveStandalone(value, mode),
        beginRun(reveal) {
            location.beginStandaloneRun()
            const intent = interactionEpoch
            return async isCurrent => {
                await nextTick()
                if (!reveal || !isCurrent() || intent !== interactionEpoch || !isWorkspace.value || section.value !== 'trips') return
                const result = document.querySelector<HTMLElement>('.home-trips .trip-result')
                if (result) { result.tabIndex = -1; result.focus({ preventScroll: true }); result.scrollIntoView({ block: 'nearest' }) }
            }
        },
    },
}
const trips = useHomeTrips(tripsInput)
const tripsPanel = ref<InstanceType<typeof HomeTripsPanel> | null>(null)
const location = useHomeLocation(home, trips, scenario => {
    if (scenario) { workspaceScenario.value = scenario; section.value = scenario === 'addresses' ? 'overview' : 'trips'; tripsPanel.value?.changeScenario(scenario) }
})
const { invalidPointLink, invalidPersonalLink } = location
let interactionEpoch = 0
function interacted() { interactionEpoch++ }
function focusSignature() { return JSON.stringify([home.context.value, trips.map.value?.trip, trips.map.value?.mode, trips.map.value?.overlay.sequence]) }
watch(focusSignature, () => { pendingTripFocus.value = null }, { flush: 'sync' })
async function finishTripFocus() {
    const intent = pendingTripFocus.value
    await nextTick()
    if (!mapReady.value || !intent || intent !== focusSignature() || pendingTripFocus.value !== intent) return
    pendingTripFocus.value = null
    await mapView.value?.focusTrip()
}
async function showTripMap(focus: boolean) {
    const intent = focusSignature()
    await changeMobileView('map')
    if (focus && intent === focusSignature()) { pendingTripFocus.value = intent; void finishTripFocus() }
}
function changeWorkspaceScenario(value: 'addresses' | 'standalone' | 'stops') {
    workspaceScenario.value = value
    if (value === 'stops') { section.value = 'surroundings'; home.showPoint() }
    else {
        tripsPanel.value?.changeScenario(value)
        section.value = value === 'standalone' ? 'trips' : 'overview'
        if (value === 'addresses') home.showSide(home.activeSide.value)
    }
}
function runTrips() { section.value = workspaceScenario.value === 'standalone' ? 'trips' : 'overview'; void changeMobileView('results') }
function changeSection(value: HomeResultView) {
    section.value = value
    if (value === 'surroundings') {
        if (workspaceScenario.value === 'stops') home.showPoint()
        else home.showSide(home.activeSide.value)
    } else if (workspaceScenario.value === 'stops') {
        workspaceScenario.value = 'addresses'
        tripsPanel.value?.changeScenario('addresses')
    }
}
function selectTripMap(selection: HomeTripMapSelection) {
    if (JSON.stringify(selection.context) !== JSON.stringify(context.value)) return
    const previous = context.value
    trips.selectMap(selection)
    if (selection.context.kind !== 'trip' && context.value !== previous && context.value.kind === 'trip') void changeMobileView('results')
}
function mapPoint(current: HomeMapContext, coordinates: Coordinates) {
    if (!isWorkspace.value) { selectMapPoint(coordinates); return }
    if (JSON.stringify(current) !== JSON.stringify(context.value) || !['point', 'profile'].includes(current.kind)) return
    selectMapPoint(coordinates)
}
function mapAddressSelected(side: SideKey, id: string) {
    if ((context.value.kind === 'profile' && context.value.side === side || !isWorkspace.value) && side === activeSide.value) picker.value?.selectObjectById(id)
}
function mapAddressHighlighted(side: SideKey, id: string | null) {
    if (side === activeSide.value && ['profile', 'point'].includes(context.value.kind)) picker.value?.highlightObjectById(id)
}
function mapObject(selection: { layer: MapLayerKey; id: string } | null) {
    if (['profile', 'point'].includes(context.value.kind)) selectedObject.value = selection
}
function mapStop(id: number | null) {
    if (!['profile', 'point'].includes(context.value.kind)) return
    if (profile.value) profileStop.value = id
    else selectedStopId.value = id
}
const { radius, sides, activeSide, context, choice: addressChoice, searchResetKey, selectedSides, setRadius } = home
const { point, analysis, status, selectedStopId } = home.transport
watch(context, value => { if (value.kind === 'point') { workspaceScenario.value = 'stops'; section.value = 'surroundings' } }, { immediate: true })
const showPoint = computed(() => !isWorkspace.value || context.value.kind === 'point')
const profile = computed(() => isWorkspace.value && context.value.kind === 'profile' && !addressChoice.value.groups.length ? sides[activeSide.value].profile : null)
const mapAddress = computed<AddressResult | null>(() => profile.value ? {
    id: profile.value.address.id, label: profile.value.address.label, match_type: 'exact', object_count: 1,
    bounds: profile.value.address.bounds, objects: [profile.value.address.object],
} : null)
const mapFocus = ref<{ layer: MapLayerKey; id?: string; sequence: number } | null>(null)
const selectedObject = ref<{ layer: MapLayerKey; id: string } | null>(null)
const profileStop = ref<number | null>(null)
const areas = ref<AreaVisibility>({ parks: false, vegetation: false, water: false })
const lines = ref<LinearVisibility>({ roads: false, railways: false })
const showStops = ref(false)
watch([profile, context], () => { mapFocus.value = null; selectedObject.value = null; profileStop.value = null })
watch(showStops, visible => { if (!visible) profileStop.value = null })
async function focusLayer(side: SideKey, layer: MapLayerKey, id?: string) {
    // Keep the selected pair and its results; only the map's active side changes.
    if (context.value.kind !== 'profile' || activeSide.value !== side || addressChoice.value.groups.length) home.showSide(side)
    if (layer === 'stops') showStops.value = true
    else if (layer === 'roads' || layer === 'railways') lines.value = { ...lines.value, [layer]: true }
    else areas.value = { ...areas.value, [layer]: true }
    await nextTick()
    mapFocus.value = { layer, id, sequence: (mapFocus.value?.sequence ?? 0) + 1 }
    void changeMobileView('map')
}
async function selectProfileStop(side: SideKey, id: number) {
    await focusLayer(side, 'stops', String(id))
    profileStop.value = id
}
function selectStop(id: number) {
    if (profile.value) void selectProfileStop(activeSide.value, id)
    else { selectedStopId.value = id; mapFocus.value = { layer: 'stops', id: String(id), sequence: (mapFocus.value?.sequence ?? 0) + 1 } }
}
watch([point, context, selectedSides], () => { document.title = showPoint.value && point.value ? 'Остановки вокруг точки — PlaceLens' : selectedSides.value.length ? 'Профиль и сравнение адресов — PlaceLens' : 'Сравните окружение адресов — PlaceLens' }, { immediate: true })
const picker = ref<InstanceType<typeof AddressPicker> | null>(null)
function previewAddresses(state: AddressMapState) {
    addressChoice.value = state
    if (!isWorkspace.value && state.groups.length && point.value) home.resetPoint(false)
}
function confirmAddress(id: string) {
    if (!isWorkspace.value) window.location.assign(profileUrl(id, radius.value))
    else { workspaceScenario.value = 'addresses'; home.chooseAddress(id); section.value = 'overview'; void changeMobileView('results') }
}
async function editAddress(side: SideKey) {
    workspaceScenario.value = 'addresses'
    home.editSide(side)
    await nextTick()
    document.querySelector<HTMLInputElement>('#home-panel input[role="combobox"]')?.focus()
}
function selectMapPoint(coordinates: Coordinates) {
    if (isWorkspace.value) workspaceScenario.value = 'stops'
    section.value = 'surroundings'
    void home.selectPoint(coordinates)
    mobileView.value = 'results'
    if (isWorkspace.value && window.matchMedia('(max-width: 767px)').matches) void changeMobileView('results')
}
function resetSelection() { home.resetPoint() }
</script>

<template>
    <PlaceLayout>
        <main @pointerdown.capture="interacted" @keydown.capture="interacted" id="main-content" tabindex="-1" ref="workspace" class="placelens-workspace" :class="{ 'is-resizable': sidebar.enabled && !isWorkspace, 'sidebar-is-resizing': sidebar.dragging, 'home-v2': isWorkspace, 'home-show-map': mobileView === 'map', 'has-point': !!point || selectedSides.length > 0 || section === 'trips', 'home-results-expanded': expandedResults }" :style="sidebar.style">
            <div v-if="isWorkspace" class="home-mobile-views" role="group" aria-label="Рабочая область">
                <button type="button" :aria-pressed="mobileView === 'results'" @click="changeMobileView('results')">Результаты и ввод</button>
                <button type="button" :aria-pressed="mobileView === 'map'" @click="changeMobileView('map')">Карта</button>
                <p v-if="showPoint && point" class="home-point-context">Выбрана точка · {{ radius }} м по прямой</p>
            </div>
            <aside id="home-panel" tabindex="-1" class="place-panel" :aria-labelledby="isWorkspace ? 'home-selection-title' : point ? 'transport-title' : 'search-title'">
                <div class="place-panel-content" :class="{ 'has-analysis': point || addressChoice.groups.length }">
                    <section v-if="isWorkspace" class="home-selection-heading">
                        <p class="home-eyebrow">КРАСНОЯРСК · ЛОКАЛЬНЫЕ ДАННЫЕ</p>
                        <h1 id="home-selection-title">Места и цели</h1>
                        <div class="home-scenario-nav" role="group" aria-label="Сценарий">
                            <button type="button" :aria-pressed="workspaceScenario === 'addresses'" @click="changeWorkspaceScenario('addresses')">Адреса</button>
                            <button type="button" :aria-pressed="workspaceScenario === 'standalone'" @click="changeWorkspaceScenario('standalone')">Отдельная поездка</button>
                            <button type="button" :aria-pressed="workspaceScenario === 'stops'" @click="changeWorkspaceScenario('stops')">Остановки</button>
                        </div>
                    </section>
                    <section v-if="!isWorkspace && !point && !addressChoice.groups.length" class="place-intro">
                        <div class="intro-eyebrow"><span class="h-px w-6 bg-[#51836b]" /> ВЫБИРАЕТЕ ЖИЛЬЁ В КРАСНОЯРСКЕ</div>
                        <h1 id="intro-title">Сравните окружение<br class="hidden md:block" /> адресов.</h1>
                        <p>Остановки, парки, вода и дороги рядом. Найдите адрес, изучите окружение и добавьте второй вариант для сравнения.</p>
                    </section>

                    <ComparisonShare v-if="isWorkspace" :address-url="location.ordinaryUrl.value" :personal-url="location.personalUrl.value" />
                    <section v-if="isWorkspace" v-show="workspaceScenario === 'addresses'" class="home-address-selection" aria-label="Выбранные адреса">
                        <div v-for="side in (['left', 'right'] as const)" :key="side" class="home-address-slot" :aria-label="`Адрес ${side === 'left' ? 'А' : 'Б'}`">
                            <h2><span class="home-side-badge" :class="{ 'is-b': side === 'right' }">{{ side === 'left' ? 'А' : 'Б' }}</span><span>{{ sides[side].knownAddress?.label ?? sides[side].id ?? 'Адрес не выбран' }}</span></h2>
                            <button v-if="sides[side].id" type="button" :aria-pressed="context.kind === 'profile' && activeSide === side" @click="changeSection('overview'); home.showSide(side)">Показать {{ side === 'left' ? 'А' : 'Б' }}</button>
                            <button type="button" @click="editAddress(side)">{{ sides[side].id ? 'Заменить адрес' : 'Добавить адрес' }} {{ side === 'left' ? 'А' : 'Б' }}</button>
                            <button v-if="sides[side].id" type="button" @click="home.removeSide(side)">Убрать {{ side === 'left' ? 'А' : 'Б' }}</button>
                        </div>
                        <fieldset v-if="selectedSides.length && !showPoint" class="home-radius"><legend>Радиус окружения</legend><button v-for="value in [300, 500]" :key="value" type="button" :aria-pressed="radius === value" @click="setRadius(value)">{{ value }} м</button></fieldset>
                    </section>
                    <details v-show="!isWorkspace || workspaceScenario === 'addresses' && home.searching.value" class="home-search-panel" :class="{ 'home-search-panel--point': point }" :open="isWorkspace || !point">
                        <summary v-show="point">Найти адрес вместо точки</summary>
                    <section class="place-search" aria-labelledby="search-title">
                        <component :is="isWorkspace ? 'h2' : 'h1'" v-if="addressChoice.groups.length" id="search-title" class="text-lg font-semibold">Выберите объект адреса</component>
                        <h2 v-else id="search-title">{{ isWorkspace ? `Найти адрес ${activeSide === 'left' ? 'А' : 'Б'}` : point ? 'Найти адрес вместо точки' : 'С какого адреса начнём?' }}</h2>
                        <AddressPicker ref="picker" :selected-id="sides[activeSide].id" :reset-key="searchResetKey" external-map @select="confirmAddress" @map-state="previewAddresses" />
                    </section>
                    </details>
                    <div v-if="isWorkspace" v-show="workspaceScenario === 'stops'" class="home-point-choice">
                        <h2>{{ point ? 'Выбрана произвольная точка' : 'Остановки вокруг точки' }}</h2>
                        <p>{{ point ? 'Анализ точки относится к координате. Выбранные А/Б сохранены отдельно.' : 'Нажмите на карту или выберите её центр с клавиатуры.' }}</p>
                        <button type="button" @click="section = 'surroundings'; home.showPoint(); changeMobileView('map')">{{ point ? 'Изменить точку на карте' : 'Выбрать точку на карте' }}</button>
                    </div>
                    <div v-show="isWorkspace && workspaceScenario !== 'stops'" id="home-trip-editor" />
                    <p v-if="!isWorkspace && !point && !addressChoice.groups.length" class="home-compare-note">Уже знаете оба адреса? <a href="/compare" class="result-action">Перейти к сравнению →</a><span class="block mt-2">Без регистрации · расстояния по прямой</span></p>
                    <p v-if="invalidPointLink" class="result-notice mt-3 text-sm" role="alert">Некорректная ссылка на точку: нужны координаты WGS84 и радиус 300 или 500 м. Выберите точку на карте или найдите адрес через поиск.</p>

                    <div v-if="!isWorkspace && !point && !addressChoice.groups.length" class="explore-hint">
                        <span class="explore-hint-icon"><MoveUpRight class="size-4" aria-hidden="true" /></span>
                        <p>Нажмите на карту, чтобы узнать<br /> об остановках вокруг точки.</p>
                    </div>
                    <Teleport to="#home-workspace-results" :disabled="!isWorkspace" defer>
                        <TransportResults v-if="point" v-show="showPoint && (!isWorkspace || section === 'surroundings')" :radius="radius" :selected-stop-id="selectedStopId" @radius="setRadius" @select-stop="selectStop" :point="point" :analysis="analysis" :status="status" @retry="home.transport.retry" @reset="resetSelection" />
                    </Teleport>
                </div>

                <div v-if="!isWorkspace" class="place-panel-footer">
                    <MapPin class="size-5 shrink-0 text-[#51836b]" aria-hidden="true" />
                    <p>Выберите адрес для профиля<br /> или точку для поиска остановок.</p>
                </div>
            </aside>

            <SidebarResizeHandle v-if="sidebar.enabled && !isWorkspace" :width="sidebar.width" :min="sidebar.bounds.min" :max="sidebar.bounds.max" controls="home-panel" @start="sidebar.pointerDown" @move="sidebar.pointerMove" @end="sidebar.pointerEnd" @key="sidebar.keydown" @reset="sidebar.reset" />
            <section class="placelens-map" aria-label="Карта Красноярска">
                <div v-if="isWorkspace" class="home-map-heading"><h2 id="home-map-title" tabindex="-1">{{ addressChoice.groups.length ? 'Объекты найденных адресов' : 'Карта Красноярска' }}</h2><button type="button" @click="useMapCenter">Выбрать центр карты</button><MapLayersPanel v-if="isWorkspace && profile" v-model:stops="showStops" v-model:areas="areas" v-model:lines="lines" :contexts="[{ key: activeSide, label: activeSide === 'left' ? 'А' : 'Б', profile, loading: false }]" floating single-map @focus-layer="focusLayer(activeSide, $event)" /></div>

                <HomeWorkspaceMap ref="mapView" :context="isWorkspace ? context : { kind: 'point' }" :active-side="activeSide" :radius="radius" :point="point" :profile="profile" :analysis="analysis" :address="mapAddress" :choice="addressChoice" :selected-stop-id="profile ? profileStop : selectedStopId" :selected-object="selectedObject" :show-stops="showStops" :areas="areas" :lines="lines" :focus="mapFocus" :trip="isWorkspace ? trips.map.value : null"
                    @point="mapPoint" @address="mapAddressSelected" @highlight-address="mapAddressHighlighted" @stop="mapStop" @object="mapObject" @street="selectTripMap" @ready="mapReady = true; finishTripFocus()" />
            </section>
            <section v-show="isWorkspace" class="home-results-area" aria-label="Результаты выбранного места">
                <div v-show="workspaceScenario !== 'addresses'" class="home-results-toolbar"><span>{{ showPoint && point ? 'Остановки рядом · по прямой' : 'Поездки' }}</span><button v-if="point || selectedSides.length || section === 'trips'" type="button" :aria-expanded="expandedResults" aria-controls="home-workspace-results" @click="expandedResults = !expandedResults">{{ expandedResults ? 'Свернуть результаты' : 'Развернуть результаты' }}</button></div>
                <div id="home-workspace-results" class="home-results-content">
                    <p v-if="invalidPersonalLink" role="alert">Общие цели из ссылки не восстановлены: формат, версия или размер не поддерживаются.</p>
                    <HomeTripsPanel ref="tripsPanel" :model="trips" :input="tripsInput" :editor-target="isWorkspace ? '#home-trip-editor' : undefined" @scenario="workspaceScenario = $event" @run="runTrips" @show-map="showTripMap">
                        <template #results="{ entries, actions, scenario }">
                            <HomeAddressResults v-if="scenario === 'addresses'" v-show="isWorkspace && !showPoint" :view="section" :expanded="expandedResults" :model="home" :trips="trips" :entries="entries" :actions="actions" :selected-stop-id="profileStop" :selected-object="selectedObject" @expand="expandedResults = !expandedResults" @update:view="changeSection" @select-stop="selectProfileStop" @focus-layer="focusLayer" />
                            <div v-else v-show="isWorkspace && workspaceScenario === 'standalone'"><h2 id="home-trips-title" tabindex="-1">Поездки</h2><p>{{ trips.addresses.mode.value === 'walking' ? 'Модель уличной части · подходы неизвестны' : 'Автомодель · без пробок, подходов и парковки' }}</p><HomeTripCell v-for="entry in entries" :key="JSON.stringify(entry.trip)" :entry="entry" :actions="actions" :mode="trips.addresses.mode.value" /></div>
                        </template>
                    </HomeTripsPanel>
                </div>
            </section>
        </main>
    </PlaceLayout>
</template>

<style>
.home-mobile-views,.home-selection-heading,.home-point-choice,.home-map-heading{display:none}
.workspace-interface:has(.home-v2){min-height:0;height:100dvh;overflow:hidden}
.home-v2.placelens-workspace{width:100%;min-width:0;min-height:0;grid-template-columns:300px minmax(0,1fr);grid-template-rows:minmax(170px,1fr) 150px}
.home-v2.has-point{grid-template-rows:minmax(170px,1fr) minmax(170px,42%)}
.home-v2.home-results-expanded.has-point{grid-template-rows:minmax(250px,35%) minmax(170px,1fr)}
.home-v2 .place-panel{grid-column:1;grid-row:1/3;gap:16px;background:#fcfdf9;overscroll-behavior:contain}
.home-v2 .place-panel-content{padding:22px 18px 16px}
.home-v2 .place-panel-footer{margin:0 18px 18px}
.home-v2 .place-panel-footer p{font-size:12px}
.home-v2 .home-selection-heading{display:block;margin-bottom:22px}
.home-selection-heading :is(h1,h2){font-size:23px;line-height:1.2;font-weight:600;letter-spacing:-.4px;margin-bottom:10px}
.home-selection-heading>p:last-child{font-size:13px;line-height:1.6;color:#637769}
.home-eyebrow{font-size:10px;font-weight:600;letter-spacing:.12em;color:#637769;margin-bottom:10px}
.home-v2 .place-search{margin-top:0}
.home-v2 .search-box{height:48px;border-radius:9px}
.home-v2 .search-availability{font-size:11px}
.home-v2 .home-point-choice{display:block;margin-top:20px;padding-top:16px;border-top:1px solid #dce4d9}
.home-point-choice h2{font-size:14px;font-weight:600}
.home-point-choice p{font-size:12px;line-height:1.6;margin:7px 0;color:#637769}
.home-v2 :is(.home-point-choice,.home-map-heading,.home-results-toolbar,.home-mobile-views) button{min-height:44px;padding:7px 10px;border:1px solid #cbdace;border-radius:7px;font-size:12px;background:#fff;color:#2d6450}
.home-v2 .placelens-map{grid-column:2;grid-row:1;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.home-v2 .home-map-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;background:#fcfdf9;border-bottom:1px solid #dce4d9;flex:none}
.home-map-heading h2{font-size:12px;font-weight:600}
.home-v2 .placelens-map>.city-map{position:relative;inset:auto;flex:1;min-height:0}
.home-v2 .city-map-center{display:none}
.home-v2 .home-results-area{grid-column:2;grid-row:2;display:flex;flex-direction:column;min-height:0;min-width:0;background:#fcfdf9;border-top:1px solid #cbdace}
.home-results-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 16px;border-bottom:1px solid #e4e9e1;flex:none;font-size:12px;font-weight:600;min-height:40px}
.home-v2 .home-results-toolbar button{min-height:32px}
.home-results-content{flex:1;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;scroll-padding:12px;padding:16px 22px}
.home-empty-result h2{font-size:16px;font-weight:600;margin-bottom:6px}
.home-empty-result p{font-size:13px;line-height:1.6;color:#637769;max-width:650px}
.home-v2 .transport-results{margin:0;padding:0 0 12px;border:0}
.home-v2 .transport-results>dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.home-v2 .transport-results>dl>div{margin:0}
.home-v2 .transport-results>ul{max-height:none;overflow:visible;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));align-items:start;gap:8px}
.home-v2 .transport-results>ul>li{margin:0}
@media(min-width:768px){.home-v2 .home-point-choice button{width:100%}}
@media(max-width:767px){
    .home-v2.placelens-workspace{display:block;overflow-y:auto;overscroll-behavior:contain}
    .home-v2 .home-mobile-views{display:flex;flex-wrap:wrap;gap:6px;padding:7px 12px;background:#fcfdf9;border-bottom:1px solid #dce4d9;position:sticky;top:0;z-index:5}
    .home-v2 .home-mobile-views button{flex:1}
    .home-point-context{flex-basis:100%;font-size:11px;color:#637769}
    .home-v2 .home-mobile-views button[aria-pressed=true]{color:white;background:#2d6450;border-color:#2d6450}
    .home-v2 .place-panel{overflow:visible;border:0}
    .home-v2 .place-panel-content{padding:18px 16px}
    .home-v2 .home-selection-heading{margin-bottom:16px}
    .home-v2 .placelens-map{display:none;min-height:0}
    .home-v2 .home-results-area{min-height:0}
    .home-v2 .home-results-content{overflow:visible;padding:16px}
    .home-v2 #transport-title{scroll-margin-top:90px}
    .home-v2 .home-results-toolbar>button{display:none}
    .home-v2 .transport-results>dl{grid-template-columns:1fr}
    .home-v2 .transport-results>ul{display:block}
    .home-v2 .transport-results>ul>li+li{margin-top:8px}
    .home-v2.home-show-map{display:flex;flex-direction:column;overflow:hidden}
    .home-v2.home-show-map .home-mobile-views{position:static;flex:none}
    .home-v2.home-show-map .place-panel,.home-v2.home-show-map .home-results-area{display:none}
    .home-v2.home-show-map .placelens-map{display:flex;flex:1;min-height:0}
    .home-v2 .home-map-heading{padding:4px 8px}
    .home-map-heading h2{font-size:11px}
}
</style>

<style scoped>
.home-v2 .home-address-selection{margin-bottom:16px}.home-address-slot{padding:10px 0;border-bottom:1px solid #dce4d9;overflow-wrap:anywhere}.home-address-slot h2{font-size:13px;font-weight:600}.home-address-slot button,.home-radius button{min-height:44px;padding:7px;margin:4px 4px 0 0;border:1px solid #cbdace;border-radius:6px;font-size:12px}.home-address-slot button[aria-pressed=true],.home-radius button[aria-pressed=true]{background:#eaf2df}.home-radius{margin-top:12px;font-size:12px}.home-v2 :is(button,summary,input):focus-visible{outline:3px solid #2d6450;outline-offset:2px}
</style>
