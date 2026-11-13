import type { FeatureCollection } from 'geojson'
import type { HomeTripMapInput, HomeTripRef } from '@/types/homeWorkspace'
import type { HomeOrientationGroup } from '@/types/homeOrientations'
import type { ComparisonPlace } from '@/utils/comparisonTrips'
import type { Coordinates } from '@/types/transport'
import type { SideKey } from '@/utils/comparison'
import type { TripMapOverlay, TripMapMarker } from '@/utils/tripOverlay'
import { homeMapSignal } from '@/utils/homeMapSignal'

export const sameHomeTrip = (a: HomeTripRef | null, b: HomeTripRef | null) => !!a && !!b && a.scenario === b.scenario && a.placeId === b.placeId
    && (a.scenario !== 'addresses' || b.scenario === 'addresses' && a.side === b.side)
/** The cell token and original coordinates bind a rendered entity to its own
 * result. Display-only orientation edits and selection never change this ID. */
export function homeMapEntity(value: HomeTripMapInput): string {
    return JSON.stringify([value.trip, value.mode, value.overlay.sequence, value.overlay.data.features.filter(f => f.properties?.kind === 'original').map(f => f.geometry)])
}
export function homeMapOverview(values: HomeTripMapInput[], places: ComparisonPlace[], groups: HomeOrientationGroup[], selected: HomeTripRef | null, scope: 'all' | 'one', candidate: HomeTripMapInput | null, origins?: { side: SideKey; id: string; point: Coordinates }[]): TripMapOverlay {
    const data: FeatureCollection = { type: 'FeatureCollection', features: [] }
    const markers: TripMapMarker[] = []
    const active = selected && places.some(p => p.id === selected.placeId) ? selected : null
    const shown = values.filter(value => scope !== 'one' || active && value.trip.placeId === active.placeId)
    for (const value of [...shown].sort((a, b) => Number(sameHomeTrip(active, a.trip)) - Number(sameHomeTrip(active, b.trip)))) {
        const entity = homeMapEntity(value), isSelected = sameHomeTrip(active, value.trip)
        const accepted = value.overlay.data.features.some(feature => feature.properties?.kind === 'route')
        for (const feature of value.overlay.data.features) {
            if (['original', 'candidate'].includes(feature.properties?.kind) || !accepted && ['connector', 'matched'].includes(feature.properties?.kind)) continue
            data.features.push({ ...feature, properties: { ...feature.properties, entity,
                color: value.trip.scenario === 'addresses' && value.trip.side === 'right' ? '#386da6' : '#7058a5',
                routeSide: value.trip.scenario === 'addresses' ? value.trip.side : 'left',
                routeKey: JSON.stringify([value.trip.scenario, value.trip.placeId, value.trip.scenario === 'addresses' ? value.trip.side : null]),
                selected: isSelected, opacity: active && !isSelected ? .6 : 1 } })
        }
    }
    // Candidates retain the selected owner's original sequence/IDs. They are
    // never gathered from other cells or turned into overview selections.
    if (candidate && shown.some(value => sameHomeTrip(value.trip, candidate.trip))) {
        data.features.push(...candidate.overlay.data.features.filter(f => f.properties?.kind === 'candidate'))
    }
    const starts = origins ?? (['left', 'right'] as const).flatMap(side => {
        const value = values.find(value => value.trip.scenario === 'addresses' && value.trip.side === side)
        const original = value?.overlay.data.features.find(f => f.properties?.kind === 'original')
        return original?.geometry.type === 'Point' ? [{ side, id: side, point: { lon: original.geometry.coordinates[0]!, lat: original.geometry.coordinates[1]! } }] : []
    })
    for (const start of starts) {
        const id = JSON.stringify(['address', start.side, start.id, start.point])
        markers.push({ id, entity: id, point: start.point, title: start.side === 'left' ? 'А' : 'Б', signal: '',
            detail: `Исходный адрес ${start.side === 'left' ? 'А' : 'Б'}. Вход и подход не подтверждены. Открыть профиль адреса.`, shape: start.side, selected: false })
    }
    for (const place of places) {
        const value = shown.find(value => value.trip.placeId === place.id && sameHomeTrip(active, value.trip)) ?? shown.find(value => value.trip.placeId === place.id)
        if (!place.point || !value) continue
        const group = groups.find(group => group.target.kind === 'trip' && group.target.scenario === 'addresses' && group.target.placeId === place.id && group.target.mode === value.mode)
        const signals = (group?.cells ?? []).map(cell => ({ cell, signal: homeMapSignal(cell) }))
        markers.push({ id: `goal:${homeMapEntity(value)}`, entity: homeMapEntity(value), point: place.point, title: `${places.indexOf(place) + 1}. ${place.label || 'Без названия'}`, shape: 'goal', selected: active?.placeId === place.id,
            signal: signals.map(({ cell, signal }) => `${cell.side === 'left' ? 'А' : 'Б'} ${signal.short}`).join(' · '),
            detail: signals.map(({ signal }) => signal.detail).join('. ') })
    }
    // Include original points for explicit focus bounds, rendered by HTML labels.
    for (const marker of markers) data.features.push({ type: 'Feature', properties: { kind: 'home-anchor', entity: marker.id }, geometry: { type: 'Point', coordinates: [marker.point.lon, marker.point.lat] } })
    return { data, markers: markers.sort((a, b) => Number(b.shape === 'goal') - Number(a.shape === 'goal')), sequence: 0, interactive: true }
}
