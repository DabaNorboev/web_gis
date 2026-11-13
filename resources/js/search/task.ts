import type { Coordinates } from '../types/transport'
import type { TripMode } from '../types/trips'
import { address, coordinates, copy, immutable, json, mode, projectDocument, radius, readonlySnapshot, requireValue, selection, text, threshold } from './document'
import { environmentBlocks } from './types'
import type { AddressSelection, CalculationCell, CalculationInput, CalculationJob, CalculationOutcome, ChecklistBasis, DeepReadonly, EnvironmentBlock, Json, MissingCandidateReplacement, PlaceSelection, RequestFailure, RequestToken, Resolution, ResolutionRequest, ResolutionStatus, SearchDocument, SearchSnapshot, SearchTaskPorts, Section, TripOutcome } from './types'

const tripStatuses = ['AVAILABLE', 'NEEDS_REFINEMENT', 'NO_PATH', 'UNKNOWN', 'UNAVAILABLE', 'OUTSIDE_PILOT']
const environmentStatuses = ['READY', 'ERROR', 'UNAVAILABLE', 'OUTSIDE_SERVICE_AREA', 'UNKNOWN']
const sections: Section[] = ['conditions', 'territory', 'addresses', 'comparison', 'visit']
const keyOf = (input: CalculationInput) => JSON.stringify(input.kind === 'trip'
    ? ['trip', input.candidateId, input.placeId] : ['environment', input.candidateId, input.block])
// Ordered, allowlisted tuples avoid object-property order and irrelevant labels in stamps.
function stamp(input: CalculationInput): string {
    const point = (p: Coordinates | null) => p === null ? null : [p.lon, p.lat]
    return JSON.stringify(input.kind === 'trip'
        ? ['trip', input.candidateId, input.placeId, input.candidateRevision, input.placeRevision, input.startAddressId, input.targetAddressId,
            point(input.start), point(input.target), input.mode, point(input.startRoad), point(input.targetRoad)]
        : ['environment', input.candidateId, input.candidateRevision, input.addressId, point(input.point), input.radius, input.block])
}

