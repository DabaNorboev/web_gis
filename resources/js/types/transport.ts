import type { Polygon } from 'geojson'

export interface Coordinates { lon: number; lat: number }
export type MetricKey = 'nearest_stop_distance' | 'stops_count' | 'unique_routes_count' | 'identified_routes_count'
export interface TransportMetric {
    key: MetricKey
    value: number | null
    unit: string
    source: string
    dataset_import_id: number | null
    observed_at: string | null
    source_updated_at?: string | null
    calculated_at: string
    quality: {
        method: string | null
        availability: 'AVAILABLE' | 'INSUFFICIENT_DATA' | 'UNAVAILABLE'
        freshness: 'CURRENT' | 'STALE' | 'UNKNOWN'
        reason: string
    }
}
export interface TransportStop extends Coordinates { id: number; source_id: string; name: string | null }
export interface SpatialCoverage {
    status: 'COVERED' | 'PARTIAL' | 'OUTSIDE_SERVICE_AREA' | 'UNKNOWN'
    reason: string
    dataset_import_id: number | null
    radius_m: number
    available_radius_m: number | null
    buffer_m: number | null
    service_boundary_sha256: string | null
    data_boundary_sha256: string | null
}
export interface TransportAnalysis {
    point: Coordinates
    radius_m: number
    scope: 'imported_stops'
    analysis_area: Polygon
    analysis_bounds: [number, number, number, number]
    nearest_stop: (TransportStop & { address: string | null }) | null
    stops_in_radius: (TransportStop & { distance_m: number })[]
    metrics: Record<MetricKey, TransportMetric>
    coverage: SpatialCoverage
}
