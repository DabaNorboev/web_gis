import type { AddressProfile, EnvironmentKind } from './profile'

export type MapLayerKey = 'stops' | EnvironmentKind
export interface MapLayerContext {
    key: string
    label: string
    profile: AddressProfile | null
    loading: boolean
    selectedStop?: boolean
}
