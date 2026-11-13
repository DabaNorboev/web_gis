import type { Coordinates } from '../types/transport'
import type { TripMode, TripResult } from '../types/trips'

// Bound recursive JSON expansion for TypeScript; snapshots are frozen at every runtime depth.
export type DeepReadonly<T, Depth extends unknown[] = []> = Depth['length'] extends 10 ? unknown
    : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K], [...Depth, unknown]> } : T
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Radius = 300 | 500
export type EnvironmentBlock = 'transport' | 'parks' | 'vegetation' | 'water' | 'roads' | 'railways'
export const environmentBlocks: readonly EnvironmentBlock[] = Object.freeze(['transport', 'parks', 'vegetation', 'water', 'roads', 'railways'])
export interface SelectionProvenance {
    source: string | null
    datasetImportId: number | null
    snapshot: string | null
    observedAt: string | null
    sourceUpdatedAt: string | null
}
export interface AddressSelection extends Coordinates {
    kind: 'address'
    addressId: string
    label: string
    provenance: SelectionProvenance | null
}
export interface PointSelection extends Coordinates { kind: 'point'; label: string }
export type PlaceSelection = AddressSelection | PointSelection
export interface CandidateBasis { address: AddressSelection; selectionRevision: number }
export interface ChecklistBasis extends CandidateBasis {
    placeId: string | null
    placeSelection: PlaceSelection | null
    placeRevision: number | null
    mode: TripMode | null
    radius: Radius
}
export interface PreviousObject { candidateId: string; address: AddressSelection }
export interface Note { id: string; text: string; placeId: string | null; basis: ChecklistBasis; updatedAt: string; previousObject?: PreviousObject }
export interface MissingCandidateReplacement {
    generation: number
    documentRevision: number
    candidateId: string
    replacement: AddressSelection
    summary: {
        previousAddress: AddressSelection
        transferredNotes: Note[]
        discardedChecklist: ChecklistMark[]
        discardedStreetChoices: StreetChoice[]
        pairRoles: ('a' | 'b')[]
    }
}
export interface ChecklistMark { ruleKey: string; placeId: string | null; checked: boolean; basis: ChecklistBasis; updatedAt: string }
export interface Candidate {
    id: string
    selectionRevision: number
    address: AddressSelection
    notes: Note[]
    checklist: ChecklistMark[]
}
export interface Place {
    id: string
    selectionRevision: number
    label: string
    selection: PlaceSelection
    mode: TripMode
    thresholdMinutes: number | null
}
export interface StreetChoice {
    candidateId: string
    placeId: string
    mode: TripMode
    candidateRevision: number
    placeRevision: number
    startRoad: Coordinates | null
    targetRoad: Coordinates | null
}
// An in-memory input projection, not a versioned storage or URL format.
export interface SearchDocument {
    searchId: string
    documentRevision: number
    candidates: Candidate[]
    places: Place[]
    pair: { a: string | null; b: string | null }
    radius: Radius
    streetChoices: StreetChoice[]
}
export type ResolutionStatus = 'resolved' | 'missing' | 'source_unavailable' | 'request_error' | 'unresolved'
export interface Resolution { kind: 'candidate' | 'place'; id: string; status: ResolutionStatus }
export interface ResolutionRequest { generation: number; serial: number; kind: Resolution['kind']; id: string; selectionRevision: number; addressId: string }
export interface TripInput {
    kind: 'trip'
    candidateId: string
    placeId: string
    candidateRevision: number
    placeRevision: number
    startAddressId: string
    targetAddressId: string | null
    startLabel: string
    targetLabel: string
    start: Coordinates
    target: Coordinates
    mode: TripMode
    startRoad: Coordinates | null
    targetRoad: Coordinates | null
}
export interface EnvironmentInput {
    kind: 'environment'
    candidateId: string
    candidateRevision: number
    addressId: string
    point: Coordinates
    radius: Radius
    block: EnvironmentBlock
}
export type CalculationInput = TripInput | EnvironmentInput
export interface RequestToken { generation: number; epoch: number; inputStamp: string; serial: number }
export interface CalculationJob { token: RequestToken; input: CalculationInput; requestedAt: string }
export interface ResultBase { calculatedAt: string | null; provenance: Json }
export interface TripOutcome extends ResultBase {
    kind: 'trip'
    status: TripResult['status']
    durationSeconds: number | null
    route: TripResult['route']
    details: Json
}
export interface EnvironmentOutcome extends ResultBase {
    kind: 'environment'
    status: 'READY' | 'ERROR' | 'UNAVAILABLE' | 'OUTSIDE_SERVICE_AREA' | 'UNKNOWN'
    value: Json
}
export type CalculationOutcome = TripOutcome | EnvironmentOutcome
export interface RequestFailure {
    kind: 'http' | 'network' | 'timeout' | 'invalid_response' | 'cancelled'
    status: number | null
    code: string | null
    retryAfter: string | null
}
export interface ResultRecord { input: CalculationInput; inputStamp: string; outcome: CalculationOutcome }
export interface CalculationCell {
    key: string
    phase: 'not_calculated' | 'queued' | 'loading' | 'settled' | 'request_error'
    freshness: 'none' | 'current' | 'stale'
    result: ResultRecord | null
    error: RequestFailure | null
}
export type Section = 'conditions' | 'territory' | 'addresses' | 'comparison' | 'visit'
export interface ViewState { section: Section; candidateId: string | null }
export interface SearchSnapshot {
    document: SearchDocument
    runtime: { generation: number; cells: CalculationCell[]; resolutions: Resolution[] }
    view: ViewState
}
export interface SearchTaskPorts { nextId(): string; now(): string }
