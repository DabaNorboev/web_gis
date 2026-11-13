import type { HomeTripRef } from './homeWorkspace'
import type { Coordinates } from './transport'
import type { TripAnalysis, TripResult, TripRoadCandidate } from './trips'
export interface HomeTripEntry {
    trip: HomeTripRef
    title: string
    row: TripResult | null
    loading: boolean
    error: string
    source: TripAnalysis['source'] | null
    limitation: string
    canCalculate: boolean
    groups: { end: 'start' | 'target'; candidates: TripRoadCandidate[]; selected?: Coordinates }[]
}
export interface HomeTripActions {
    show: (trip: HomeTripRef) => void
    pickStreet: (trip: HomeTripRef, end: 'start' | 'target') => void
    road: (trip: HomeTripRef, end: 'start' | 'target', point: Coordinates | null) => void
    retry: (trip: HomeTripRef) => void
    selectedRoad: (trip: HomeTripRef, end: 'start' | 'target') => Coordinates | null | undefined
    act: (trip: HomeTripRef, action: string, location: string) => void
}
export type HomeResultView = 'overview' | 'trips' | 'surroundings' | 'data'
