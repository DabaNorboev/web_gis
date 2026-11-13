import type { LineString } from 'geojson'
import type { Coordinates, TransportMetric } from './transport'

export interface TripPoint extends Coordinates { road?: Coordinates }
export interface TripPlace extends TripPoint { label: string }
export type TripMode = 'driving' | 'walking'
export interface TripSelection { version: 1; mode: TripMode; start: TripPoint; places: TripPlace[] }
export interface TripSnap { original: Coordinates; matched: Coordinates; distance_m: number }
export interface TripRoadCandidate { point: Coordinates; distance_m: number; name?: string | null }
export interface TripDiagnosticIssue {
    code: string
    category: 'distance' | 'ambiguity' | 'obstacle' | 'access' | 'coverage' | 'service' | 'check_failure' | 'insufficient_data'
    stage: 'scope' | 'snap' | 'connector' | 'routing' | 'geometry' | 'route'
    location: 'start' | 'target' | 'both_endpoints' | 'route' | 'unknown'
    target_index: number | null
}
export interface TripDiagnostics { version: 1; issues: TripDiagnosticIssue[] }
export interface TripRoadChoiceDiagnostics {
    radius_m: number
    nearest_road_distance_m: number | null
    nearest_road_scope: 'loaded_guard_cells'
    containing_building_count: number
    entrance_data: 'NOT_PREPARED'
    candidate_count: number
    safe_candidate_count: number
}
export interface TripRoadChoice { manual?: boolean; checks?: string[]; diagnostics?: TripRoadChoiceDiagnostics; status: 'SELECTED' | 'CHOOSE' | 'NONE' | 'NEEDS_REFINEMENT' | 'UNKNOWN' | 'OUTSIDE_PILOT'; point?: Coordinates | null; candidates?: TripRoadCandidate[] }
export interface TripApproach {
    status: 'UNKNOWN' | 'NOT_INCLUDED'
    original: Coordinates
    selected_street: Coordinates
    selection_shift_m: number
    distance_m: null
    duration_s: null
    reason: string
}
export type TripMetric = Omit<TransportMetric, 'key'> & { key: string; dataset_version: string | null; scope?: 'street_points' | 'objects' }
export interface TripResult {
    index: number
    label: string
    start: Coordinates
    target: Coordinates
    status: 'AVAILABLE' | 'NEEDS_REFINEMENT' | 'NO_PATH' | 'UNKNOWN' | 'UNAVAILABLE' | 'OUTSIDE_PILOT'
    reason: string
    checks: string[]
    diagnostics?: TripDiagnostics
    route_scope?: 'street_points'
    street_points?: { start: Coordinates; target: Coordinates }
    selection_kind?: 'INPUT_STREET_POINTS' | 'EXPLICIT_STREET_POINTS' | 'DIFFERENT_STREET_POINTS'
    approaches?: { start: TripApproach; target: TripApproach }
    address_metrics?: { distance: TripMetric; duration: TripMetric }
    route: { geometry: LineString; distance_m: number; duration_s: number; scope?: 'street_points' } | null
    snaps: { start: TripSnap; target: TripSnap } | null
    road_choices?: { start: TripRoadChoice; target: TripRoadChoice } | null
    metrics: { distance: TripMetric; duration: TripMetric }
}
export interface TripAnalysis {
    mode: TripMode
    route_scope?: 'street_points'
    start: Coordinates
    results: TripResult[]
    limitation: string
    source: {
        name: string; engine: string; engine_version: string; profile: string
        dataset_version: string; pbf_sha256: string; extract_sha256: string; manifest_sha256: string
        observed_at: string | null; prepared_at: string; pilot_bbox: [number, number, number, number]
        guard_imports: { id: number; source: string; dataset_key: string; source_version: string | null; observed_at: string | null }[]
    } | null
}
