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
    calculated_at: string
    quality: {
        method: string | null
        availability: 'AVAILABLE' | 'INSUFFICIENT_DATA' | 'UNAVAILABLE'
        freshness: 'CURRENT' | 'STALE' | 'UNKNOWN'
        reason: string
    }
}
export interface TransportAnalysis {
    point: Coordinates
    radius_m: number
    scope: 'imported_stops'
    analysis_area: Polygon
    nearest_stop: (Coordinates & { id: number; name: string; address: string | null }) | null
    metrics: Record<MetricKey, TransportMetric>
}
