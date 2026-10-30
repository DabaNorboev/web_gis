import { computed, onBeforeUnmount, watch } from 'vue'
import { useComparisonTrips } from '@/composables/useComparisonTrips'
import { useTripsState } from '@/composables/useTripsState'
import { tripMapData } from '@/utils/tripMap'
import { selectedPoint } from '@/utils/trips'
import { sameRoadPoint } from '@/utils/tripCandidates'
import type { Coordinates } from '@/types/transport'
import type { TripAnalysis } from '@/types/trips'
import type { ComparisonTripLink } from '@/utils/comparisonTrips'
import type { HomeMapContext, HomeTripRef, HomeTripsInput, HomeTripsPort, HomeTripMapSelection } from '@/types/homeWorkspace'

// Identity belongs to the draft object, never its current array/response index.
// The registry holds no draft or coordinates after its owner is collected.
const identities = new WeakMap<HomeTripsPort['standalone'], (index: number) => HomeTripRef | null>()
export function homeStandaloneTrip(model: HomeTripsPort, index: number): HomeTripRef | null {
    return identities.get(model.standalone)?.(index) ?? null
}
const sides = ['left', 'right'] as const
const sameTrip = (a: HomeTripRef, b: HomeTripRef) => a.scenario === b.scenario && a.placeId === b.placeId
    && (a.scenario !== 'addresses' || b.scenario === 'addresses' && a.side === b.side)
function sameContext(a: HomeMapContext, b: HomeMapContext) {
    if (a.kind === 'trip') return b.kind === 'trip' && sameTrip(a.trip, b.trip)
    if (a.kind === 'pick-street') return b.kind === 'pick-street' && a.end === b.end && sameTrip(a.trip, b.trip)
    if (a.kind === 'pick-goal') return b.kind === 'pick-goal' && a.scenario === b.scenario && a.placeId === b.placeId
    if (a.kind === 'profile') return b.kind === 'profile' && a.side === b.side
    return a.kind === b.kind
}

/** No address fetching, browser history, DOM effects or camera commands here.
 * Instantiate once alongside useHomeWorkspace, outside conditional panels.
 * URL restoration belongs to G3.4; restore() does not echo address saves. */
