import type { TransportAnalysis } from '@/types/transport'

type NearbyStop = TransportAnalysis['stops_in_radius'][number]
export interface StopNameGroup {
    key: string
    name: string
    stops: NearbyStop[]
}

/** Presentation groups only: no spatial merging, direction inference, or removal of source points. */
export function groupStopsByName(stops: NearbyStop[]): StopNameGroup[] {
    const groups = new Map<string, StopNameGroup>()
    for (const stop of stops) {
        const name = stop.name?.trim().replace(/\s+/g, ' ') || 'Без названия'
        // Unnamed points must not be mistaken for a common named stop.
        const key = stop.name?.trim() ? `name:${name.toLocaleLowerCase('ru-RU')}` : `stop:${stop.id}`
        const group = groups.get(key) ?? { key, name, stops: [] }
        group.stops.push(stop)
        groups.set(key, group)
    }
    for (const group of groups.values()) group.stops.sort((a, b) => a.distance_m - b.distance_m || a.id - b.id)
    return [...groups.values()].sort((a, b) => a.stops[0]!.distance_m - b.stops[0]!.distance_m || a.stops[0]!.id - b.stops[0]!.id)
}
