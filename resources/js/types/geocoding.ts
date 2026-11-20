import type { AnalysisPoint } from './placeAnalysis'
export interface Attribution { text: string; url: string }
export interface GeocodingNumber { raw: string | null; key: string | null; base: string | null; fraction: string | null; letter: string | null; corpus: string | null; structure: string | null; parse_status: 'COMPLETE' | 'UNKNOWN' }
export interface GeocodingComponents { country_code: string | null; locality: string | null; street: string | null; number: GeocodingNumber }
export interface GeocodingPrecision { level: 'house' | 'street' | 'locality' | null; reason: string | null; accuracy_m: null; accuracy_reason: 'NOT_VALIDATED' }
export interface GeocodingSource { provider: 'geoapify'; provider_result_type: string | null; observed_at: null; source_updated_at: null; received_at: string; normalization_version: 1; attribution: Attribution[] }
export interface GeocodingCandidate {
    candidate_id: string; provider_id: string | null; label: string; components: GeocodingComponents
    point: AnalysisPoint | null; point_reason: string | null; precision: GeocodingPrecision
    number_match: 'EXACT' | 'MISMATCH' | 'UNKNOWN' | 'NOT_REQUESTED'; within_scope: true | null
    source: GeocodingSource; can_confirm: boolean; restrictions: string[]
    candidate_token: string | null; expires_at: string | null; reference_distance_m?: number
}
export interface GeocodedPlace { kind: 'address'; selection_id: string; label: string; point: AnalysisPoint; building: null; address: {
    provider_id: string; components: GeocodingComponents; precision: GeocodingPrecision; number_match: 'EXACT' | 'NOT_REQUESTED'
    source: GeocodingSource; scope_id: string; scope_sha256: string
} }
export interface GeocodingSelection { selection_id: string; selection_token: string; expires_at: string; snapshot_expires_at: string; place: GeocodedPlace }
export interface GeocodingMeta { contract_version: 1; request_id: string; provider: 'geoapify'; scope_id: string; scope_sha256: string; received_at: string | null; cache: 'HIT' | 'MISS' | 'NONE'; attribution: Attribution[] }
export interface GeocodingLookup { status: 'OK' | 'NO_SELECTABLE_RESULTS' | 'EMPTY'; reason: string | null; candidates: GeocodingCandidate[]; point?: AnalysisPoint }
