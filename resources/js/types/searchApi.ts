import type { AddressProfile } from './profile'
export type ProfileBlockKey = keyof AddressProfile['blocks']
export interface ResolvedAddress { address: AddressProfile['address']; capabilities: { resolver_version: 1; selected_profile_version: 1 } }
// A selected response is a distinct contract; the legacy full profile remains required/unchanged.
type WithFailureCode<T> = T extends { status: 'ERROR' } ? T & { code: 'BLOCK_CALCULATION_FAILED' | 'LAYER_CALCULATION_FAILED' } : T
export interface SelectedAddressProfile {
    scope: 'selected'
    profile_version: 1
    selected_blocks: ProfileBlockKey[]
    address: AddressProfile['address']
    point: AddressProfile['point']
    radius_m: 300 | 500
    calculated_at: string
    blocks: Partial<{ [K in ProfileBlockKey]: WithFailureCode<AddressProfile['blocks'][K]> }>
    map: Pick<AddressProfile['map'], 'analysis_area' | 'analysis_bounds'> & {
        stops_in_radius?: AddressProfile['map']['stops_in_radius']
        area_layers?: Partial<{ [K in keyof NonNullable<AddressProfile['map']['area_layers']>]: WithFailureCode<NonNullable<AddressProfile['map']['area_layers']>[K]> }>
        linear_layers?: Partial<{ [K in keyof NonNullable<AddressProfile['map']['linear_layers']>]: WithFailureCode<NonNullable<AddressProfile['map']['linear_layers']>[K]> }>
    }
}
