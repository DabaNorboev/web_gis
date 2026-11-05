import type { Point, Polygon, MultiPolygon } from 'geojson'

export type AnalysisBlockKey = 'poi' | 'satellite' | 'air'
export type PoiCategory = 'grocery' | 'pharmacy' | 'official_stop' | 'park'
export interface AnalysisPoint { lon: number; lat: number }
export type AnalysisPlace = { kind: 'address'; address_id: string } | ({ kind: 'point' } & AnalysisPoint)
export interface StationSelection { selected_ids: string[]; radius_m: number }
export interface PlaceAnalysisInput {
    place: AnalysisPlace
    radius_m?: number
    date?: string
    stations?: Partial<StationSelection>
    blocks?: AnalysisBlockKey[]
}
export interface AnalysisRequest {
    place: AnalysisPlace
    radius_m: number
    date: string | null
    stations: StationSelection
    blocks: AnalysisBlockKey[]
}
export interface AnalysisAddress {
    id: string; label: string
    object: AnalysisPoint & { id: string; geometry: Point | Polygon | MultiPolygon; point_method: 'osm_node' | 'point_on_surface'; object_type: 'building' | 'address_point' | 'address_area'; levels: string | null }
    bounds: [number, number, number, number]
    source: string; dataset_import_id: number; observed_at: string | null; source_updated_at: string | null; reason: string
}
export interface AnalysisCoverage {
    status: 'COVERED' | 'PARTIAL' | 'OUTSIDE_SERVICE_AREA' | 'UNKNOWN'
    reason: string; available_radius_m: number | null
    by_category?: Record<PoiCategory, AnalysisCoverage>
}
export interface AnalysisCompleteness {
    status: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN'; reason: string
    by_category?: Record<PoiCategory, AnalysisCompleteness>
}
export interface AnalysisPoi {
    source_version?: string | null
    source_url?: string | null
    limitations?: string | null
    identity_note?: string | null
    id: string; category: PoiCategory; name: string | null; address: string | null
    geometry: Point | Polygon | MultiPolygon; point: AnalysisPoint; distance_m: number
    access: string | null; source: string; dataset_import_id: number | null
    observed_at: string | null; source_updated_at: string | null
}
export interface PoiData { official_stop_summary?: { found_count: number | null; source_without_coordinates: number | null }; items: AnalysisPoi[]; count: number | null; counts_by_category: Record<PoiCategory, number | null> }
export interface SatelliteData {
    available_dates: { date: string; scene_id: string; cloud_cover_percent: number | null }[]
    // Scene/assets are supplied by A10. The current screen does not render unchecked raster assets.
    selected: { status: 'READY' | 'UNAVAILABLE' | 'ERROR'; code?: string | null; message?: string | null } | null
}
export interface AnalysisStation extends AnalysisPoint {
    id: string; name: string; source: string; dataset_import_id: number; distance_m: number
    group: 'selected' | 'nearest' | 'other'; selected: boolean; status: 'ACTIVE' | 'INACTIVE' | 'UNKNOWN'
}
export interface AirData { stations: AnalysisStation[]; missing_selected_ids: string[]; counts: { selected: number; nearest: number; other: number } }
export interface BlockData { poi: PoiData; satellite: SatelliteData; air: AirData }
export type AnalysisBlock<K extends AnalysisBlockKey = AnalysisBlockKey> = {
    availability_by_category?: Record<PoiCategory, { status: 'READY' | 'UNAVAILABLE' | 'ERROR'; code: string | null; message: string }>
    method_version?: string
    calculated_at: string; coverage: AnalysisCoverage | null; completeness: AnalysisCompleteness | null
} & ({ status: 'READY'; code: null; message: string | null; data: BlockData[K] }
    | { status: 'UNAVAILABLE' | 'ERROR'; code: string; message: string; data: null })
export interface PlaceAnalysisResponse {
    analysis_version: 1
    place: { kind: 'address' | 'point'; label: string | null; address: AnalysisAddress | null; point: AnalysisPoint }
    radius_m: number; date: string | null; station_selection: StationSelection
    analysis_area: Polygon; analysis_bounds: [number, number, number, number]; calculated_at: string
    blocks: Partial<{ [K in AnalysisBlockKey]: AnalysisBlock<K> }>
}
