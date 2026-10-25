import type { AddressProfile, EnvironmentKind } from '@/types/profile'

// A metric's nearest object can lie outside the clipped map collection. Only
// offer an exact-object action when that same source ID has geometry here.
export function mappedNearestId(profile: AddressProfile | null, kind: EnvironmentKind): string | undefined {
    const id = profile?.blocks[kind].data?.nearest?.id
    if (!id) return undefined
    const data = kind === 'roads' || kind === 'railways' ? profile?.map?.linear_layers?.[kind]?.data : profile?.map?.area_layers?.[kind]?.data
    return data?.features.some(feature => feature.properties.id === id) ? id : undefined
}
