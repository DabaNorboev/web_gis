<script setup lang="ts">
import '../../css/home-workspace.css'
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
import type { AddressMapState } from '@/utils/addressMap'
import type { Coordinates } from '@/types/transport'
import { MapPin, MoveUpRight } from '@lucide/vue'
import PlaceLayout from '@/layouts/PlaceLayout.vue'
import SidebarResizeHandle from '@/components/SidebarResizeHandle.vue'
import { useSidebarWidth } from '@/composables/useSidebarWidth'
import { profileUrl } from '@/utils/metricDisplay'
import AddressPicker from '@/components/AddressPicker.vue'
import HomeWorkspaceMap from '@/components/home/HomeWorkspaceMap.vue'
import { useHomeOrientations } from '@/composables/useHomeOrientations'
import type { HomeOrientationContext, HomeOrientationTarget } from '@/types/homeOrientations'
import HomeTripsPanel from '@/components/home/HomeTripsPanel.vue'
import HomeTripCell from '@/components/home/HomeTripCell.vue'
import HomeMapDetails from '@/components/home/HomeMapDetails.vue'
import { homeMapEntity, homeMapOverview, sameHomeTrip } from '@/utils/homeMap'
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
type MobileView = 'results' | 'map' | 'settings'
const mobileView = ref<MobileView>('settings')
const mobileQuery = window.matchMedia('(max-width: 767px)')
const isMobile = ref(mobileQuery.matches)
const mobileScreens = [{ id: 'results', label: 'Сравнение', panel: 'home-results-screen' }, { id: 'map', label: 'Карта', panel: 'home-map-screen' }, { id: 'settings', label: 'Настройки', panel: 'home-panel' }] as const
const screenScroll: Record<MobileView, number> = { results: 0, map: 0, settings: 0 }
let mapSurfaceScroll = 0
let navigationIntent = 0
function screenElement(value: MobileView) {
    return document.querySelector<HTMLElement>(value === 'results' ? '#home-workspace-results' : value === 'settings' ? '#home-panel' : '.home-map-heading')
}
function rememberScreen(leavingWorkspace = false) {
    if (!isMobile.value || !isWorkspace.value && !leavingWorkspace) return
    screenScroll[mobileView.value] = screenElement(mobileView.value)?.scrollTop ?? 0
    if (mobileView.value === 'map') mapSurfaceScroll = document.getElementById('home-map-screen')?.scrollTop ?? 0
}
function restoreScreen() {
    const element = screenElement(mobileView.value)
    if (element) element.scrollTop = screenScroll[mobileView.value]
    const mapScreen = document.getElementById('home-map-screen')
    if (mobileView.value === 'map' && mapScreen) mapScreen.scrollTop = mapSurfaceScroll
}
function mobileTabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = mobileScreens.findIndex(screen => screen.id === mobileView.value)
    const next = mobileScreens[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3]!
    void changeMobileView(next.id, true)
}
function breakpointChanged(event: MediaQueryListEvent) {
    rememberScreen(); isMobile.value = event.matches
}
onMounted(() => mobileQuery.addEventListener('change', breakpointChanged))
onBeforeUnmount(() => mobileQuery.removeEventListener('change', breakpointChanged))
watch(isWorkspace, (value, previous) => { if (previous && !value) rememberScreen(true) }, { flush: 'sync' })
watch([isMobile, isWorkspace], async () => {
    navigationIntent++
    interacted()
    pendingTripFocus.value = null
    await nextTick()
    if (isMobile.value && isWorkspace.value) restoreScreen()
    if (!isWorkspace.value) document.querySelectorAll<HTMLDialogElement>('main dialog[open]').forEach(dialog => dialog.close())
    await nextTick()
    const active = document.activeElement as HTMLElement | null
    if (active && (!active.getClientRects().length || active.closest('[inert]'))) document.getElementById('main-content')?.focus({ preventScroll: true })
}, { flush: 'post' })
const expandedResults = ref(false)
const workspaceScenario = ref<'addresses' | 'standalone' | 'stops'>('addresses')
const section = ref<HomeResultView>('overview')
const expandedMap = ref(false)
const mapScope = ref<'all' | 'one'>('all')
const mapDetailsRequest = ref(0)
let mapReturnAction: HTMLElement | null = null
let mapReturnReading: { section: HomeResultView; offset: number } | null = null
let mapDetailTrigger: HTMLElement | null = null
const mapReady = ref(false)
const pendingTripFocus = ref<string | null>(null)
const mapView = ref<HomeWorkspaceMapHandle | null>(null)
async function changeMobileView(value: MobileView, navigation = false) {
    rememberScreen()
    if (value !== 'map') pendingTripFocus.value = null
    const intent = ++navigationIntent
    mobileView.value = value
    await nextTick()
    if (intent !== navigationIntent || !isWorkspace.value) return
    if (isMobile.value) restoreScreen()
    const target = document.getElementById(navigation ? `home-mobile-${value}` : value === 'settings' ? 'home-selection-title' : value === 'map' ? 'home-map-title' : workspaceScenario.value === 'standalone' ? 'home-trips-title' : showPoint.value && point.value ? 'transport-title' : selectedSides.value.length ? 'home-address-title' : 'home-results-screen')
    if (target && target.getClientRects().length) { target.tabIndex = -1; target.focus({ preventScroll: true }); if (navigation) target.tabIndex = 0 }
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
// Page-local layout preferences never change analytical state or camera.
const panelCollapsed = ref(false)
let panelFocus: HTMLElement | null = null
const layoutHeight = ref(720)
const preferredMapHeight = ref<number | null>(null)
const mapHeightMax = computed(() => Math.max(180, layoutHeight.value - 192))
const mapHeight = computed(() => Math.round(Math.max(180, Math.min(mapHeightMax.value, preferredMapHeight.value ?? 480))))
const mapDragging = ref(false)
let heightDrag: { id: number; y: number; height: number } | null = null
let layoutObserver: ResizeObserver | undefined
onMounted(() => {
    layoutObserver = new ResizeObserver(() => { layoutHeight.value = workspace.value?.clientHeight ?? 720 })
    if (workspace.value) layoutObserver.observe(workspace.value)
})
onBeforeUnmount(() => layoutObserver?.disconnect())
async function togglePanel() {
    if (!panelCollapsed.value) panelFocus = document.querySelector<HTMLElement>('#home-panel :focus') ?? panelFocus
    panelCollapsed.value = !panelCollapsed.value
    await nextTick()
    if (!panelCollapsed.value && panelFocus?.isConnected) panelFocus.focus({ preventScroll: true })
    else document.getElementById('home-panel-toggle')?.focus({ preventScroll: true })
}
function setMapHeight(value: number) {
    expandedMap.value = false; expandedResults.value = false
    preferredMapHeight.value = Math.max(180, Math.min(mapHeightMax.value, value))
}
function heightStart(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    target.focus(); target.setPointerCapture(event.pointerId)
    heightDrag = { id: event.pointerId, y: event.clientY, height: mapHeight.value }
    mapDragging.value = true
}
function heightMove(event: PointerEvent) {
    if (heightDrag?.id === event.pointerId) setMapHeight(heightDrag.height + event.clientY - heightDrag.y)
}
function heightEnd(event: PointerEvent) {
    if (heightDrag?.id === event.pointerId) { heightDrag = null; mapDragging.value = false }
}
function heightKey(event: KeyboardEvent) {
    const step = event.shiftKey ? 48 : 16
    if (event.key === 'ArrowUp') setMapHeight(mapHeight.value - step)
    else if (event.key === 'ArrowDown') setMapHeight(mapHeight.value + step)
    else if (event.key === 'Home') setMapHeight(180)
    else if (event.key === 'End') setMapHeight(mapHeightMax.value)
    else return
    event.preventDefault()
}
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
                if (!reveal || !isCurrent() || intent !== interactionEpoch || !isWorkspace.value || section.value !== 'trips' || isMobile.value && mobileView.value !== 'results') return
                const result = document.querySelector<HTMLElement>('.home-trips .trip-result')
                if (result) { result.tabIndex = -1; result.focus({ preventScroll: true }); result.scrollIntoView({ block: 'nearest' }) }
            }
        },
    },
}
const trips = useHomeTrips(tripsInput)
const orientations = useHomeOrientations(home, trips)
const selectedMapTrip = computed(() => home.context.value.kind === 'trip' ? home.context.value.trip : null)
const overviewEnabled = computed(() => isWorkspace.value && workspaceScenario.value === 'addresses'
    && (home.selectedSides.value.length > 1 || trips.addresses.places.value.length > 0) && !home.choice.value.groups.length
    && section.value !== 'surroundings' && home.context.value.kind !== 'point'
    && !['pick-start', 'pick-goal', 'pick-street'].includes(home.context.value.kind)
    && !(home.context.value.kind === 'trip' && home.context.value.trip.scenario === 'standalone'))
