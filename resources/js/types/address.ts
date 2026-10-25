import type { Point, Polygon, MultiPolygon } from 'geojson'
import type { Coordinates } from '@/types/transport'

export interface AddressObject extends Coordinates {
    id: string
    point_method: 'osm_node' | 'point_on_surface'
    object_type: 'building' | 'address_point' | 'address_area'
    geometry: Point | Polygon | MultiPolygon
    levels: string | null
}
export interface AddressResult {
    id: string
    label: string
    match_type: 'exact' | 'approximate'
    object_count: number
    bounds: [number, number, number, number]
    objects: AddressObject[]
}
export interface AddressSearchResponse {
    data: AddressResult[]
    meta: {
        source: string
        dataset_import_id: number | null
        unknown_locality_allowed?: boolean
        observed_at: string | null
        source_updated_at: string | null
        quality: { availability: 'AVAILABLE' | 'UNAVAILABLE'; freshness: string; reason: string }
    }
}
