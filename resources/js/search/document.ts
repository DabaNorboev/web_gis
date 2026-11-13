import type { Coordinates } from '../types/transport'
import type { TripMode } from '../types/trips'
import type { AddressSelection, ChecklistBasis, DeepReadonly, Json, PlaceSelection, PreviousObject, Radius, SearchDocument, SelectionProvenance } from './types'

export function requireValue(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}
export function text(value: unknown, name: string): string {
    requireValue(typeof value === 'string' && value.trim().length > 0, `Invalid ${name}`)
    return value
}
export function integer(value: unknown): number {
    requireValue(Number.isSafeInteger(value) && (value as number) >= 0, 'Invalid revision')
    return value as number
}
export function mode(value: unknown): TripMode {
    requireValue(value === 'walking' || value === 'driving', 'Invalid mode')
    return value
}
export function radius(value: unknown): Radius {
    requireValue(value === 300 || value === 500, 'Invalid radius')
    return value
}
export function threshold(value: unknown): number | null {
    requireValue(value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0), 'Invalid threshold')
    return value as number | null
}
export function coordinates(value: Coordinates): Coordinates {
    requireValue(value && typeof value.lon === 'number' && Number.isFinite(value.lon) && Math.abs(value.lon) <= 180
        && typeof value.lat === 'number' && Number.isFinite(value.lat) && Math.abs(value.lat) <= 90, 'Invalid coordinates')
    return { lon: value.lon, lat: value.lat }
}
export function json(value: Json): Json {
    // Reject lossy JSON (NaN/undefined, class instances, cycles) rather than silently changing it.
    const seen = new Set<object>()
    function visit(v: Json): Json {
        if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
        if (typeof v === 'number') { requireValue(Number.isFinite(v), 'Invalid JSON number'); return v }
        requireValue(typeof v === 'object' && !seen.has(v), 'Invalid JSON value')
        requireValue(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null, 'Invalid JSON object')
        seen.add(v)
        const result = Array.isArray(v) ? v.map(visit) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]))
        seen.delete(v)
        return result
    }
    return visit(value)
}
function selectionProvenance(value: SelectionProvenance | null): SelectionProvenance | null {
    if (value === null) return null
    requireValue(value && typeof value === 'object', 'Invalid selection provenance')
    const nullableText = (v: string | null) => v === null ? null : text(v, 'provenance field')
    requireValue(value.datasetImportId === null || (Number.isSafeInteger(value.datasetImportId) && value.datasetImportId > 0), 'Invalid source import ID')
    return { source: nullableText(value.source), datasetImportId: value.datasetImportId,
        snapshot: nullableText(value.snapshot), observedAt: nullableText(value.observedAt), sourceUpdatedAt: nullableText(value.sourceUpdatedAt) }
}
export function selection(value: PlaceSelection): PlaceSelection {
    requireValue(value && (value.kind === 'address' || value.kind === 'point'), 'Invalid selection')
    const point = coordinates(value)
    const label = text(value.label, 'selection label')
    if (value.kind === 'point') return { kind: 'point', ...point, label }
    requireValue(/^osm:(node|way|relation):[1-9][0-9]{0,18}$/.test(value.addressId), 'Expected exact OSM address ID')
    return { kind: 'address', addressId: value.addressId, ...point, label, provenance: selectionProvenance(value.provenance) }
}
export function address(value: AddressSelection): AddressSelection {
    const normalized = selection(value)
    requireValue(normalized.kind === 'address', 'Candidate requires an address')
    return normalized
}
export function basis(value: ChecklistBasis): ChecklistBasis {
    requireValue(value && typeof value === 'object', 'Invalid basis')
    const placeId = value.placeId === null ? null : text(value.placeId, 'basis place ID')
    const placeSelection = value.placeSelection === null ? null : selection(value.placeSelection)
    const placeRevision = value.placeRevision === null ? null : integer(value.placeRevision)
    const placeMode = value.mode === null ? null : mode(value.mode)
    requireValue(placeId === null ? placeSelection === null && placeRevision === null && placeMode === null
        : placeSelection !== null && placeRevision !== null && placeMode !== null, 'Invalid place basis')
    return { address: address(value.address), selectionRevision: integer(value.selectionRevision), placeId,
        placeSelection, placeRevision, mode: placeMode, radius: radius(value.radius) }
}
function previousObject(value: PreviousObject | undefined, noteBasis: ChecklistBasis, ownerId: string): PreviousObject | undefined {
    if (value === undefined) return undefined
    requireValue(value && typeof value === 'object', 'Invalid previous object')
    const candidateId = text(value.candidateId, 'previous candidate ID'), original = address(value.address)
    requireValue(candidateId !== ownerId && JSON.stringify(original) === JSON.stringify(noteBasis.address), 'Previous object basis mismatch')
    return { candidateId, address: original }
}
export function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
export function immutable<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(immutable)
        Object.freeze(value)
    }
    return value
}