const overview = computed(() => overviewEnabled.value ? homeMapOverview(trips.overview.value, trips.addresses.places.value, orientations.groups.value,
    selectedMapTrip.value, mapScope.value, trips.map.value, (['left', 'right'] as const).flatMap(side => {
        const value = home.sides[side]
        return value.id && value.status === 'ready' && value.profile?.address.id === value.id ? [{ side, id: value.id, point: value.profile.point }] : []
    })) : null)
watch(selectedMapTrip, value => { if (!value) { mapScope.value = 'all'; mapReturnAction = null; mapReturnReading = null } }, { flush: 'sync' })
function selectMapEntity(id: string) {
    if (!overview.value?.interactive) return
    const marker = overview.value.markers?.find(marker => marker.id === id)
    if (marker && marker.shape !== 'goal') { home.showSide(marker.shape); return }
    const entity = marker?.entity ?? id
    const value = trips.overview.value.find(value => homeMapEntity(value) === entity)
    if (!value) return
    mapReturnAction = null
    mapReturnReading = null
    mapDetailTrigger = document.activeElement as HTMLElement
    home.activate({ kind: 'trip', trip: value.trip })
    mapDetailsRequest.value++
}
function closeMapDetails() {
    const target = mapDetailTrigger?.isConnected ? mapDetailTrigger : selectedMapTrip.value
        ? document.querySelector<HTMLElement>('.placelens-map .city-trip-marker.is-selected') ?? document.querySelector<HTMLElement>('.placelens-map canvas') : null
    if (target?.getClientRects().length && !target.closest('[inert]')) target.focus({ preventScroll: true })
    else document.getElementById('main-content')?.focus({ preventScroll: true })
}
async function returnToTripRow() {
    mapDetailTrigger = null
    const trip = selectedMapTrip.value
    if (!trip) return
    const origin = mapReturnAction, reading = mapReturnReading
    mapReturnAction = null; mapReturnReading = null
    const intent = navigationIntent + 1
    section.value = reading?.section ?? 'trips'
    expandedMap.value = false
    await changeMobileView('results')
    await nextTick()
    const cell = [...document.querySelectorAll<HTMLElement>('[data-home-trip]')].find(element => element.dataset.homeTrip === JSON.stringify(trip) && !element.closest('dialog'))
    if (!cell || intent !== navigationIntent || !cell.getClientRects().length) return
    const target = origin?.isConnected && cell.contains(origin) ? origin : cell.querySelector<HTMLElement>('[data-home-map-action]') ?? cell
    target.tabIndex = target.matches('button,a,input,select,summary') ? target.tabIndex : -1
    target.focus({ preventScroll: true })
    const scroller = screenElement('results')
    if (reading && scroller) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - reading.offset
    target.scrollIntoView({ block: 'nearest' })
    rememberScreen()
}
provide<HomeOrientationContext>('home-orientations', { owner: orientations, enabled: isWorkspace,
    edit: target => { if (target.kind === 'trip') void editTripGoal(target) },
})
const tripsPanel = ref<InstanceType<typeof HomeTripsPanel> | null>(null)
async function editTripGoal(target: Extract<HomeOrientationTarget, { kind: 'trip' }>) {
    panelCollapsed.value = false
    workspaceScenario.value = target.scenario
    const intent = navigationIntent + 1
    await changeMobileView('settings')
    if (intent !== navigationIntent || !isWorkspace.value) return
    await tripsPanel.value?.editGoal(target.scenario, target.placeId)
}
const location = useHomeLocation(home, trips, scenario => {
    mobileView.value = home.selectedSides.value.length || home.transport.point.value || scenario ? 'results' : 'settings'
    if (scenario) { workspaceScenario.value = scenario; section.value = scenario === 'addresses' ? 'overview' : 'trips'; tripsPanel.value?.changeScenario(scenario) }
})
const { invalidPointLink, invalidPersonalLink } = location
let interactionEpoch = 0
function interacted() { interactionEpoch++ }
function focusSignature() { return JSON.stringify([workspaceScenario.value, home.context.value, trips.map.value?.trip, trips.map.value?.mode, trips.map.value?.overlay.sequence, overviewEnabled.value ? trips.overview.value.map(homeMapEntity) : null, overview.value?.markers?.map(marker => marker.id) ?? null, mapScope.value]) }
watch(focusSignature, () => { pendingTripFocus.value = null }, { flush: 'sync' })
async function finishTripFocus() {
    const intent = pendingTripFocus.value
    await nextTick()
    if (!mapReady.value || !intent || intent !== focusSignature() || pendingTripFocus.value !== intent) return
    pendingTripFocus.value = null
    await mapView.value?.focusTrip()
}
async function showTripMap(focus: boolean) {
    const action = document.activeElement as HTMLElement | null
    if (action?.closest('[data-home-trip]')) {
        mapReturnAction = action
        mapReturnReading = { section: section.value, offset: action.getBoundingClientRect().top - (screenElement('results')?.getBoundingClientRect().top ?? 0) }
    }
    if (focus && selectedMapTrip.value) mapScope.value = 'one'
    const intent = focusSignature()
    const navigation = navigationIntent + 1
    await changeMobileView('map')
    if (focus && navigation === navigationIntent && intent === focusSignature()) { pendingTripFocus.value = intent; void finishTripFocus() }
}
async function fitCurrentMap() {
    mapScope.value = 'all'
    const intent = focusSignature()
    const navigation = navigationIntent + 1
    await changeMobileView('map')
    if (navigation === navigationIntent && intent === focusSignature()) { pendingTripFocus.value = intent; void finishTripFocus() }
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
async function runTrips() {
    section.value = workspaceScenario.value === 'standalone' ? 'trips' : 'overview'
    screenScroll.results = 0
    await changeMobileView('results')
    if (mobileView.value === 'results') { const result = screenElement('results'); if (result) result.scrollTop = 0 }
}
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
    if (selection.context.kind !== 'trip' && context.value !== previous && context.value.kind === 'trip') void changeMobileView(selection.context.kind === 'pick-street' ? 'results' : 'settings')
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
    const intent = navigationIntent, address = sides[side].id
    section.value = 'surroundings'
    // Keep the selected pair and its results; only the map's active side changes.
    if (context.value.kind !== 'profile' || activeSide.value !== side || addressChoice.value.groups.length) home.showSide(side)
    if (layer === 'stops') showStops.value = true
    else if (layer === 'roads' || layer === 'railways') lines.value = { ...lines.value, [layer]: true }
    else areas.value = { ...areas.value, [layer]: true }
    const expectedContext = JSON.stringify(context.value)
    await nextTick()
    if (intent !== navigationIntent || expectedContext !== JSON.stringify(context.value) || sides[side].id !== address || !isWorkspace.value) return false
    mapFocus.value = { layer, id, sequence: (mapFocus.value?.sequence ?? 0) + 1 }
    await changeMobileView('map')
    return navigationIntent === intent + 1 && expectedContext === JSON.stringify(context.value) && sides[side].id === address
}
async function selectProfileStop(side: SideKey, id: number) {
    if (await focusLayer(side, 'stops', String(id))) profileStop.value = id
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
function focusChosenPoint(point: Coordinates) {
    if (isWorkspace.value) { pendingTripFocus.value = null; mapView.value?.focusPoint(point) }
}
function confirmAddress(id: string) {
    if (!isWorkspace.value) window.location.assign(profileUrl(id, radius.value))
    else { workspaceScenario.value = 'addresses'; home.chooseAddress(id); section.value = 'overview'; void changeMobileView('results') }
}
async function editAddress(side: SideKey) {
    workspaceScenario.value = 'addresses'
    home.editSide(side)
    const intent = navigationIntent + 1
    await changeMobileView('settings')
    const field = document.querySelector<HTMLInputElement>('#home-panel input[role="combobox"]')
    if (intent === navigationIntent && isWorkspace.value && activeSide.value === side && field?.getClientRects().length && !field.closest('[inert]')) field.focus()
}
function selectMapPoint(coordinates: Coordinates) {
    if (isWorkspace.value) workspaceScenario.value = 'stops'
    section.value = 'surroundings'
    void home.selectPoint(coordinates)
    if (isWorkspace.value) void changeMobileView('results')
    else mobileView.value = 'results'
}
function resetSelection() { home.resetPoint() }
</script>

<template>
    <PlaceLayout>
        <main @pointerdown.capture="interacted" @keydown.capture="interacted" id="main-content" tabindex="-1" ref="workspace" class="placelens-workspace" :class="{ 'is-resizable': sidebar.enabled && !isWorkspace, 'sidebar-is-resizing': sidebar.dragging, 'home-v2': isWorkspace, 'home-panel-collapsed': panelCollapsed, 'home-height-dragging': mapDragging, 'home-show-map': mobileView === 'map', 'home-show-settings': mobileView === 'settings', 'has-point': !!point || selectedSides.length > 0 || section === 'trips', 'home-results-expanded': expandedResults, 'home-map-expanded': expandedMap }" :style="{ ...sidebar.style, '--home-map-height': `${mapHeight}px` }">
            <nav v-if="isWorkspace" class="home-mobile-views" aria-label="Экраны рабочей области">
                <div role="tablist" aria-label="Рабочая область" @keydown="mobileTabKey">
                    <button v-for="screen in mobileScreens" :key="screen.id" :id="`home-mobile-${screen.id}`" type="button" role="tab" :tabindex="mobileView === screen.id ? 0 : -1" :aria-selected="mobileView === screen.id" :aria-controls="screen.panel" @click="changeMobileView(screen.id, true)">{{ screen.label }}</button>
                </div>
            </nav>
            <aside :role="isWorkspace && isMobile ? 'tabpanel' : undefined" :inert="isWorkspace && (isMobile ? mobileView !== 'settings' : panelCollapsed)" id="home-panel" @focusin="panelFocus = $event.target as HTMLElement" tabindex="-1" class="place-panel" :aria-labelledby="isWorkspace && isMobile ? 'home-mobile-settings' : isWorkspace ? 'home-selection-title' : point ? 'transport-title' : 'search-title'">
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

                    <ComparisonShare v-if="isWorkspace" :address-url="location.ordinaryUrl.value" :personal-url="location.personalUrl.value" session-orientations />
                    <section v-if="isWorkspace" v-show="workspaceScenario === 'addresses'" class="home-address-selection" aria-label="Выбранные адреса">
                        <div v-for="side in (['left', 'right'] as const)" :key="side" class="home-address-slot" :aria-label="`Адрес ${side === 'left' ? 'А' : 'Б'}`">
                            <h2><span class="home-side-badge" :class="{ 'is-b': side === 'right' }">{{ side === 'left' ? 'А' : 'Б' }}</span><span>{{ sides[side].knownAddress?.label ?? sides[side].id ?? 'Адрес не выбран' }}</span></h2>
                            <p v-if="sides[side].id" class="home-address-confirmed">Адрес выбран</p>
                            <button v-if="sides[side].id" type="button" :aria-pressed="context.kind === 'profile' && activeSide === side" @click="changeSection('overview'); home.showSide(side); changeMobileView('results')">Показать {{ side === 'left' ? 'А' : 'Б' }}</button>
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
                        <AddressPicker ref="picker" :selected-id="sides[activeSide].id" :reset-key="searchResetKey" external-map @focus-point="focusChosenPoint" @select="confirmAddress" @map-state="previewAddresses" />
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
            <section :role="isWorkspace && isMobile ? 'tabpanel' : undefined" :aria-labelledby="isWorkspace && isMobile ? 'home-mobile-map' : undefined" id="home-map-screen" :inert="isWorkspace && isMobile && mobileView !== 'map'" class="placelens-map" aria-label="Карта Красноярска">
                <div v-if="isWorkspace" class="home-map-heading">
                    <button id="home-panel-toggle" class="home-desktop-layout" type="button" :aria-expanded="!panelCollapsed" aria-controls="home-panel" @click="togglePanel">{{ panelCollapsed ? 'Показать панель' : 'Свернуть панель' }}</button>
                    <h2 id="home-map-title" tabindex="-1" :class="{ 'sr-only': overview }">{{ addressChoice.groups.length ? 'Объекты найденных адресов' : 'Карта Красноярска' }}</h2>
                    <div v-if="overview" class="home-map-tools" aria-label="Показ целей">
                        <button type="button" :aria-pressed="mapScope === 'all'" @click="fitCurrentMap">Все цели</button>
                        <button type="button" :aria-pressed="mapScope === 'one'" :disabled="!selectedMapTrip" @click="mapScope = 'one'">Одна цель</button>
                        <button v-if="selectedMapTrip" type="button" @click="returnToTripRow">К строке</button>
                    </div>
                    <button type="button" :aria-expanded="expandedMap" @click="expandedMap = !expandedMap">{{ expandedMap ? 'Свернуть карту' : 'Развернуть карту' }}</button>
                    <button v-if="!overview" type="button" @click="useMapCenter">Выбрать центр карты</button>
                    <MapLayersPanel v-if="profile" v-model:stops="showStops" v-model:areas="areas" v-model:lines="lines" :contexts="[{ key: activeSide, label: activeSide === 'left' ? 'А' : 'Б', profile, loading: false }]" floating single-map @focus-layer="focusLayer(activeSide, $event)" />
                </div>
                <HomeWorkspaceMap ref="mapView" :context="isWorkspace ? context : { kind: 'point' }" :active-side="activeSide" :radius="radius" :point="point" :profile="profile" :analysis="analysis" :address="mapAddress" :choice="addressChoice" :selected-stop-id="profile ? profileStop : selectedStopId" :selected-object="selectedObject" :show-stops="showStops" :areas="areas" :lines="lines" :focus="mapFocus" :trip="isWorkspace ? trips.map.value : null" :overview="overview" :automatic-camera="!isWorkspace"
                    @entity="selectMapEntity" @point="mapPoint" @address="mapAddressSelected" @highlight-address="mapAddressHighlighted" @stop="mapStop" @object="mapObject" @street="selectTripMap" @ready="mapReady = true; finishTripFocus()" />
            </section>
            <div v-if="isWorkspace" class="home-map-resizer" role="separator" tabindex="0" aria-label="Высота карты" aria-orientation="horizontal" aria-controls="home-map-screen" :aria-valuemin="180" :aria-valuemax="mapHeightMax" :aria-valuenow="mapHeight" @pointerdown="heightStart" @pointermove="heightMove" @pointerup="heightEnd" @pointercancel="heightEnd" @lostpointercapture="heightEnd" @keydown="heightKey"><span /></div>
            <section :role="isWorkspace && isMobile ? 'tabpanel' : undefined" :aria-labelledby="isWorkspace && isMobile ? 'home-mobile-results' : undefined" id="home-results-screen" tabindex="-1" :inert="isWorkspace && isMobile && mobileView !== 'results' || isWorkspace && !isMobile && expandedMap" v-show="isWorkspace" class="home-results-area" aria-label="Результаты выбранного места">
                <div v-show="workspaceScenario !== 'addresses'" class="home-results-toolbar"><span>{{ showPoint && point ? 'Остановки рядом · по прямой' : 'Поездки' }}</span><button v-if="point || selectedSides.length || section === 'trips'" type="button" :aria-expanded="expandedResults" aria-controls="home-workspace-results" @click="expandedResults = !expandedResults">{{ expandedResults ? 'Свернуть результаты' : 'Развернуть результаты' }}</button></div>
                <div id="home-workspace-results" class="home-results-content">
                    <p v-if="invalidPersonalLink" role="alert">Общие цели из ссылки не восстановлены: формат, версия или размер не поддерживаются.</p>
                    <HomeTripsPanel ref="tripsPanel" :model="trips" :input="tripsInput" :editor-target="isWorkspace ? '#home-trip-editor' : undefined" @focus-point="focusChosenPoint" @scenario="workspaceScenario = $event" @run="runTrips" @show-map="showTripMap">
                        <template #results="{ entries, actions, scenario }">
                            <HomeMapDetails v-if="isWorkspace && overview" :goal-number="trips.addresses.places.value.findIndex(place => place.id === selectedMapTrip?.placeId) + 1" :alternatives="entries.filter(entry => entry.trip.placeId === selectedMapTrip?.placeId)" @select="home.activate({ kind: 'trip', trip: $event })" :entry="entries.find(entry => sameHomeTrip(entry.trip, selectedMapTrip)) ?? null" :actions="actions" :mode="trips.addresses.mode.value" :request="mapDetailsRequest" @close="closeMapDetails" @return-row="returnToTripRow" />
                            <HomeAddressResults :selected-trip="selectedMapTrip" v-if="scenario === 'addresses'" v-show="isWorkspace && !showPoint" :view="section" :expanded="expandedResults" :model="home" :trips="trips" :entries="entries" :actions="actions" :selected-stop-id="profileStop" :selected-object="selectedObject" @expand="expandedResults = !expandedResults" @update:view="changeSection" @select-stop="selectProfileStop" @focus-layer="focusLayer" />
                            <div v-else v-show="isWorkspace && workspaceScenario === 'standalone'"><h2 id="home-trips-title" tabindex="-1">Поездки</h2><p>{{ trips.addresses.mode.value === 'walking' ? 'Модель уличной части · подходы неизвестны' : 'Автомодель · без пробок, подходов и парковки' }}</p><HomeTripCell v-for="entry in entries" :key="JSON.stringify(entry.trip)" :entry="entry" :actions="actions" :mode="trips.addresses.mode.value" /></div>
                        </template>
                    </HomeTripsPanel>
                </div>
            </section>
            <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ orientations.announcement.value }}</p>
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
    .workspace-interface .home-v2.placelens-workspace{display:flex;flex-direction:column;overflow:hidden;min-height:0}
    .home-v2 .home-mobile-views{display:block;flex:none;padding:6px 10px;background:#fff;border-bottom:1px solid #dce2dc}
    .home-mobile-views [role=tablist]{display:flex;gap:6px}
    .home-v2 .home-mobile-views button{flex:1;min-width:0;min-height:44px;padding:6px;font-size:13px;border:1px solid #dce2dc;border-radius:7px}
    .home-v2 .home-mobile-views [aria-selected=true]{background:#efeaf6;color:#7058a5;border-color:#b9a8d1}
    .home-v2 .place-panel,.home-v2 .placelens-map,.home-v2 .home-results-area{display:none;flex:1;min-height:0;min-width:0}
    .home-v2:not(.home-show-map):not(.home-show-settings) .home-results-area{display:flex;visibility:visible}
    .home-v2.home-show-settings .place-panel{display:flex;overflow:auto;border:0}
    .home-v2.home-show-map .placelens-map{display:flex}
    .home-v2 .home-results-content{overflow:auto;min-height:0}
    .home-v2 .place-panel-content{padding:16px}
    .home-v2 .home-results-toolbar>button,.home-v2 .home-map-heading>button[aria-expanded]{display:none}
    .home-v2 .home-map-heading{padding:4px 8px;max-height:50%;overflow-y:auto;flex-shrink:0}
    .home-v2 .transport-results>dl{grid-template-columns:1fr}
    .home-v2 .transport-results>ul{display:block}
    .home-v2 .transport-results>ul>li+li{margin-top:8px}

}
</style>

<style scoped>
.home-v2 .home-address-selection{margin-bottom:16px}.home-address-slot{padding:10px 0;border-bottom:1px solid #dce4d9;overflow-wrap:anywhere}.home-address-slot h2{font-size:13px;font-weight:600}.home-address-slot button,.home-radius button{min-height:44px;padding:7px;margin:4px 4px 0 0;border:1px solid #cbdace;border-radius:6px;font-size:12px}.home-address-slot button[aria-pressed=true],.home-radius button[aria-pressed=true]{background:#eaf2df}.home-radius{margin-top:12px;font-size:12px}.home-v2 :is(button,summary,input):focus-visible{outline:3px solid #2d6450;outline-offset:2px}
</style>
