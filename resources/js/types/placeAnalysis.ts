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
export interface PoiData { official_stop_summary?: { found_count: number | null; source_without_coordinates: number | null; excluded_outside_scope?: number }; items: AnalysisPoi[]; count: number | null; counts_by_category: Record<PoiCategory, number | null> }
export interface SatelliteScene {
    scene_id: string; product_uri: string; tile: string; platform: string; baseline: string; datatake: string
    acquired_at_catalog: string; acquired_at_granule: string
}
export interface SatelliteWarning { code: string; message: string }
export interface SatelliteReleaseRef {
    date: string; release_id: string; manifest_sha256: string
    scenes: SatelliteScene[]; warnings: SatelliteWarning[]; limitations: string[]
}
export interface SatelliteCoverage {
    circle_pixels: number; source_footprint_pixels: number; prepared_pixels: number
    outside_rectangle_pixels: number; inside_rectangle_outside_target_pixels: number
    geographic_pixels: number; usable_pixels: number
    source_footprint_fraction: number; prepared_fraction: number; geographic_fraction: number; usable_fraction: number
    reason_counts: Record<string, number>; source_pixels: Record<string, number>
    scope: string
}
export interface SatelliteRelease extends SatelliteReleaseRef {
    status: 'READY' | 'UNAVAILABLE'
    reason: string | null
    coverage: SatelliteCoverage | null
    mean_ndvi: number | null
    mean_ndvi_reason: string | null
}
export interface SatelliteLegendClass { min: number; max: number; color: string; label: string }
export interface SatelliteLegend {
    version: string; units: string; intervals: string
    unknown: { color: string; label: string }
    classes: SatelliteLegendClass[]
}
export type SatelliteLayerKey = 'true-color' | 'ndvi'
export interface SatelliteRasterSource {
    type: 'raster'
    tiles: string[]
    bounds: [number, number, number, number]
    tileSize: number
    minzoom: number
    maxzoom: number
    scheme: 'xyz'
    attribution: string
}
export interface SatelliteSelected {
    date: string | null
    status: 'READY' | 'UNAVAILABLE'
    reason: string | null
    coverage: SatelliteCoverage | null
    mean_ndvi: number | null
    mean_ndvi_reason: string | null
    layers: Partial<Record<SatelliteLayerKey, SatelliteRasterSource>> | null
    release_id?: string
    manifest_sha256?: string
    scenes?: SatelliteScene[]
    warnings?: SatelliteWarning[]
    limitations?: string[]
}
export interface SatelliteData {
    status: 'READY'
    reason: null
    catalog_sha256: string
    source_index_sha256: string
    method_version: string
    mask_version: string
    legend_version: string
    available_dates: SatelliteReleaseRef[]
    releases: SatelliteRelease[]
    delivery_status: 'READY' | 'UNAVAILABLE'
    legend: SatelliteLegend
    selected: SatelliteSelected
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