export function readonlySnapshot<T>(value: T): DeepReadonly<T> {
    return immutable(value) as DeepReadonly<T>
}

// Explicit input allowlist; source objects and runtime properties are never retained.
export function projectDocument(value: unknown): SearchDocument {
    const input = value as SearchDocument
    requireValue(input && typeof input === 'object', 'Invalid document')
    requireValue(Array.isArray(input.candidates) && input.candidates.length <= 5, 'Candidate limit')
    requireValue(Array.isArray(input.places) && input.places.length <= 3, 'Place limit')
    const ids = new Set<string>()
    const id = (value: unknown) => { const result = text(value, 'ID'); requireValue(!ids.has(result), 'Duplicate ID'); ids.add(result); return result }
    const searchId = id(input.searchId)
    const candidates = input.candidates.map(c => {
        requireValue(Array.isArray(c.notes) && Array.isArray(c.checklist), 'Invalid candidate annotations')
        const marks = new Set<string>()
        return { id: id(c.id), selectionRevision: integer(c.selectionRevision), address: address(c.address),
            notes: c.notes.map(n => {
                const noteBasis = basis(n.basis), origin = previousObject(n.previousObject, noteBasis, c.id)
                return { id: id(n.id), text: text(n.text, 'note'), placeId: n.placeId === null ? null : text(n.placeId, 'note place'),
                    basis: noteBasis, updatedAt: text(n.updatedAt, 'note time'), ...(origin ? { previousObject: origin } : {}) }
            }),
            checklist: c.checklist.map(m => {
                const ruleKey = text(m.ruleKey, 'checklist rule'), placeId = m.placeId === null ? null : text(m.placeId, 'checklist place')
                const key = JSON.stringify([ruleKey, placeId])
                requireValue(!marks.has(key) && typeof m.checked === 'boolean', 'Invalid checklist mark'); marks.add(key)
                return { ruleKey, placeId, checked: m.checked, basis: basis(m.basis), updatedAt: text(m.updatedAt, 'mark time') }
            }) }
    })
    const places = input.places.map(p => ({ id: id(p.id), selectionRevision: integer(p.selectionRevision), label: text(p.label, 'place label'),
        selection: selection(p.selection), mode: mode(p.mode), thresholdMinutes: threshold(p.thresholdMinutes) }))
    const member = (value: string | null) => { requireValue(value === null || candidates.some(c => c.id === value), 'Invalid pair member'); return value }
    const pair = { a: member(input.pair.a), b: member(input.pair.b) }
    requireValue(pair.a === null || pair.a !== pair.b, 'Pair must be distinct')
    requireValue(Array.isArray(input.streetChoices), 'Invalid street choices')
    const choices = new Set<string>()
    const streetChoices = input.streetChoices.map(s => {
        const c = candidates.find(c => c.id === s.candidateId), p = places.find(p => p.id === s.placeId)
        requireValue(c && p && s.mode === p.mode && s.candidateRevision === c.selectionRevision && s.placeRevision === p.selectionRevision, 'Invalid street dependency')
        const key = JSON.stringify([c.id, p.id]); requireValue(!choices.has(key), 'Duplicate street choice'); choices.add(key)
        return { candidateId: c.id, placeId: p.id, mode: mode(s.mode), candidateRevision: c.selectionRevision, placeRevision: p.selectionRevision,
            startRoad: s.startRoad === null ? null : coordinates(s.startRoad), targetRoad: s.targetRoad === null ? null : coordinates(s.targetRoad) }
    })
    for (const c of candidates) {
        for (const item of [...c.notes, ...c.checklist]) {
            requireValue(item.placeId === item.basis.placeId, 'Annotation basis mismatch')
        }
    }
    return { searchId, documentRevision: integer(input.documentRevision), candidates, places, pair, radius: radius(input.radius), streetChoices }
}
