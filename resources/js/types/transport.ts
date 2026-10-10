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
export interface TransportStop extends Coordinates { id: number; source_id: string; name: string }
export interface TransportAnalysis {
    point: Coordinates
    radius_m: number
    scope: 'imported_stops'
    analysis_area: Polygon
    nearest_stop: (TransportStop & { address: string | null }) | null
    stops_in_radius: TransportStop[]
    metrics: Record<MetricKey, TransportMetric>
}