export function useHomeTrips(input: HomeTripsInput): HomeTripsPort {
    let disposed = false
    onBeforeUnmount(() => { disposed = true })
    const addresses = useComparisonTrips()
    const standalone = useTripsState(input.standaloneEffects)
    let syncingMode = false
    for (const [owner, other] of [[addresses, standalone], [standalone, addresses]] as const) {
        watch(owner.mode, value => {
            if (syncingMode) return
            syncingMode = true
            try { other.setMode(value) } finally { syncingMode = false }
        }, { flush: 'sync' })
    }
    for (const side of sides) watch(() => {
        const value = input.sides[side]
        return { id: value.id, point: value.status === 'ready' && value.profile?.address.id === value.id ? value.profile.point : null }
    }, value => addresses.setStart(side, value.id, value.point), { immediate: true, flush: 'sync' })

    const calculate = addresses.calculate
    addresses.calculate = async (onlySide, onlyId) => {
        if (disposed) return
        const available = sides.filter(side => (!onlySide || side === onlySide) && input.sides[side].status === 'ready'
            && !!input.sides[side].id && addresses.starts[side].id === input.sides[side].id && !!addresses.starts[side].point)
        if (!available.length) {
            addresses.formError.value = 'Дождитесь доступного выбранного адреса и повторите расчёт.'
            return
        }
        await Promise.allSettled(available.map(side => calculate(side, onlyId)))
    }
    const geometryKey = (value: ComparisonTripLink | null) => JSON.stringify(value && { ...value, places: value.places.map(place => ({ ...place, label: '' })) })
    let addressLinkKey = JSON.stringify(addresses.linkSelection.value)
    let addressGeometryKey = geometryKey(addresses.linkSelection.value)
    function rememberAddressLink() {
        addressLinkKey = JSON.stringify(addresses.linkSelection.value)
        addressGeometryKey = geometryKey(addresses.linkSelection.value)
    }
    // Batch one user edit; do not observe the owner's intermediate reset cells.
    watch(addresses.linkSelection, value => {
        if (disposed) return
        const key = JSON.stringify(value)
        if (key === addressLinkKey) return
        const geometry = geometryKey(value), mode = geometry === addressGeometryKey ? 'replace' : 'push'
        addressLinkKey = key
        addressGeometryKey = geometry
        input.saveAddressTrips(value, mode)
    }, { deep: true })
    const restoreAddresses = addresses.restore
    addresses.restore = value => {
        const mode = value?.mode ?? addresses.mode.value
        syncingMode = true
        try { restoreAddresses(value); addresses.setMode(mode) } finally { syncingMode = false }
        standalone.setMode(mode)
        rememberAddressLink()
    }
    const restoreStandalone = standalone.restore
    standalone.restore = (value, invalid) => {
        const mode = value?.mode ?? standalone.mode.value
        syncingMode = true
        try { restoreStandalone(value, invalid); standalone.setMode(mode); standalone.invalidLink.value = invalid ?? false } finally { syncingMode = false }
        addresses.setMode(mode)
        rememberAddressLink()
    }

    let serial = 0
    const ids = new WeakMap<object, string>()
    function idFor(place: object) {
        let id = ids.get(place)
        if (!id) { id = `standalone-${++serial}`; ids.set(place, id) }
        return id
    }
    const standaloneIndex = (id: string) => standalone.draft.places.findIndex(place => idFor(place) === id)
    identities.set(standalone, index => {
        const place = standalone.draft.places[index]
        return place ? { scenario: 'standalone', placeId: idFor(place) } : null
    })
    function contextTrip(context: HomeMapContext): HomeTripRef | null {
        if (context.kind === 'trip' || context.kind === 'pick-street') return context.trip
        if (context.kind === 'pick-goal') return context.scenario === 'addresses'
            ? { scenario: 'addresses', side: input.activeSide.value, placeId: context.placeId }
            : { scenario: 'standalone', placeId: context.placeId }
        if (context.kind === 'pick-start') {
            const place = standalone.draft.places[0]
            return place ? { scenario: 'standalone', placeId: idFor(place) } : null
        }
        return null
    }
    function geometry(trip: HomeTripRef) {
        if (trip.scenario === 'addresses') {
            const place = addresses.places.value.find(place => place.id === trip.placeId)
            return place ? [addresses.starts[trip.side].id, addresses.starts[trip.side].point, place.point] : null
        }
        const index = standaloneIndex(trip.placeId), place = standalone.draft.places[index]
        return place ? [standalone.readPoint(standalone.draft.start), standalone.readPoint(place)] : null
    }
    // An old result context cannot silently become a different goal after an edit.
    watch(() => {
        const context = input.context.value, trip = contextTrip(context)
        return { context, trip, geometry: trip ? JSON.stringify(geometry(trip)) : null, mode: addresses.mode.value }
    }, (next, previous) => {
        if (!next.trip) return
        const removed = geometry(next.trip) === null
        const edited = sameContext(next.context, previous.context)
            && (next.geometry !== previous.geometry || next.mode !== previous.mode)
        if (removed || edited) input.activate(next.trip.scenario === 'addresses' ? { kind: 'profile', side: next.trip.side } : { kind: 'point' })
    }, { flush: 'sync' })

    const prepared = computed(() => {
        const trip = contextTrip(input.context.value)
        if (!trip) return null
        if (trip.scenario === 'addresses') {
            const place = addresses.places.value.find(place => place.id === trip.placeId)
            if (!place) return null
            const start = addresses.starts[trip.side].point, value = addresses.cells[trip.side][place.id]
            if (!value) return null
            const row = value.row
            const analysis: TripAnalysis | null = row && start ? { mode: addresses.mode.value, start, results: [{ ...row, index: 0 }], source: value.source, limitation: value.limitation } : null
            const data = tripMapData([
                ...(start ? [{ key: 'S', point: start, road: value.hints.start }] : []),
                ...(place.point ? [{ key: '1', point: place.point, road: value.hints.target }] : []),
            ], analysis, (['start', 'target'] as const).flatMap(end => value.options[end].length ? [{ key: end === 'start' ? 'S' : '1',
                label: end === 'start' ? `Старт ${trip.side === 'left' ? 'А' : 'Б'}` : place.label || 'Цель', candidates: value.options[end],
                selected: row?.road_choices?.[end]?.status === 'SELECTED' ? row.road_choices[end]?.point ?? null : null,
            }] : []), addresses.mode.value)
            return { trip, mode: addresses.mode.value, data, revision: value.epoch }
        }
        const index = standaloneIndex(trip.placeId), place = standalone.draft.places[index]
        if (!place) return null
        const start = standalone.readPoint(standalone.draft.start), target = standalone.readPoint(place)
        const row = standalone.pendingChoiceIndices.value.includes(index) || standalone.failedChoiceIndices.value.includes(index)
            ? null : standalone.analysis.value?.results.find(row => row.index === index)
        const analysis = row && standalone.analysis.value ? { ...standalone.analysis.value, results: [{ ...row, index: 0 }] } : null
        const groups = row ? standalone.rowCandidateGroups(row).map(group => ({ ...group, key: group.key === 'S' ? 'S' : '1' })) : []
        return { trip, mode: standalone.mode.value, data: tripMapData([
            ...(start ? [{ key: 'S', point: start, road: standalone.draft.start.road }] : []),
            ...(target ? [{ key: '1', point: target, road: place.road }] : []),
        ], analysis, groups, standalone.mode.value) }
    })
    let sequence = 0
    // Flush synchronously: a second event from the old overlay must already be stale.
    watch([prepared, input.context], () => { sequence++ }, { flush: 'sync' })
    const map = computed(() => {
        const value = prepared.value
        if (!value) return null
        const data = value.data
        for (const feature of data.features) {
            if (feature.properties?.kind === 'original') feature.properties.label = feature.properties.label === 'Старт'
                ? `Старт${value.trip.scenario === 'addresses' ? value.trip.side === 'left' ? ' А' : ' Б' : ''}` : 'Цель'
            if (feature.properties?.kind === 'candidate') feature.properties.id = JSON.stringify([value.trip, sequence, feature.properties.key, feature.geometry])
        }
        return { trip: value.trip, mode: value.mode, overlay: { data, sequence } }
    })
    function setOriginal(trip: HomeTripRef, point: Coordinates) {
        if (trip.scenario === 'addresses') addresses.setPoint(trip.placeId, point)
        else {
            const place = standalone.draft.places[standaloneIndex(trip.placeId)]
            if (place) { place.lon = String(point.lon); place.lat = String(point.lat) }
        }
    }
    function setStreet(trip: HomeTripRef, end: 'start' | 'target', point: Coordinates) {
        if (trip.scenario === 'addresses') {
            addresses.setRoad(trip.side, trip.placeId, end, point)
            void addresses.calculate(trip.side, trip.placeId)
        } else {
            const index = standaloneIndex(trip.placeId)
            if (index >= 0) standalone.chooseRoad(end === 'start' ? 'S' : String(index + 1), point)
        }
    }
    function selectMap(selection: HomeTripMapSelection) {
        if (disposed || !sameContext(selection.context, input.context.value) || !selectedPoint(selection.point)) return
        const context = selection.context, trip = contextTrip(context)
        if (!trip || geometry(trip) === null) return
        if (context.kind === 'trip') {
            if (!('sequence' in selection) || map.value?.overlay.sequence !== selection.sequence) return
            const key = selection.end === 'start' ? 'S' : '1'
            const candidate = map.value.overlay.data.features.find(feature => feature.properties?.kind === 'candidate'
                && feature.properties.key === key && feature.geometry.type === 'Point'
                && sameRoadPoint(selection.point, { lon: feature.geometry.coordinates[0]!, lat: feature.geometry.coordinates[1]! }))
            if (candidate?.geometry.type === 'Point') setStreet(trip, selection.end, { lon: candidate.geometry.coordinates[0]!, lat: candidate.geometry.coordinates[1]! })
        } else if (context.kind === 'pick-street') {
            setStreet(trip, context.end, selection.point)
            input.activate({ kind: 'trip', trip })
        } else if (context.kind === 'pick-start') {
            standalone.draft.start.lon = String(selection.point.lon)
            standalone.draft.start.lat = String(selection.point.lat)
            input.activate({ kind: 'trip', trip })
        } else {
            setOriginal(trip, selection.point)
            input.activate({ kind: 'trip', trip })
        }
    }
    return { addresses, standalone, map, selectMap }
}
