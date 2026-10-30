<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import HomeTripsEditor from '@/components/home/HomeTripsEditor.vue'
import HomeTripCell from '@/components/home/HomeTripCell.vue'
import ComparisonTripData from '@/components/ComparisonTripData.vue'
import { pairedTripFact } from '@/utils/comparisonTrips'
import type { HomeTripEntry, HomeTripActions } from '@/types/homeResults'
import { homeStandaloneTrip } from '@/composables/useHomeTrips'
import type { HomeTripRef, HomeTripsInput, HomeTripsPort } from '@/types/homeWorkspace'
import type { Coordinates } from '@/types/transport'
import type { TripMode } from '@/types/trips'

const props = defineProps<{ model: HomeTripsPort; input: HomeTripsInput; editorTarget?: string }>()
const emit = defineEmits<{ showMap: [focus: boolean]; scenario: [value: 'addresses' | 'standalone']; run: [] }>()
const { addresses, standalone } = props.model
const { mode, places } = addresses
const { draft } = standalone
const scenario = ref<'addresses' | 'standalone'>('addresses')
watch(props.input.context, context => {
    if (context.kind === 'trip' || context.kind === 'pick-street') scenario.value = context.trip.scenario
    else if (context.kind === 'pick-goal' || context.kind === 'pick-start') scenario.value = context.scenario
}, { immediate: true, flush: 'sync' })
watch(scenario, value => emit('scenario', value), { flush: 'sync' })
const names = { left: 'А', right: 'Б' }
const sides = ['left', 'right'] as const
const available = computed(() => sides.filter(side => props.input.sides[side].status === 'ready' && !!addresses.starts[side].point))
const busy = computed(() => scenario.value === 'addresses'
    ? sides.some(side => Object.values(addresses.cells[side]).some(cell => cell.status === 'loading')) : standalone.status.value === 'loading')
