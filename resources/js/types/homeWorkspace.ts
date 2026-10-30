import type { Ref, ComputedRef } from 'vue'
import type { useComparisonTrips } from '@/composables/useComparisonTrips'
import type { useTripsState } from '@/composables/useTripsState'
import type { ComparisonSide } from '@/composables/useAddressComparison'
import type { ComparisonTripLink } from '@/utils/comparisonTrips'
import type { SideKey } from '@/utils/comparison'
import type { Coordinates, TransportAnalysis } from '@/types/transport'
import type { AddressMapState } from '@/utils/addressMap'
import type { AddressResult } from '@/types/address'
import type { AddressProfile, AreaVisibility, LinearVisibility } from '@/types/profile'
import type { MapLayerKey } from '@/types/mapLayers'
import type { TripMode } from '@/types/trips'
import type { TripMapOverlay } from '@/utils/tripOverlay'

/** IDs are stable goal IDs, never response indices. Street points remain separate. */
export type HomeTripRef = { scenario: 'addresses'; side: SideKey; placeId: string } | { scenario: 'standalone'; placeId: string }
export type HomeMapContext =
    | { kind: 'profile'; side: SideKey }
    | { kind: 'point' }
    | { kind: 'trip'; trip: HomeTripRef }
    | { kind: 'pick-goal'; scenario: 'addresses' | 'standalone'; placeId: string }
    | { kind: 'pick-start'; scenario: 'standalone' }
    | { kind: 'pick-street'; trip: HomeTripRef; end: 'start' | 'target' }

/** G3.2 receives the existing owner; it must not create another address loader/history writer.
 * It owns useComparisonTrips (shared goals) and useTripsState (independent draft).
 * It publishes prepared map data only; switching context never calculates a trip. */
export interface HomeTripsInput {
    sides: Readonly<Record<SideKey, Readonly<ComparisonSide>>>
    radius: Readonly<Ref<number>>
    activeSide: Readonly<Ref<SideKey>>
    context: Readonly<Ref<HomeMapContext>>
    activate: (context: HomeMapContext) => void
    saveAddressTrips: (selection: ComparisonTripLink | null, mode: 'push' | 'replace') => void
    standaloneEffects: Parameters<typeof useTripsState>[0]
}
export interface HomeTripMapInput { trip: HomeTripRef; mode: TripMode; overlay: TripMapOverlay }
export type HomeTripMapSelection =
    | { context: Extract<HomeMapContext, { kind: 'pick-goal' | 'pick-start' | 'pick-street' }>; point: Coordinates }
    | { context: Extract<HomeMapContext, { kind: 'trip' }>; sequence: number; end: 'start' | 'target'; point: Coordinates }
export interface HomeTripsPort {
    /** Shared goals/side starts/cells and independent start/goals/results keep
     * their existing APIs, limits and invalidation; no implicit draft merging. */
    addresses: ReturnType<typeof useComparisonTrips>
    standalone: ReturnType<typeof useTripsState>
    map: ComputedRef<HomeTripMapInput | null>
    selectMap: (selection: HomeTripMapSelection) => void
}

/** G3.3 HomeWorkspaceMap.vue: one CityMap; no fetching or URL effects.
 * Context accompanies events so the owner can reject stale selections. */
export interface HomeWorkspaceMapProps {
    context: HomeMapContext
    activeSide: SideKey
    radius: number
    point: Coordinates | null
    profile: AddressProfile | null
    analysis: Pick<TransportAnalysis, 'analysis_area' | 'analysis_bounds' | 'stops_in_radius'> | null
    address: AddressResult | null
    choice: AddressMapState
    selectedStopId: number | null
    selectedObject: { layer: MapLayerKey; id: string } | null
    showStops: boolean
    areas: AreaVisibility
    lines: LinearVisibility
    focus: { layer: MapLayerKey; id?: string; sequence: number } | null
    trip: HomeTripMapInput | null
}
export interface HomeWorkspaceMapEvents {
    ready: []
    point: [context: HomeMapContext, point: Coordinates]
    address: [side: SideKey, id: string]
    highlightAddress: [side: SideKey, id: string | null]
    stop: [id: number | null]
    object: [selection: { layer: MapLayerKey; id: string } | null]
    street: [selection: HomeTripMapSelection]
}
export interface HomeWorkspaceMapHandle {
    centerPoint: () => Coordinates | null
    resetView: () => void
    focusTrip: () => Promise<void>
}
