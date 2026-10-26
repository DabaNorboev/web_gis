import type { FeatureCollection, Polygon, MultiPolygon, LineString, MultiLineString } from 'geojson'
import type { AddressObject, AddressResult } from './address'
import type { SpatialCoverage, TransportAnalysis } from './transport'

export interface MetricResult {
    key: string
    value: number | null
    unit: string
    source: string
    dataset_import_id: number | null
    observed_at: string | null
    source_updated_at?: string | null
    calculated_at: string
    method_version?: string
    quality: {
        method: string | null
        availability: 'AVAILABLE' | 'INSUFFICIENT_DATA' | 'UNAVAILABLE'
        freshness: 'CURRENT' | 'STALE' | 'UNKNOWN'
        reason: string
    }
}
export interface AnalysisCategory {
    coverage: SpatialCoverage
    nearest: { id: string; name: string | null; access?: string | null; ref?: string | null } | null
    metrics: Record<string, MetricResult>
}
export type ProfileBlock<T> = { status: 'READY'; data: T; message: null } | { status: 'ERROR'; data: null; message: string }
export type AreaLayerKind = 'parks' | 'vegetation' | 'water'
export type AreaVisibility = Record<AreaLayerKind, boolean>
export interface AreaMapLayer extends FeatureCollection<Polygon | MultiPolygon, { id: string; name: string | null }> {
    coverage: SpatialCoverage
    source: string
    dataset_import_id: number | null
    observed_at: string | null
    source_updated_at: string | null
    quality: MetricResult['quality']
    radius_m: number
}
export type AreaLayers = Record<AreaLayerKind, ProfileBlock<AreaMapLayer>>
export type LinearLayerKind = 'roads' | 'railways'
export type LinearVisibility = Record<LinearLayerKind, boolean>
export interface LinearMapLayer extends FeatureCollection<LineString | MultiLineString, { id: string; name: string | null; feature_type: string }> {
    coverage: SpatialCoverage
    source: string
    dataset_import_id: number | null
    observed_at: string | null
    source_updated_at: string | null
    quality: MetricResult['quality']
    radius_m: number
}
export type LinearLayers = Record<LinearLayerKind, ProfileBlock<LinearMapLayer>>
export type EnvironmentKind = 'parks' | 'vegetation' | 'water' | 'roads' | 'railways'
export interface AddressProfile {
    address: {
        id: string
        label: string
        object: AddressObject
        bounds: AddressResult['bounds']
        source: string
        dataset_import_id: number
        observed_at: string | null
        source_updated_at: string | null
        reason: string
    }
    point: { lon: number; lat: number }
    radius_m: number
    calculated_at: string
    map: Pick<TransportAnalysis, 'analysis_area' | 'analysis_bounds' | 'stops_in_radius'> & { area_layers?: AreaLayers; linear_layers?: LinearLayers }
    blocks: { transport: ProfileBlock<TransportAnalysis> } & Record<EnvironmentKind, ProfileBlock<AnalysisCategory>>
}