/** Pure task owner. Ports provide identity/time only; there is no implicit I/O. */
export function createSearchTask(ports: SearchTaskPorts) {
    const usedIds = new Set<string>()
    function nextId(): string {
        const id = text(ports.nextId(), 'generated ID')
        requireValue(!usedIds.has(id), 'ID was already used')
        usedIds.add(id)
        return id
    }
    const now = () => text(ports.now(), 'clock time')
    let document: SearchDocument = { searchId: nextId(), documentRevision: 0, candidates: [], places: [],
        pair: { a: null, b: null }, radius: 500, streetChoices: [] }
    let generation = 0, serial = 0
    let view: SearchSnapshot['view'] = { section: 'conditions', candidateId: null }
    const cells = new Map<string, CalculationCell>()
    const epochs = new Map<string, number>()
    const pending = new Map<string, CalculationJob>()
    const resolutions = new Map<string, Resolution>()
    const resolving = new Map<string, Readonly<ResolutionRequest>>()
    const replacementConfirmations = new WeakMap<DeepReadonly<MissingCandidateReplacement>, Resolution>()
    const resolutionKey = (kind: Resolution['kind'], id: string) => JSON.stringify([kind, id])
    const candidate = (id: string) => {
        const c = document.candidates.find(c => c.id === id)
        requireValue(c, 'Candidate not found'); return c
    }
    const place = (id: string) => {
        const p = document.places.find(p => p.id === id)
        requireValue(p, 'Place not found'); return p
    }
    const changed = () => { document.documentRevision++ }
    function setResolution(kind: Resolution['kind'], id: string, status: ResolutionStatus) {
        resolutions.set(resolutionKey(kind, id), { kind, id, status })
    }
    function resolved(kind: Resolution['kind'], id: string): boolean {
        return resolutions.get(resolutionKey(kind, id))?.status === 'resolved'
    }
    function currentBasis(candidateId: string, placeId: string | null): ChecklistBasis {
        const c = candidate(candidateId), p = placeId === null ? null : place(placeId)
        return { address: copy(c.address), selectionRevision: c.selectionRevision, placeId,
            placeSelection: p ? copy(p.selection) : null, placeRevision: p?.selectionRevision ?? null,
            mode: p?.mode ?? null, radius: document.radius }
    }
    function basisCurrent(candidateId: string, basis: ChecklistBasis): boolean {
        if (basis.placeId !== null && !document.places.some(p => p.id === basis.placeId)) return false
        return JSON.stringify(basis) === JSON.stringify(currentBasis(candidateId, basis.placeId))
    }
    function inputFor(candidateId: string, part: { placeId: string } | { block: EnvironmentBlock }): CalculationInput {
        const c = candidate(candidateId)
        if ('block' in part) {
            requireValue(environmentBlocks.includes(part.block), 'Invalid environment block')
            return { kind: 'environment', candidateId, candidateRevision: c.selectionRevision,
                addressId: c.address.addressId, point: coordinates(c.address), radius: document.radius, block: part.block }
        }
        const p = place(part.placeId)
        const choice = document.streetChoices.find(s => s.candidateId === candidateId && s.placeId === p.id)
        return { kind: 'trip', candidateId, placeId: p.id, candidateRevision: c.selectionRevision, placeRevision: p.selectionRevision,
            startAddressId: c.address.addressId, targetAddressId: p.selection.kind === 'address' ? p.selection.addressId : null,
            startLabel: c.address.label, targetLabel: p.label, start: coordinates(c.address), target: coordinates(p.selection), mode: p.mode,
            startRoad: choice?.startRoad ? coordinates(choice.startRoad) : null, targetRoad: choice?.targetRoad ? coordinates(choice.targetRoad) : null }
    }
    function invalidate(matches: (input: CalculationInput) => boolean, stale: boolean) {
        for (const [key, cell] of cells) {
            const input = pending.get(key)?.input ?? cell.result?.input
            if (!input || !matches(input)) continue
            pending.delete(key)
            epochs.set(key, (epochs.get(key) ?? 0) + 1)
            if (stale && cell.result) cells.set(key, { ...cell, phase: 'settled', freshness: 'stale', error: null })
            else cells.delete(key)
        }
    }
    function resetCandidate(id: string) {
        invalidate(i => i.candidateId === id, false)
        document.streetChoices = document.streetChoices.filter(s => s.candidateId !== id)
    }
    function resetPlace(id: string) {
        invalidate(i => i.kind === 'trip' && i.placeId === id, false)
        document.streetChoices = document.streetChoices.filter(s => s.placeId !== id)
    }
    function checkReady(input: CalculationInput) {
        requireValue(resolved('candidate', input.candidateId), 'Candidate address needs resolution')
        if (input.kind === 'trip') requireValue(resolved('place', input.placeId), 'Place needs resolution')
    }
    function enqueue(inputs: CalculationInput[]): readonly DeepReadonly<CalculationJob>[] {
        // All dependencies are checked before changing any cell.
        requireValue(inputs.length > 0, 'No resolved candidate available')
        inputs.forEach(checkReady)
        const requestedAt = now()
        const jobs = inputs.map(input => {
            const key = keyOf(input), epoch = (epochs.get(key) ?? 0) + 1
            epochs.set(key, epoch)
            const token = immutable({ generation, epoch, inputStamp: stamp(input), serial: ++serial })
            const job = immutable({ token, input: copy(input), requestedAt })
            pending.set(key, job)
            const previous = cells.get(key)
            cells.set(key, { key, phase: 'queued', freshness: previous?.freshness ?? 'none', result: previous?.result ?? null, error: null })
            return job
        })
        return immutable(jobs)
    }
    function active(token: DeepReadonly<RequestToken>): CalculationJob | null {
        const job = [...pending.values()].find(j => j.token === token)
        if (!job || token.generation !== generation || epochs.get(keyOf(job.input)) !== token.epoch) return null
        const input = job.input
        if (!document.candidates.some(c => c.id === input.candidateId)
            || (input.kind === 'trip' && !document.places.some(p => p.id === input.placeId))) return null
        const current = inputFor(input.candidateId, input.kind === 'trip' ? { placeId: input.placeId } : { block: input.block })
        return stamp(current) === token.inputStamp ? job : null
    }
    function allInputs(candidateIds: string[]): CalculationInput[] {
        return candidateIds.flatMap(id => {
            candidate(id)
            if (!resolved('candidate', id)) return []
            return [...document.places.filter(p => resolved('place', p.id)).map(p => inputFor(id, { placeId: p.id })), ...environmentBlocks.map(block => inputFor(id, { block }))]
        })
    }
    function cellFor(input: CalculationInput): CalculationCell {
        const key = keyOf(input)
        return cells.get(key) ?? { key, phase: 'not_calculated', freshness: 'none', result: null, error: null }
    }
    function normalizeOutcome(input: CalculationInput, outcome: CalculationOutcome): CalculationOutcome {
        requireValue(outcome && input.kind === outcome.kind, 'Result kind mismatch')
        const calculatedAt = outcome.calculatedAt === null ? null : text(outcome.calculatedAt, 'calculation time')
        const provenance = json(outcome.provenance)
        if (outcome.kind === 'trip') {
            requireValue(tripStatuses.includes(outcome.status), 'Invalid trip status')
            requireValue(outcome.durationSeconds === null || (typeof outcome.durationSeconds === 'number' && Number.isFinite(outcome.durationSeconds) && outcome.durationSeconds >= 0), 'Invalid duration')
            // Geometry/scope/identity checks belong to the future validated API adapter.
            const route = outcome.route === null ? null : json(outcome.route as unknown as Json) as unknown as TripOutcome['route']
            requireValue(outcome.status === 'AVAILABLE' || route === null, 'Unavailable result cannot have a route')
            return { kind: 'trip', status: outcome.status, durationSeconds: outcome.durationSeconds, route, calculatedAt, provenance, details: json(outcome.details) }
        }
        requireValue(environmentStatuses.includes(outcome.status), 'Invalid environment status')
        return { kind: 'environment', status: outcome.status, value: json(outcome.value), calculatedAt, provenance }
    }
    function exportDocument(): DeepReadonly<SearchDocument> { return immutable(projectDocument(document)) }
    function snapshot(): DeepReadonly<SearchSnapshot> {
        return immutable({ document: projectDocument(document), runtime: { generation, cells: copy([...cells.values()]), resolutions: copy([...resolutions.values()]) }, view: copy(view) })
    }

    function addCandidate(value: AddressSelection): string {
        requireValue(document.candidates.length < 5, 'Candidate limit')
        const normalized = address(value), id = nextId()
        document.candidates.push({ id, selectionRevision: 0, address: normalized, notes: [], checklist: [] })
        setResolution('candidate', id, 'resolved'); changed(); return id
    }
    function missingEvidence(id: string): Resolution {
        candidate(id)
        const key = resolutionKey('candidate', id), evidence = resolutions.get(key)
        requireValue(evidence?.status === 'missing' && !resolving.has(key), 'Replacement requires confirmed missing object')
        return evidence
    }

    return {
        snapshot,
        exportDocument,
        addCandidate,
        changeCandidateAddress(id: string, value: AddressSelection): string {
            candidate(id)
            // The original candidate, annotations, pair and requests remain independent.
            return addCandidate(value)
        },
        prepareMissingCandidateReplacement(id: string, value: AddressSelection): DeepReadonly<MissingCandidateReplacement> {
            const c = candidate(id), evidence = missingEvidence(id), replacement = address(value)
            requireValue(replacement.addressId !== c.address.addressId, 'Re-resolve the same object instead of replacing it')
            const confirmation = readonlySnapshot({ generation, documentRevision: document.documentRevision, candidateId: id, replacement,
                summary: { previousAddress: copy(c.address), transferredNotes: copy(c.notes), discardedChecklist: copy(c.checklist),
                    discardedStreetChoices: copy(document.streetChoices.filter(s => s.candidateId === id)),
                    pairRoles: (['a', 'b'] as const).filter(role => document.pair[role] === id) } })
            replacementConfirmations.set(confirmation, evidence)
            return confirmation
        },
        replaceMissingCandidate(confirmation: DeepReadonly<MissingCandidateReplacement>): string {
            const evidence = replacementConfirmations.get(confirmation)
            requireValue(evidence && confirmation.generation === generation && confirmation.documentRevision === document.documentRevision,
                'Replacement confirmation is stale or foreign')
            const old = candidate(confirmation.candidateId)
            requireValue(missingEvidence(old.id) === evidence, 'Missing evidence changed; confirm again')
            const normalized = address(confirmation.replacement), id = nextId()
            const notes = copy(old.notes).map(n => ({ ...n, previousObject: n.previousObject ?? { candidateId: old.id, address: copy(n.basis.address) } }))
            const next = { id, selectionRevision: 0, address: normalized, notes, checklist: [] }
            // All validation/preparation precedes the one document mutation; no sixth candidate.
            resetCandidate(old.id)
            document.candidates = document.candidates.map(c => c.id === old.id ? next : c)
            for (const role of ['a', 'b'] as const) if (document.pair[role] === old.id) document.pair[role] = id
            if (view.candidateId === old.id) view = { section: 'addresses', candidateId: id }
            resolutions.delete(resolutionKey('candidate', old.id)); resolving.delete(resolutionKey('candidate', old.id))
            setResolution('candidate', id, 'resolved')
            replacementConfirmations.delete(confirmation)
            changed(); return id
        },
        removeCandidate(id: string) {
            candidate(id); resetCandidate(id)
            document.candidates = document.candidates.filter(c => c.id !== id)
            if (document.pair.a === id) document.pair.a = null
            if (document.pair.b === id) document.pair.b = null
            if (view.candidateId === id) view = { section: 'addresses', candidateId: null }
            resolutions.delete(resolutionKey('candidate', id)); resolving.delete(resolutionKey('candidate', id)); changed()
        },
        addPlace(value: PlaceSelection, label: string, tripMode: TripMode, limit: number | null = null): string {
            requireValue(document.places.length < 3, 'Place limit')
            const normalized = selection(value), normalizedLabel = text(label, 'place label'), normalizedMode = mode(tripMode), normalizedLimit = threshold(limit), id = nextId()
            document.places.push({ id, selectionRevision: 0, label: normalizedLabel, selection: normalized, mode: normalizedMode, thresholdMinutes: normalizedLimit })
            setResolution('place', id, 'resolved'); changed(); return id
        },
        setPlaceSelection(id: string, value: PlaceSelection) {
            const p = place(id), normalized = selection(value)
            p.selection = normalized; p.selectionRevision++; resetPlace(id)
            setResolution('place', id, 'resolved'); changed()
        },
        setPlaceMode(id: string, value: TripMode) {
            const p = place(id), normalized = mode(value)
            if (p.mode === normalized) return
            p.mode = normalized; p.selectionRevision++; resetPlace(id); changed()
        },
        renamePlace(id: string, label: string) { const p = place(id), normalized = text(label, 'place label'); p.label = normalized; changed() },
        setThreshold(id: string, value: number | null) { const p = place(id), normalized = threshold(value); p.thresholdMinutes = normalized; changed() },
        setRadius(value: 300 | 500) {
            const normalized = radius(value)
            if (document.radius === normalized) return
            document.radius = normalized
            invalidate(i => i.kind === 'environment', true); changed()
        },
        removePlace(id: string) {
            place(id); resetPlace(id); document.places = document.places.filter(p => p.id !== id)
            resolutions.delete(resolutionKey('place', id)); resolving.delete(resolutionKey('place', id)); changed()
        },
        assignPair(a: string | null, b: string | null) {
            if (a !== null) candidate(a)
            if (b !== null) candidate(b)
            requireValue(a === null || a !== b, 'Pair must be distinct')
            document.pair = { a, b }; changed()
        },
        reorderCandidates(ids: readonly string[]) {
            requireValue(ids.length === document.candidates.length && new Set(ids).size === ids.length, 'Invalid candidate order')
            const ordered = ids.map(candidate); document.candidates = ordered; changed()
        },
        reorderPlaces(ids: readonly string[]) {
            requireValue(ids.length === document.places.length && new Set(ids).size === ids.length, 'Invalid place order')
            const ordered = ids.map(place); document.places = ordered; changed()
        },
        setStreetChoice(candidateId: string, placeId: string, startRoad: Coordinates | null, targetRoad: Coordinates | null) {
            const c = candidate(candidateId), p = place(placeId)
            const choice = { candidateId, placeId, mode: p.mode, candidateRevision: c.selectionRevision, placeRevision: p.selectionRevision,
                startRoad: startRoad === null ? null : coordinates(startRoad), targetRoad: targetRoad === null ? null : coordinates(targetRoad) }
            document.streetChoices = document.streetChoices.filter(s => s.candidateId !== candidateId || s.placeId !== placeId)
            if (choice.startRoad || choice.targetRoad) document.streetChoices.push(choice)
            invalidate(i => i.kind === 'trip' && i.candidateId === candidateId && i.placeId === placeId, false); changed()
        },
        addNote(candidateId: string, noteText: string, placeId: string | null = null): string {
            const c = candidate(candidateId), normalized = text(noteText, 'note'), basis = currentBasis(candidateId, placeId), updatedAt = now(), id = nextId()
            c.notes.push({ id, text: normalized, placeId, basis, updatedAt }); changed(); return id
        },
        editNote(candidateId: string, noteId: string, noteText: string) {
            const n = candidate(candidateId).notes.find(n => n.id === noteId), normalized = text(noteText, 'note'), updatedAt = now()
            requireValue(n, 'Note not found'); n.text = normalized; n.updatedAt = updatedAt; changed()
        },
        removeNote(candidateId: string, noteId: string) {
            const c = candidate(candidateId); requireValue(c.notes.some(n => n.id === noteId), 'Note not found')
            c.notes = c.notes.filter(n => n.id !== noteId); changed()
        },
        setChecklistMark(candidateId: string, ruleKey: string, placeId: string | null, checked: boolean) {
            const c = candidate(candidateId), normalized = text(ruleKey, 'checklist rule'), basis = currentBasis(candidateId, placeId), updatedAt = now()
            requireValue(typeof checked === 'boolean', 'Invalid mark')
            const mark = { ruleKey: normalized, placeId, checked, basis, updatedAt }
            c.checklist = c.checklist.filter(m => m.ruleKey !== normalized || m.placeId !== placeId)
            c.checklist.push(mark); changed()
        },
        annotations(candidateId: string) {
            const c = candidate(candidateId)
            return readonlySnapshot({ notes: c.notes.map(n => ({ ...copy(n), needsReview: !!n.previousObject || !basisCurrent(candidateId, n.basis),
                    originLabel: n.previousObject ? 'Относилось к прежнему объекту' : null })),
                checklist: c.checklist.map(m => ({ ...copy(m), needsReview: !basisCurrent(candidateId, m.basis) })) })
        },
        navigate(section: Section, candidateId: string | null = null) {
            requireValue(sections.includes(section), 'Invalid section')
            if (candidateId !== null) candidate(candidateId)
            requireValue(section !== 'visit' || candidateId !== null, 'Visit requires a candidate')
            view = { section, candidateId }
        },
        calculateCandidate(candidateId: string) { return enqueue(allInputs([candidateId])) },
        calculatePair() {
            const ids = [document.pair.a, document.pair.b].filter((id): id is string => id !== null)
            requireValue(ids.length > 0, 'No candidate selected'); return enqueue(allInputs(ids))
        },
        markLoading(token: DeepReadonly<RequestToken>): boolean {
            const job = active(token); if (!job) return false
            cells.get(keyOf(job.input))!.phase = 'loading'; return true
        },
        acceptResult(token: DeepReadonly<RequestToken>, outcome: CalculationOutcome): boolean {
            const job = active(token); if (!job) return false
            const normalized = normalizeOutcome(job.input, outcome), key = keyOf(job.input)
            cells.set(key, { key, phase: 'settled', freshness: 'current', result: { input: copy(job.input), inputStamp: token.inputStamp, outcome: normalized }, error: null })
            pending.delete(key); return true
        },
        rejectRequest(token: DeepReadonly<RequestToken>, error: RequestFailure): boolean {
            const job = active(token); if (!job) return false
            requireValue(['http', 'network', 'timeout', 'invalid_response', 'cancelled'].includes(error.kind), 'Invalid request error')
            requireValue(error.status === null || (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599), 'Invalid HTTP status')
            requireValue(error.code === null || typeof error.code === 'string', 'Invalid error code')
            requireValue(error.retryAfter === null || typeof error.retryAfter === 'string', 'Invalid retry time')
            const key = keyOf(job.input), cell = cells.get(key)!
            cell.phase = error.kind === 'cancelled' ? (cell.result ? 'settled' : 'not_calculated') : 'request_error'
            // A failed refresh cannot turn the previous value into a new success.
            if (cell.result && error.kind !== 'cancelled') cell.freshness = 'stale'
            cell.error = error.kind === 'cancelled' ? null : { kind: error.kind, status: error.status, code: error.code, retryAfter: error.retryAfter }
            pending.delete(key); return true
        },
        markStale(candidateId: string, part: { placeId: string } | { block: EnvironmentBlock }) {
            const input = inputFor(candidateId, part), key = keyOf(input)
            invalidate(i => keyOf(i) === key, true)
        },
        trip(candidateId: string, placeId: string) {
            const input = inputFor(candidateId, { placeId }), cell = cellFor(input), outcome = cell.result?.outcome
            const current = cell.phase === 'settled' && cell.freshness === 'current' && cell.result?.inputStamp === stamp(input)
            const available = current && outcome?.kind === 'trip' && outcome.status === 'AVAILABLE'
            const limit = place(placeId).thresholdMinutes
            const canAssessThreshold = !!available && outcome.durationSeconds !== null && limit !== null
            const assessment = canAssessThreshold ? (outcome.durationSeconds! / 60 <= limit! ? 'within' : 'over') : null
            return readonlySnapshot({ ...copy(cell), canAssessThreshold, assessment,
                canShowRoute: !!available && outcome.route !== null, display: !cell.result ? 'none' : cell.freshness === 'stale' ? 'stale'
                    : cell.phase !== 'settled' ? 'previous' : 'current' })
        },
        environment(candidateId: string, block: EnvironmentBlock) {
            requireValue(environmentBlocks.includes(block), 'Invalid environment block')
            return readonlySnapshot(copy(cellFor(inputFor(candidateId, { block }))))
        },
        // Pure input restoration. Address coordinates must be resolved again before calculation.
        restoreDocument(value: unknown) {
            const normalized = projectDocument(value)
            document = normalized; generation++; cells.clear(); pending.clear(); epochs.clear(); resolutions.clear(); resolving.clear()
            view = { section: 'conditions', candidateId: null }
            for (const c of document.candidates) {
                usedIds.add(c.id); c.notes.forEach(n => { usedIds.add(n.id); if (n.previousObject) usedIds.add(n.previousObject.candidateId) })
                for (const item of [...c.notes, ...c.checklist]) if (item.placeId !== null) usedIds.add(item.placeId)
                setResolution('candidate', c.id, 'unresolved')
            }
            for (const p of document.places) { usedIds.add(p.id); setResolution('place', p.id, p.selection.kind === 'point' ? 'resolved' : 'unresolved') }
            usedIds.add(document.searchId)
        },
        resolutionRequest(kind: Resolution['kind'], id: string): Readonly<ResolutionRequest> {
            const entity = kind === 'candidate' ? candidate(id) : place(id)
            const value = 'address' in entity ? entity.address : entity.selection
            requireValue(value.kind === 'address', 'Point does not need an address resolver')
            const request = immutable({ generation, serial: ++serial, kind, id, selectionRevision: entity.selectionRevision, addressId: value.addressId })
            resolving.set(resolutionKey(kind, id), request)
            return request
        },
        applyResolution(request: Readonly<ResolutionRequest>, status: Exclude<ResolutionStatus, 'unresolved'>, value: AddressSelection | null = null): boolean {
            if (request.generation !== generation || resolving.get(resolutionKey(request.kind, request.id)) !== request) return false
            const entity = request.kind === 'candidate' ? document.candidates.find(c => c.id === request.id) : document.places.find(p => p.id === request.id)
            if (!entity || entity.selectionRevision !== request.selectionRevision) return false
            const old = 'address' in entity ? entity.address : entity.selection
            if (old.kind !== 'address' || old.addressId !== request.addressId) return false
            requireValue(['resolved', 'missing', 'source_unavailable', 'request_error'].includes(status), 'Invalid resolution status')
            const normalized = status === 'resolved' ? address(value!) : null
            requireValue(normalized === null || normalized.addressId === request.addressId, 'Resolved identity mismatch')
            if (normalized && (old.lon !== normalized.lon || old.lat !== normalized.lat)) {
                if ('address' in entity) entity.address = normalized
                else entity.selection = normalized
                entity.selectionRevision++
                if (request.kind === 'candidate') resetCandidate(request.id)
                else resetPlace(request.id)
                changed()
            } else if (normalized) {
                const sourceChanged = (old.provenance?.snapshot != null && normalized.provenance?.snapshot != null && old.provenance.snapshot !== normalized.provenance.snapshot)
                    || (old.provenance?.datasetImportId != null && normalized.provenance?.datasetImportId != null && old.provenance.datasetImportId !== normalized.provenance.datasetImportId)
                if (sourceChanged) invalidate(i => request.kind === 'candidate' ? i.candidateId === request.id : i.kind === 'trip' && i.placeId === request.id, true)
                if (JSON.stringify(old) !== JSON.stringify(normalized)) {
                    if ('address' in entity) entity.address = normalized
                    else entity.selection = normalized
                    changed()
                }
            } else {
                invalidate(i => request.kind === 'candidate' ? i.candidateId === request.id : i.kind === 'trip' && i.placeId === request.id, false)
            }
            resolving.delete(resolutionKey(request.kind, request.id))
            setResolution(request.kind, request.id, status); return true
        },
    }
}