const picking = computed(() => ['pick-goal', 'pick-start', 'pick-street'].includes(props.input.context.value.kind))
const standalonePlaces = computed(() => draft.places.map((place, index) => ({ place, index, trip: homeStandaloneTrip(props.model, index)! })))
const entries = computed<HomeTripEntry[]>(() => {
    if (scenario.value === 'addresses') return places.value.flatMap(place => sides.filter(side => !!props.input.sides[side].id).map(side => {
        const value = addresses.cell(side, place.id)
        return { trip: { scenario: 'addresses', side, placeId: place.id } as HomeTripRef, title: `${names[side]} → ${place.label || 'Без названия'}`,
            row: value.row, loading: value.status === 'loading', error: value.error, source: value.source, limitation: value.limitation,
            canCalculate: available.value.includes(side) && !!place.point, groups: (['start', 'target'] as const).map(end => ({ end, candidates: value.options[end], selected: value.row?.road_choices?.[end]?.status === 'SELECTED' ? value.row.road_choices[end]?.point ?? undefined : undefined })) }
    }))
    return standalonePlaces.value.map(({ place, index, trip }) => {
        const row = standalone.analysis.value?.results.find(row => row.index === index) ?? null
        const failed = standalone.failedChoiceIndices.value.includes(index)
        const loading = standalone.status.value === 'loading' && (standalone.pendingChoiceIndices.value.length ? standalone.pendingChoiceIndices.value.includes(index) : true)
        return { trip, title: `Старт → ${place.label || `Место ${index + 1}`}`, row: failed || standalone.pendingChoiceIndices.value.includes(index) ? null : row,
            loading, error: failed || !row ? standalone.error.value : '', source: standalone.analysis.value?.source ?? null,
            limitation: standalone.analysis.value?.limitation ?? '', canCalculate: !!standalone.selection(),
            groups: (row && !failed && !loading ? standalone.rowCandidateGroups(row) : []).map(group => ({ end: group.key === 'S' ? 'start' as const : 'target' as const, candidates: group.candidates, selected: group.selected ?? undefined })) }
    })
})
function changeScenario(value: 'addresses' | 'standalone') {
    scenario.value = value
    const trip = value === 'standalone' ? homeStandaloneTrip(props.model, 0)
        : places.value[0] ? { scenario: 'addresses' as const, side: props.input.activeSide.value, placeId: places.value[0].id } : null
    if (trip) props.input.activate({ kind: 'trip', trip })
    else props.input.activate({ kind: 'profile', side: props.input.activeSide.value })
}
defineExpose({ changeScenario })
function changeMode(event: Event) {
    const value = (event.target as HTMLSelectElement).value
    if (value === 'driving' || value === 'walking') addresses.setMode(value as TripMode)
}
function show(trip: HomeTripRef) { props.input.activate({ kind: 'trip', trip }); emit('showMap', true) }
function pickGoal(trip: HomeTripRef) { props.input.activate({ kind: 'pick-goal', scenario: trip.scenario, placeId: trip.placeId }); emit('showMap', false) }
function pickStreet(trip: HomeTripRef, end: 'start' | 'target') { props.input.activate({ kind: 'pick-street', trip, end }); emit('showMap', false) }
function chooseOriginal(index: number, point: Coordinates) {
    const place = index < 0 ? draft.start : draft.places[index]
    if (place) { place.lon = String(point.lon); place.lat = String(point.lat) }
}
function standaloneIndex(trip: HomeTripRef) { return draft.places.findIndex((_, index) => homeStandaloneTrip(props.model, index)?.placeId === trip.placeId) }
function road(trip: HomeTripRef, end: 'start' | 'target', point: Coordinates | null) {
    if (trip.scenario === 'addresses') {
        addresses.setRoad(trip.side, trip.placeId, end, point)
        void addresses.calculate(trip.side, trip.placeId)
    } else {
        const index = standaloneIndex(trip)
        if (index < 0) return
        const key = end === 'start' ? 'S' : String(index + 1)
        if (point) standalone.chooseRoad(key, point)
        else standalone.resetRoad(key)
    }
}
function retry(trip: HomeTripRef) {
    if (trip.scenario === 'addresses') void addresses.calculate(trip.side, trip.placeId)
    else {
        const index = standaloneIndex(trip)
        if (index >= 0) road(trip, 'target', draft.places[index]?.road ?? null)
    }
}
function selectedRoad(trip: HomeTripRef, end: 'start' | 'target') {
    if (trip.scenario === 'addresses') return addresses.cell(trip.side, trip.placeId).hints[end]
    return (end === 'start' ? draft.start : draft.places[standaloneIndex(trip)])?.road
}
function act(trip: HomeTripRef, action: string, location: string) {
    if (action === 'retry') retry(trip)
    else if (location === 'start' || location === 'both_endpoints') pickStreet(trip, 'start')
    else if (location === 'target') pickStreet(trip, 'target')
    else show(trip)
}
const actions: HomeTripActions = { show, pickStreet, road, retry, selectedRoad, act }
</script>

<template>
    <section class="home-trips" aria-label="Поездки единого пространства">
        <Teleport :to="editorTarget || 'body'" :disabled="!editorTarget" defer>
            <HomeTripsEditor :model="model" :input="input" :scenario="scenario" :available="available" :busy="busy" :picking="picking" @change-mode="changeMode" @pick-goal="pickGoal" @choose-original="chooseOriginal" @show-map="emit('showMap', $event)" @run="emit('run')" />
        </Teleport>
        <slot name="results" :entries="entries" :actions="actions" :scenario="scenario">
            <template v-if="scenario === 'addresses'"><p v-for="place in places" :key="place.id">{{ pairedTripFact(addresses.cell('left', place.id), addresses.cell('right', place.id), mode) }}</p></template>
            <HomeTripCell v-for="entry in entries" :key="JSON.stringify(entry.trip)" :entry="entry" :actions="actions" :mode="mode" />
            <ComparisonTripData v-if="scenario === 'addresses'" :model="addresses" />
        </slot>
    </section>
</template>
