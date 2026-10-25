import type { LineString } from 'geojson'
import type { Coordinates, TransportMetric } from './transport'

export interface TripPoint extends Coordinates { road?: Coordinates }
export interface TripPlace extends TripPoint { label: string }
export interface TripSelection { version: 1; mode: 'driving'; start: TripPoint; places: TripPlace[] }
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
export interface TripRoadChoice { manual?: boolean; checks?: string[]; diagnostics?: TripRoadChoiceDiagnostics; status: 'SELECTED' | 'CHOOSE' | 'NONE'; point: Coordinates | null; candidates: TripRoadCandidate[] }
export interface TripResult {
    index: number
    label: string
    start: Coordinates
    target: Coordinates
    status: 'AVAILABLE' | 'NEEDS_REFINEMENT' | 'NO_PATH' | 'UNKNOWN' | 'UNAVAILABLE' | 'OUTSIDE_PILOT'
    reason: string
    checks: string[]
    diagnostics?: TripDiagnostics
    route: { geometry: LineString; distance_m: number; duration_s: number } | null
    snaps: { start: TripSnap; target: TripSnap } | null
    road_choices?: { start: TripRoadChoice; target: TripRoadChoice } | null
    metrics: { distance: Omit<TransportMetric, 'key'> & { key: string; dataset_version: string | null }; duration: Omit<TransportMetric, 'key'> & { key: string; dataset_version: string | null } }
}
export interface TripAnalysis {
    mode: 'driving'
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
