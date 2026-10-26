export interface PointAddressCandidate {
    id: string
    label: string
    object_type: 'building' | 'address_point' | 'address_area'
    geometry_type: 'POINT' | 'POLYGON' | 'MULTIPOLYGON'
    distance_m: number
}
export interface PointAddressResponse {
    data: {
        match: 'CONTAINING' | 'NEARBY' | 'NONE'
        candidates: PointAddressCandidate[]
        requires_choice: boolean
    }
    meta: {
        source: string
        dataset_import_id: number | null
        observed_at: string | null
        source_updated_at: string | null
        calculated_at: string
        nearby_radius_m: number
        coverage: { status: string; reason: string }
        quality: {
            method: 'DERIVED' | 'PROXY' | null
            availability: 'AVAILABLE' | 'INSUFFICIENT_DATA' | 'UNAVAILABLE'
            freshness: string
            reason: string
        }
    }
}
