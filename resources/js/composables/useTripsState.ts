import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useTripAnalysis } from '@/composables/useTripAnalysis'
import { sameRoadPoint, type TripCandidateGroup } from '@/utils/tripCandidates'
import type { Coordinates } from '@/types/transport'
import type { TripAnalysis, TripMode, TripRoadCandidate, TripSelection, TripResult } from '@/types/trips'

interface TripsEffects {
    saveSelection: (value: TripSelection, mode: 'push' | 'replace') => void
    // The page captures user interaction/time and performs DOM work only for a current run.
    beginRun: (reveal: boolean) => (isCurrent: () => boolean) => Promise<void>
}

/** State and validity rules for standalone /trips; history and DOM belong to the page. */
export function useTripsState(effects: TripsEffects) {
    const blank = (label = ''): { lon: string | number; lat: string | number; label: string; road?: Coordinates } => ({ lon: '', lat: '', label })
    const draft = reactive({ start: blank(), places: [blank('Место 1')] })
    const mode = ref<TripMode>('driving')
    const noticeDismissed = ref(false)
    let acceptingRoads = false
    let selectingCandidate = false
    let restoringDraft = false
    const hasCalculated = ref(false)
    const dirtyIndices = ref<number[]>([])
    let runSequence = 0
    const candidateOptions = reactive<Record<string, TripRoadCandidate[]>>({})
    const hoveredCandidate = ref<string | null>(null)
    const focusedCandidate = ref<string | null>(null)
    const lastCandidateSource = ref<'pointer' | 'focus'>('pointer')
    const highlightedCandidate = computed(() => lastCandidateSource.value === 'pointer' ? hoveredCandidate.value ?? focusedCandidate.value : focusedCandidate.value ?? hoveredCandidate.value)
    const pendingChoiceIndices = ref<number[]>([])
    const failedChoiceIndices = ref<number[]>([])
    function clearCandidateState() {
        for (const key of Object.keys(candidateOptions)) delete candidateOptions[key]
        hoveredCandidate.value = null; focusedCandidate.value = null
        pendingChoiceIndices.value = []; failedChoiceIndices.value = []
    }
    const invalidLink = ref(false)
    const formError = ref('')
    const editedSinceResult = ref(false)
    const { analysis, status, error, clear, analyze } = useTripAnalysis()
    // Watch coordinates and object identity only: labels and checked road hints are not geometry edits.
    const positionKey = (p: { lon: string | number; lat: string | number }) => `${p.lon}|${p.lat}`
    watch(() => ({ start: positionKey(draft.start), places: draft.places.map(item => ({ item, position: positionKey(item) })) }), (current, previous) => {
        if (restoringDraft || acceptingRoads || selectingCandidate) return
        const startChanged = current.start !== previous.start
        if (startChanged) delete draft.start.road
        for (const entry of current.places) {
            const old = previous.places.find(p => p.item === entry.item)
            if (old && old.position !== entry.position) delete entry.item.road
        }
        const nextIndex = (oldIndex: number) => {
            const old = previous.places[oldIndex]
            return old ? current.places.findIndex(p => p.item === old.item && p.position === old.position) : -1
        }
        const previousAnalysis = analysis.value
        const retainedRows = startChanged ? [] : (previousAnalysis?.results ?? []).flatMap(row => {
            const index = nextIndex(row.index)
            // Pending or failed road choices have no confirmed result to retain.
            return index < 0 || pendingChoiceIndices.value.includes(row.index) || failedChoiceIndices.value.includes(row.index) ? [] : [index === row.index ? row : { ...row, index, diagnostics: row.diagnostics ? { ...row.diagnostics, issues: row.diagnostics.issues.map(issue => ({ ...issue, target_index: issue.target_index === row.index ? index : issue.target_index })) } : undefined }]
        })
        const options = { ...candidateOptions }
        clearCandidateState()
        if (!startChanged) {
            if (options.S) candidateOptions.S = options.S
            for (const [key, candidates] of Object.entries(options)) {
                if (key === 'S') continue
                const index = nextIndex(Number(key) - 1)
                if (index >= 0) candidateOptions[String(index + 1)] = candidates
            }
        }
        runSequence++
        if (previousAnalysis || status.value === 'loading') hasCalculated.value = true
        dirtyIndices.value = hasCalculated.value ? current.places.flatMap((_, i) => retainedRows.some(row => row.index === i) ? [] : [i]) : []
        editedSinceResult.value = hasCalculated.value && dirtyIndices.value.length > 0
        clear(retainedRows.length && previousAnalysis ? { ...previousAnalysis, results: retainedRows } : null)
        noticeDismissed.value = false
        formError.value = ''
    }, { flush: 'sync' })
    function readPoint(p: { lon: string | number; lat: string | number } | undefined): Coordinates | null {
        if (!p || !String(p.lon).trim() || !String(p.lat).trim()) return null
        const lon = Number(p.lon), lat = Number(p.lat)
        return Number.isFinite(lon) && Math.abs(lon) <= 180 && Number.isFinite(lat) && Math.abs(lat) <= 90 ? { lon, lat } : null
    }
    const points = computed(() => {
        const items: { key: string; point: Coordinates; road?: Coordinates }[] = []
        const start = readPoint(draft.start)
        if (start) items.push({ key: 'S', point: start, road: draft.start.road })
        draft.places.forEach((p, i) => { const point = readPoint(p); if (point) items.push({ key: String(i + 1), point, road: p.road }) })
        return items
    })
    function rowCandidateGroups(row: TripResult): TripCandidateGroup[] {
        const groups: TripCandidateGroup[] = []
        for (const end of ['start', 'target'] as const) {
            const key = end === 'start' ? 'S' : String(row.index + 1)
            const choice = row.road_choices?.[end]
            // Walking candidates are checked for this exact street input, never reusable hints.
            const options = mode.value === 'walking' ? (choice?.status === 'CHOOSE' ? choice.candidates : undefined)
                : candidateOptions[key] ?? (choice?.status === 'CHOOSE' || choice?.status === 'SELECTED' && choice.manual ? choice.candidates : undefined)
            const item = end === 'start' ? draft.start : draft.places[row.index]
            const selectedRoad = mode.value === 'walking' ? null : item?.road
            if (options?.length) groups.push({ key, label: end === 'start' ? 'Старт' : `Место ${row.index + 1}`, candidates: options,
                selected: selectedRoad && options.some(option => sameRoadPoint(option.point, selectedRoad)) ? selectedRoad : (mode.value === 'driving' && choice?.status === 'SELECTED' ? choice.point ?? null : null) })
        }
        return groups
    }
    const candidateGroups = computed(() => {
        const groups = new Map<string, TripCandidateGroup>()
        for (const row of analysis.value?.results ?? []) for (const group of rowCandidateGroups(row)) groups.set(group.key, group)
        return [...groups.values()]
    })
    function candidateFocus(id: string | null, source: 'pointer' | 'focus') {
        if (id) lastCandidateSource.value = source
        if (source === 'focus') focusedCandidate.value = id
        else hoveredCandidate.value = id
    }
    function rememberCandidates(result: TripAnalysis) {
        if (mode.value === 'walking') {
            for (const key of Object.keys(candidateOptions)) delete candidateOptions[key]
            return
        }
        for (const row of result.results) for (const end of ['start', 'target'] as const) {
            const choice = row.road_choices?.[end], key = end === 'start' ? 'S' : String(row.index + 1)
            if (choice?.candidates?.length && (choice.status === 'CHOOSE' || choice.status === 'SELECTED' && choice.manual && !candidateOptions[key])) candidateOptions[key] = choice.candidates
            else if (choice?.status === 'NONE') delete candidateOptions[key]
        }
    }
    function showAvailable(row: TripResult) { return row.status === 'AVAILABLE' && !pendingChoiceIndices.value.includes(row.index) && !failedChoiceIndices.value.includes(row.index) }

    function setRoad(key: string, point?: Coordinates) {
        const item = key === 'S' ? draft.start : draft.places[Number(key) - 1]
        if (!item) return
        const affected = key === 'S' ? draft.places.map((_, i) => i) : [Number(key) - 1]
        const previous = analysis.value
        const retained = previous ? { ...previous, results: previous.results.map(row => affected.includes(row.index)
            ? { ...row, route: null, snaps: null, road_choices: null, metrics: { distance: { ...row.metrics?.distance, value: null }, duration: { ...row.metrics?.duration, value: null } } }
            : row) } as TripAnalysis : null
        selectingCandidate = true
        try { if (point) item.road = point; else delete item.road } finally { selectingCandidate = false }
        if (!selection()) {
            // A road edit invalidates its result even when another point prevents a request.
            const invalidated = new Set([...affected, ...pendingChoiceIndices.value, ...failedChoiceIndices.value])
            const results = previous?.results.filter(row => !invalidated.has(row.index)) ?? []
            runSequence++
            clear(previous ? { ...previous, results } : null)
            pendingChoiceIndices.value = []; failedChoiceIndices.value = []
            dirtyIndices.value = hasCalculated.value ? draft.places.flatMap((_, i) => results.some(row => row.index === i) ? [] : [i]) : []
            editedSinceResult.value = dirtyIndices.value.length > 0
            noticeDismissed.value = false
        }
        calculate(retained, affected)
    }

    function chooseRoad(key: string, point: Coordinates) { setRoad(key, point) }
    function resetRoad(key: string) { setRoad(key) }
    function setMode(value: TripMode) {
        if (value === mode.value) return
        runSequence++
        clear()
        clearCandidateState()
        delete draft.start.road
        for (const place of draft.places) delete place.road
        mode.value = value
        hasCalculated.value = false; dirtyIndices.value = []
        editedSinceResult.value = false; noticeDismissed.value = false
        formError.value = ''; invalidLink.value = false
    }

    function selection(): TripSelection | null {
        const start = readPoint(draft.start)
        const places = draft.places.map((p, i) => { const point = readPoint(p); return point ? { ...point, ...(p.road ? { road: p.road } : {}), label: p.label.trim() || `Место ${i + 1}` } : null })
        if (!start || places.some(p => !p)) return null
        return { version: 1, mode: mode.value, start: { ...start, ...(draft.start.road ? { road: draft.start.road } : {}) }, places: places as TripSelection['places'] }
    }
    function submit() { if (status.value !== 'loading') calculate(null, [], true) }
    function calculate(retained: TripAnalysis | null = null, affected: number[] = [], reveal = false) {
        const chosen = selection()
        if (!chosen) { formError.value = 'Выберите старт и каждое место через поиск адреса или на карте.'; return }
        invalidLink.value = false
        effects.saveSelection(chosen, 'push')
        void run(chosen, retained ?? analysis.value, affected, reveal)
    }
    async function run(chosen: TripSelection, retained: TripAnalysis | null = null, affected: number[] = [], reveal = false) {
        const requestedIndices = affected.length ? affected : failedChoiceIndices.value.length ? [...failedChoiceIndices.value] : draft.places.map((_, index) => index)
        const settled = effects.beginRun(reveal)
        const request = ++runSequence
        noticeDismissed.value = false
        hasCalculated.value = true
        editedSinceResult.value = false
        pendingChoiceIndices.value = affected; failedChoiceIndices.value = []
        const result = await analyze(chosen, retained)
        if (request !== runSequence) return
        pendingChoiceIndices.value = []
        if (!result) {
            if (status.value === 'error') {
                failedChoiceIndices.value = requestedIndices
                // Pending rows are presentation only; a failed attempt cannot retain their old status.
                if (analysis.value) analysis.value = { ...analysis.value, results: analysis.value.results.filter(row => !failedChoiceIndices.value.includes(row.index)) }
            }
            await settled(() => request === runSequence)
            return
        }
        dirtyIndices.value = []
        rememberCandidates(result)
        acceptingRoads = true
        try {
            for (const row of chosen.mode === 'driving' ? result.results : []) {
                const a = row.road_choices?.start.point ?? row.snaps?.start.matched
                const b = row.road_choices?.target.point ?? row.snaps?.target.matched
                if (a) draft.start.road = a
                if (b && draft.places[row.index]) draft.places[row.index]!.road = b
            }
        } finally { acceptingRoads = false }
        const value = selection()
        if (value) effects.saveSelection(value, 'replace')
        await settled(() => request === runSequence)
    }
    function restore(value: TripSelection | null, invalid = false) {
        runSequence++; clearCandidateState()
        mode.value = value?.mode ?? 'driving'
        clear()
        editedSinceResult.value = false
        hasCalculated.value = false; dirtyIndices.value = []; formError.value = ''; noticeDismissed.value = false
        invalidLink.value = invalid
        restoringDraft = true
        draft.start = value ? { lon: String(value.start.lon), lat: String(value.start.lat), label: '', ...(value.start.road ? { road: value.start.road } : {}) } : blank()
        draft.places = value ? value.places.map(p => ({ lon: String(p.lon), lat: String(p.lat), label: p.label, ...(p.road ? { road: p.road } : {}) })) : [blank('Место 1')]
        restoringDraft = false
        if (value) void run(value)
    }
    function addPlace() {
        if (draft.places.length < 3) draft.places.push(blank(`Место ${draft.places.length + 1}`))
    }
    function removePlace(index: number) { draft.places.splice(index, 1) }
    // Transport guards writes to analysis. This epoch guards the subsequent domain effects
    // (candidate/hint acceptance and history), plus delayed DOM work in the page.
    onBeforeUnmount(() => { runSequence++ })
    return {
        draft, mode, setMode, resetRoad, analysis, status, error, noticeDismissed, hasCalculated, dirtyIndices,
        pendingChoiceIndices, failedChoiceIndices, invalidLink, formError, editedSinceResult,
        points, candidateGroups, highlightedCandidate, candidateFocus, rowCandidateGroups,
        readPoint, selection, showAvailable, submit, chooseRoad, addPlace, removePlace, restore,
    }
}
