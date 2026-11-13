import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { fetchTrips } from '@/api/trips'
import { copyPoint, selectedPoint } from '@/utils/trips'
import type { Coordinates } from '@/types/transport'
import type { TripAnalysis, TripPoint, TripResult, TripRoadCandidate, TripMode } from '@/types/trips'
import type { SideKey } from '@/utils/comparison'
import type { ComparisonPlace, ComparisonTripHints, ComparisonTripLink } from '@/utils/comparisonTrips'

export interface ComparisonTripCell {
    row: TripResult | null
    source: TripAnalysis['source']
    limitation: string
    status: 'idle' | 'loading' | 'ready' | 'error'
    error: string
    hints: ComparisonTripHints
    options: { start: TripRoadCandidate[]; target: TripRoadCandidate[] }
    epoch: number
}
const sides: SideKey[] = ['left', 'right']
export function useComparisonTrips() {
    const places = ref<ComparisonPlace[]>([])
    const mode = ref<TripMode>('driving')
    const starts = reactive<Record<SideKey, { id: string | null; point: Coordinates | null }>>({ left: { id: null, point: null }, right: { id: null, point: null } })
    const cells = reactive<Record<SideKey, Record<string, ComparisonTripCell>>>({ left: Object.create(null), right: Object.create(null) })
    const requests = new Set<AbortController>()
    let serial = 0, epochSequence = 0, disposed = false
    const formError = ref('')
    function cell(side: SideKey, id: string): ComparisonTripCell {
        return cells[side][id] ??= { row: null, source: null, limitation: '', status: 'idle', error: '', hints: {}, options: { start: [], target: [] }, epoch: 0 }
    }
    function invalidate(side: SideKey, id: string, clearHints = false) {
        const value = cell(side, id)
        value.epoch = ++epochSequence; value.row = null; value.source = null; value.limitation = ''; value.status = 'idle'; value.error = ''
        if (clearHints) value.hints = {}
        // Walking candidates describe the input of one completed verification.
        // A new street edit or request must not reuse distances from that input.
        if (clearHints || mode.value === 'walking') value.options = { start: [], target: [] }
    }
    function setMode(next: TripMode) {
        if ((next !== 'driving' && next !== 'walking') || next === mode.value) return
        for (const request of requests) request.abort()
        requests.clear()
        for (const side of sides) for (const id of Object.keys(cells[side])) invalidate(side, id, true)
        formError.value = ''
        mode.value = next
    }
    function setStart(side: SideKey, id: string | null, point: Coordinates | null) {
        const previous = starts[side]
        const changed = id !== previous.id || (point && previous.point && (point.lon !== previous.point.lon || point.lat !== previous.point.lat))
        if (changed) for (const place of places.value) invalidate(side, place.id, true)
        starts[side] = { id, point: point ? { ...point } : id === previous.id ? previous.point : null }
    }
    function add() {
        if (places.value.length >= 3) return
        let id: string
        do { id = `p${Date.now().toString(36)}_${++serial}` } while (places.value.some(place => place.id === id))
        const place = { id, label: `Место ${places.value.length + 1}`, point: null }
        places.value.push(place)
        for (const side of sides) cell(side, place.id)
        return place.id
    }
    function setPoint(id: string, point: Coordinates | null) {
        if (point && !selectedPoint(point)) { formError.value = 'Координаты цели вне допустимого диапазона. Выберите точку на карте Красноярска.'; return }
        const place = places.value.find(p => p.id === id)
        if (!place || (place.point?.lon === point?.lon && place.point?.lat === point?.lat)) return
        for (const side of sides) invalidate(side, id, true)
        place.point = point ? { ...point } : null
        formError.value = ''
    }
    function remove(id: string) {
        for (const side of sides) { invalidate(side, id); delete cells[side][id] }
        places.value = places.value.filter(p => p.id !== id)
    }
    function setRoad(side: SideKey, id: string, end: 'start' | 'target', point: Coordinates | null) {
        if (!places.value.some(place => place.id === id)) return
        // Clear BEFORE checking completeness: old success cannot survive an incomplete edit.
        invalidate(side, id)
        const hints = cell(side, id).hints
        if (point && selectedPoint(point)) hints[end] = { ...point }
        else delete hints[end]
    }
    async function calculate(onlySide?: SideKey, onlyId?: string) {
        formError.value = ''
        const selected = places.value.filter(p => !onlyId || p.id === onlyId)
        if (!selected.length || selected.some(p => !p.point) || (onlySide ? !starts[onlySide].point : sides.some(s => !starts[s].point))) {
            formError.value = 'Выберите оба адреса и точки личных мест. Для отдельного повтора достаточно адреса его стороны и этой цели.'
            return
        }
        const requestMode = mode.value
        const tasks: Promise<void>[] = []
        for (const side of onlySide ? [onlySide] : sides) {
            const groups = new Map<string, { id: string; label: string; point: TripPoint; epoch: number }[]>()
            for (const place of selected) {
                invalidate(side, place.id)
                const value = cell(side, place.id)
                value.status = 'loading'
                const road = value.hints.start
                const key = JSON.stringify(road ?? null)
                const group = groups.get(key) ?? []
                group.push({ id: place.id, label: place.label, point: { ...place.point!, ...(value.hints.target ? { road: value.hints.target } : {}) }, epoch: value.epoch })
                groups.set(key, group)
            }
            for (const group of groups.values()) {
                const start: TripPoint = { ...starts[side].point!, ...(cell(side, group[0]!.id).hints.start ? { road: cell(side, group[0]!.id).hints.start } : {}) }
                const controller = new AbortController(); requests.add(controller)
                const current = (item: typeof group[number]) => !disposed && mode.value === requestMode && cells[side][item.id]?.epoch === item.epoch
                const timeout = setTimeout(() => controller.abort(), 20000)
                tasks.push((async () => {
                    try {
                        const response = await fetchTrips({ version: 1, mode: requestMode, start, places: group.map(p => ({ ...copyPoint(p.point), label: p.label })) }, controller.signal)
                        for (const [index, item] of group.entries()) if (current(item)) {
                            // Keep request-local index on the row. A single-target retry always has index 0.
                            const row = response.results.find(r => r.index === index)
                            if (response.mode !== requestMode || !row || row.start.lon !== start.lon || row.start.lat !== start.lat || row.target.lon !== item.point.lon || row.target.lat !== item.point.lat) {
                                Object.assign(cell(side, item.id), { status: 'error', error: 'Ответ не соответствует выбранным точкам. Повторите расчёт.' }); continue
                            }
                            Object.assign(cell(side, item.id), { row, source: response.source, limitation: response.limitation, status: 'ready' })
                            for (const end of ['start', 'target'] as const) {
                                const choice = row.road_choices?.[end]
                                if (requestMode === 'walking') cell(side, item.id).options[end] = choice?.status === 'CHOOSE' ? choice.candidates ?? [] : []
                                else if (choice?.status === 'CHOOSE' || choice?.manual) cell(side, item.id).options[end] = choice.candidates ?? []
                                else if (choice?.status === 'NONE') cell(side, item.id).options[end] = []
                            }
                        }
                    } catch {
                        for (const item of group) if (current(item)) Object.assign(cell(side, item.id), { row: null, status: 'error', error: controller.signal.aborted ? 'Расчёт занял слишком много времени. Повторите.' : 'Расчёт не получен. Точки сохранены; повторите без обязательной перестановки.' })
                    } finally { clearTimeout(timeout); requests.delete(controller) }
                })())
            }
        }
        await Promise.allSettled(tasks)
    }
    function reset() {
        for (const request of requests) request.abort()
        requests.clear()
        for (const place of [...places.value]) remove(place.id)
        formError.value = ''
    }
    function restore(selection: ComparisonTripLink | null) {
        reset()
        setMode(selection?.mode ?? 'driving')
        if (!selection) return
        places.value = selection.places.map(p => ({ ...p, point: { ...p.point } }))
        for (const side of sides) for (const place of places.value) {
            const hints = selection.roads[side]?.[place.id]
            if (hints) cell(side, place.id).hints = { ...hints }
        }
    }
    const linkSelection = computed<ComparisonTripLink | null>(() => !places.value.length || places.value.some(p => !p.point) ? null : ({
        version: mode.value === 'walking' ? 2 : 1, mode: mode.value, places: places.value.map(p => ({ id: p.id, label: p.label, point: { ...p.point! } })),
        roads: Object.fromEntries(sides.map(side => [side, Object.fromEntries(places.value.map(p => [p.id, { ...cell(side, p.id).hints }]))])),
    }))
    onBeforeUnmount(() => { disposed = true; reset() })
    return { mode, setMode, places, starts, cells, cell, setStart, add, setPoint, remove, setRoad, calculate, reset, restore, linkSelection, formError }
}
