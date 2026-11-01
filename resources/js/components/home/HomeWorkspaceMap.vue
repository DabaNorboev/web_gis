<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import CityMap from '@/components/map/CityMap.vue'
import type { Coordinates } from '@/types/transport'
import type { HomeMapContext, HomeTripRef, HomeWorkspaceMapProps, HomeWorkspaceMapEvents, HomeWorkspaceMapHandle } from '@/types/homeWorkspace'
import type { TripMapOverlay } from '@/utils/tripOverlay'

const props = defineProps<HomeWorkspaceMapProps>()
const emit = defineEmits<HomeWorkspaceMapEvents>()
const map = ref<InstanceType<typeof CityMap> | null>(null)
const ready = ref(false)
const empty: TripMapOverlay['data'] = { type: 'FeatureCollection', features: [] }
const sameTrip = (a: HomeTripRef, b: HomeTripRef) => a.scenario === b.scenario && a.placeId === b.placeId
    && (a.scenario !== 'addresses' || b.scenario === 'addresses' && a.side === b.side)
const picking = computed(() => ['pick-start', 'pick-goal', 'pick-street'].includes(props.context.kind))
const trip = computed(() => {
    const context = props.context, value = props.trip
    if (!value) return null
    if (context.kind === 'trip' || context.kind === 'pick-street') return sameTrip(context.trip, value.trip) ? value : null
    if (context.kind === 'pick-goal') return context.scenario === value.trip.scenario && context.placeId === value.trip.placeId ? value : null
    return context.kind === 'pick-start' && value.trip.scenario === 'standalone' ? value : null
})

// CityMap treats a changed overlay sequence as a camera command. Keep its
// display sequence constant, while events below retain the owner's real token.
// Start with an empty overlay. sharedView=null requests viewReady without a
// shared camera; publishing data then also cancels CityMap's deferred load fit.
const overlay = computed<TripMapOverlay>(() => preview.value ? { data: empty, markers: [], sequence: 0 } : ({ ...(props.overview ?? {}), data: ready.value ? props.overview?.data ?? trip.value?.overlay.data ?? empty : empty, markers: ready.value ? props.overview?.markers : [], sequence: 0 }))
const preview = computed(() => props.goalPreview?.choice.groups.length ? props.goalPreview : null)
const choice = computed(() => preview.value?.choice ?? props.choice)
const profile = computed(() => !preview.value && props.context.kind === 'profile' && !props.choice.groups.length ? props.profile : null)
const background = computed(() => props.context.kind === 'profile' || props.context.kind === 'point')
const address = computed(() => !preview.value && background.value && !props.overview ? props.address : null)
const groups = computed(() => preview.value ? preview.value.choice.groups : !props.overview && background.value ? profile.value ? address.value ? [address.value] : [] : props.choice.groups : [])
const point = computed(() => profile.value?.point ?? (props.context.kind === 'point' ? props.point : null))
const analysis = computed(() => profile.value?.map ?? (props.context.kind === 'point' ? props.analysis : null))
const side = computed(() => props.context.kind === 'profile' ? props.context.side : props.activeSide)

const version = ref(0)
let disposed = false
watch(() => [props.context, props.activeSide, props.trip?.trip, props.trip?.mode, props.trip?.overlay.sequence, props.overview?.markers?.map(marker => marker.id), props.goalPreview], () => { version.value++ }, { deep: true, flush: 'sync' })
onBeforeUnmount(() => { disposed = true; version.value++ })
watch(() => props.selectedObject, selection => { if (!selection) map.value?.clearObjectSelection() })

// Each rendered handler captures its context/token. It cannot turn an old click
// into a selection of the newly active side, goal, mode or street endpoint.
const events = computed(() => {
    const current = version.value
    const context: HomeMapContext = 'trip' in props.context ? { ...props.context, trip: { ...props.context.trip } } : { ...props.context }
    const search = preview.value
    const selectedSide = side.value, value = trip.value, sequence = value?.overlay.sequence
    const live = () => !disposed && current === version.value
    const shownAddress = (id: string) => groups.value.some(group => group.objects.some(object => object.id === id))
    return {
        tripEntity(id: string) {
            if (live() && !preview.value && !picking.value && !props.choice.groups.length && (props.overview?.markers?.some(marker => marker.id === id) || props.overview?.data.features.some(feature => feature.properties?.entity === id))) emit('entity', id)
        },
        select(coordinates: Coordinates) {
            if (!live() || preview.value) return
            const point = { ...coordinates }
            if (context.kind === 'pick-start' || context.kind === 'pick-goal' || context.kind === 'pick-street') emit('street', { context, point })
            else emit('point', context, point)
        },
        roadCandidate(key: string, coordinates: Coordinates) {
            if (!live() || preview.value || context.kind !== 'trip' || !value || sequence === undefined || !ready.value) return
            const candidate = value.overlay.data.features.some(feature => feature.properties?.kind === 'candidate' && feature.properties.key === key
                && feature.geometry.type === 'Point' && feature.geometry.coordinates[0] === coordinates.lon && feature.geometry.coordinates[1] === coordinates.lat)
            if (candidate) emit('street', { context, sequence, end: key === 'S' ? 'start' : 'target', point: { ...coordinates } })
        },
        selectAddressObject(id: string) { if (live() && shownAddress(id)) { if (search) search.select(id); else emit('address', selectedSide, id) } },
        highlightAddressObject(id: string | null) { if (live() && (search || background.value) && (id === null || shownAddress(id))) { if (search) search.highlight(id); else emit('highlightAddress', selectedSide, id) } },
        selectStop(id: number) { if (live() && !preview.value && background.value) emit('stop', id) },
        clearStop() { if (live() && !preview.value && background.value) emit('stop', null) },
        selectObject(selection: HomeWorkspaceMapProps['selectedObject']) { if (live() && !preview.value && background.value) emit('object', selection) },
        viewReady() { if (!disposed) { ready.value = true; emit('ready') } },
    }
})

defineExpose<HomeWorkspaceMapHandle>({
    focusPoint: point => { version.value++; map.value?.focusPoint(point) },
    centerPoint: () => map.value?.centerPoint() ?? null,
    resetView: () => { map.value?.resetView() },
    focusTrip: async () => {
        const current = version.value
        await nextTick()
        if (ready.value && (trip.value || props.overview) && !disposed && current === version.value) await map.value?.focusTrip()
    },
})
</script>

<template>
    <CityMap ref="map"
        :selectable="!preview" :point="preview ? null : point" :analysis="preview ? null : analysis" :show-analysis-area="!overview && !preview" :profile="profile" :radius="radius"
        :address-group="address" :address-groups="groups"
        :selected-address-id="profile?.address.id ?? choice.selectedId"
        :highlighted-address-id="choice.highlightedId" :highlighted-group-id="choice.highlightedGroupId"
        :place-label="profile ? side === 'left' ? 'А' : 'Б' : undefined"
        :area-layers="profile?.map.area_layers ?? null" :area-visibility="areas"
        :linear-layers="profile?.map.linear_layers ?? null" :linear-visibility="lines"
        :show-stops="!preview && background && (profile ? showStops : true)"
        :selected-stop-id="!preview && background ? selectedStopId : null" :focus-request="!preview && background ? focus : null"
        :automatic-camera="preview && !preview.choice.selectedId ? true : automaticCamera ?? false" :overlay-controls="!!overview" :trip-overlay="overlay" :trip-picking="picking && !preview" :shared-view="null"
        v-on="events" />
</template>
