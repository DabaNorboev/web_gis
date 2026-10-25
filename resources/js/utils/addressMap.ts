import type { FeatureCollection } from 'geojson'
import type { AddressResult } from '@/types/address'

export interface AddressMapState {
    groups: AddressResult[]
    selectedId: string | null
    highlightedId: string | null
    highlightedGroupId: string | null
}
export function addressFeatures(state: AddressMapState): FeatureCollection {
    const objects = new Map<string, FeatureCollection['features'][number]>()
    for (const group of state.groups) for (const [index, object] of group.objects.entries()) {
        const highlighted = object.id === state.highlightedId || group.id === state.highlightedGroupId
        const prior = objects.get(object.id)
        objects.set(object.id, { type: 'Feature', properties: { kind: 'address-object', id: object.id, group_id: group.id, number: index + 1, selected: object.id === state.selectedId, highlighted: highlighted || prior?.properties?.highlighted === true }, geometry: object.geometry })
    }
    return { type: 'FeatureCollection', features: [...objects.values()] }
}
// Use the bounds supplied by the API; no geometry measurements are made in the UI.
export function addressBounds(groups: AddressResult[]): [number, number, number, number] | null {
    if (!groups.length) return null
    return [Math.min(...groups.map(g => g.bounds[0])), Math.min(...groups.map(g => g.bounds[1])), Math.max(...groups.map(g => g.bounds[2])), Math.max(...groups.map(g => g.bounds[3]))]
}
