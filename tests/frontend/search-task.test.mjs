import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'

const types = loadModule(new URL('../../resources/js/search/types.ts', import.meta.url))
const documentModule = loadModule(new URL('../../resources/js/search/document.ts', import.meta.url))
const { createSearchTask } = loadModule(new URL('../../resources/js/search/task.ts', import.meta.url), {
    './document': documentModule, './types': types,
})
const time = '2026-11-01T01:02:03Z'
// Entirely synthetic selections, unrelated to saved user inputs or real addresses.
const address = (n = 1, extra = {}) => ({ kind: 'address', addressId: `osm:way:${n}`, label: `Объект ${n}`,
    lon: .12, lat: .23, provenance: { source: 'synthetic', datasetImportId: null, snapshot: 'synthetic-v1', observedAt: null, sourceUpdatedAt: null }, ...extra })
const point = () => ({ kind: 'point', lon: .13, lat: .24, label: 'Синтетическое место' })
const failure = { kind: 'http', status: 503, code: 'SYNTHETIC_SERVICE_DOWN', retryAfter: null }
const route = { geometry: { type: 'LineString', coordinates: [[.12, .23], [.13, .24]] }, distance_m: 100, duration_s: 1440 }
const trip = (extra = {}) => ({ kind: 'trip', status: 'AVAILABLE', durationSeconds: 1440, route,
    calculatedAt: time, provenance: { version: 'synthetic-v1', observedAt: null }, details: { reason: 'synthetic' }, ...extra })
const environment = (extra = {}) => ({ kind: 'environment', status: 'READY', value: { distance: 123, unknown: null },
    calculatedAt: time, provenance: { version: 'synthetic-v1' }, ...extra })
const clone = x => JSON.parse(JSON.stringify(x))
function build() {
    let id = 0, ticks = 0
    return createSearchTask({ nextId: () => `synthetic-${++id}`, now: () => `${time}:${++ticks}` })
}
function setup() {
    const task = build(), a = task.addCandidate(address(1)), b = task.addCandidate(address(2))
    const p = task.addPlace(point(), 'Место 1', 'walking', 30)
    const q = task.addPlace(address(3), 'Место 2', 'driving', 10)
    task.assignPair(a, b)
    return { task, a, b, p, q }
}
const tripJob = (jobs, c, p) => jobs.find(j => j.input.kind === 'trip' && j.input.candidateId === c && j.input.placeId === p)
const envJob = (jobs, c, block = 'transport') => jobs.find(j => j.input.kind === 'environment' && j.input.candidateId === c && j.input.block === block)
function acceptAll(task, jobs) {
    for (const j of jobs) assert.equal(task.acceptResult(j.token, j.input.kind === 'trip' ? trip() : environment()), true)
}
function unchangedOnThrow(task, command) {
    const before = task.snapshot()
    assert.throws(command)
    assert.deepEqual(task.snapshot(), before)
}

test('persistent identity owns results and annotations when roles and order change', () => {
    const { task, a, b, p, q } = setup()
    const noteId = task.addNote(a, 'Проверить вход', p)
    task.setChecklistMark(a, 'entrance', p, true)
    const jobs = task.calculatePair(), first = tripJob(jobs, a, p)
    assert.equal(first.input.mode, 'walking')
    assert.equal(tripJob(jobs, a, q).input.mode, 'driving')
    task.assignPair(b, a)
    task.reorderCandidates([b, a]); task.reorderPlaces([q, p])
    task.editNote(a, noteId, 'Проверить вход вечером')
    assert.equal(task.acceptResult(first.token, trip()), true)
    assert.equal(task.trip(a, p).assessment, 'within')
    assert.equal(task.trip(b, p).result, null)
    assert.equal(task.annotations(a).notes[0].text, 'Проверить вход вечером')
    assert.equal(task.annotations(a).checklist[0].checked, true)
    assert.equal(task.annotations(a).notes[0].needsReview, false)
    const c = task.addCandidate(address(1)) // same ID/coordinates, different local candidate
    task.assignPair(c, b)
    assert.notEqual(c, a)
    assert.equal(task.trip(a, p).result.outcome.durationSeconds, 1440)
})

test('limits and invalid references reject atomically without evicting data', () => {
    const { task, a, b, p } = setup()
    for (let n = 4; n < 7; n++) task.addCandidate(address(n))
    task.addPlace(point(), 'Третье', 'walking')
    for (const command of [() => task.addCandidate(address(7)), () => task.addPlace(point(), 'Четвёртое', 'walking'),
        () => task.assignPair(a, a), () => task.assignPair(b, 'absent'), () => task.setPlaceMode(p, 'cycling'),
        () => task.setThreshold(p, NaN), () => task.setThreshold(p, 0), () => task.setRadius(400),
        () => task.reorderCandidates([a, a]), () => task.reorderPlaces(['absent']),
        () => task.setStreetChoice(a, p, { lon: NaN, lat: 2 }, null),
        () => task.addNote(a, 'note', 'absent'), () => task.navigate('visit', 'absent')]) unchangedOnThrow(task, command)
})

test('selection inputs use an allowlist, exact OSM identity, and explicit points', () => {
    const task = build()
    for (const value of [point(), address(1, { addressId: 'address:group' }), address(1, { lon: Infinity }),
        address(1, { addressId: 'osm:way:0' }), address(1, { provenance: { x: undefined } })]) {
        unchangedOnThrow(task, () => task.addCandidate(value))
    }
    const source = { ...point(), addressId: 'invented', metrics: { value: 24 } }
    const p = task.addPlace(source, 'Место', 'walking')
    source.lon = 80
    const value = task.exportDocument().places.find(x => x.id === p).selection
    assert.deepEqual(value, point())
    assert.equal('addressId' in value, false)
})

test('changing a place mode clears only its trips and scoped street choices', () => {
    const { task, a, b, p, q } = setup()
    task.setStreetChoice(a, p, { lon: .1, lat: .2 }, null)
    task.setStreetChoice(a, q, { lon: .15, lat: .25 }, null)
    const jobs = task.calculatePair()
    acceptAll(task, jobs)
    task.setPlaceMode(p, 'driving')
    assert.equal(task.trip(a, p).phase, 'not_calculated')
    assert.equal(task.trip(b, p).result, null)
    assert.equal(task.trip(a, q).result.outcome.status, 'AVAILABLE')
    assert.equal(task.environment(a, 'transport').freshness, 'current')
    assert.equal(task.exportDocument().streetChoices.length, 1)
    assert.equal(task.exportDocument().streetChoices[0].placeId, q)
    assert.equal(task.acceptResult(tripJob(jobs, a, p).token, trip()), false)
})

test('ordinary address change creates a new candidate and retains the original independent data', () => {
    const { task, a, b, p } = setup()
    task.addNote(a, 'Ручная заметка 24', p); task.setChecklistMark(a, 'entrance', p, true)
    acceptAll(task, task.calculatePair())
    const original = task.exportDocument().candidates.find(c => c.id === a)
    const next = task.changeCandidateAddress(a, address(7))
    assert.notEqual(next, a)
    assert.deepEqual(task.exportDocument().candidates.find(c => c.id === a), original)
    assert.deepEqual(task.exportDocument().pair, { a, b })
    assert.equal(task.trip(a, p).result.outcome.status, 'AVAILABLE')
    assert.equal(task.trip(b, p).result.outcome.status, 'AVAILABLE')
    assert.equal(task.trip(next, p).phase, 'not_calculated')
    assert.equal(task.environment(next, 'transport').result, null)
    assert.deepEqual(task.annotations(next), { notes: [], checklist: [] })
    assert.equal(task.annotations(a).notes[0].needsReview, false)
    assert.equal('replaceCandidateAddress' in task, false)
})

test('radius changes retain stale environment and invalidate in-flight environment only', () => {
    const { task, a, p } = setup()
    const initial = task.calculateCandidate(a)
    acceptAll(task, initial)
    const pending = task.calculateCandidate(a), oldEnvironment = envJob(pending, a), pendingTrip = tripJob(pending, a, p)
    task.setRadius(300)
    const cell = task.environment(a, 'transport')
    assert.equal(cell.freshness, 'stale')
    assert.equal(cell.result.input.radius, 500)
    assert.equal(cell.result.outcome.calculatedAt, time)
    assert.equal(task.acceptResult(oldEnvironment.token, environment()), false)
    assert.equal(task.acceptResult(pendingTrip.token, trip()), true)
    assert.equal(task.trip(a, p).canShowRoute, true)
    const next = task.calculateCandidate(a)
    assert.equal(envJob(next, a).input.radius, 300)
})

test('threshold edits compare exact seconds without rerunning and cannot assess stale values', () => {
    const { task, a, p } = setup()
    const job = tripJob(task.calculateCandidate(a), a, p)
    task.setThreshold(p, 24)
    assert.equal(task.acceptResult(job.token, trip({ durationSeconds: 1440.01 })), true)
    assert.equal(task.trip(a, p).assessment, 'over')
    task.setThreshold(p, 25)
    assert.equal(task.trip(a, p).assessment, 'within')
    task.setThreshold(p, null)
    assert.equal(task.trip(a, p).canAssessThreshold, false)
    task.setThreshold(p, 25)
    task.markStale(a, { placeId: p })
    const cell = task.trip(a, p)
    assert.equal(cell.display, 'stale')
    assert.equal(cell.result.outcome.durationSeconds, 1440.01)
    assert.equal(cell.result.outcome.calculatedAt, time)
    assert.equal(cell.canAssessThreshold, false)
    assert.equal(cell.canShowRoute, false)
    assert.equal(cell.assessment, null)
})

test('a same-input refresh hides assessment/route until accepted and isolates a failed cell', () => {
    const { task, a, b, p } = setup()
    acceptAll(task, task.calculatePair())
    const jobs = task.calculateCandidate(a), job = tripJob(jobs, a, p)
    assert.equal(task.trip(a, p).display, 'previous')
    assert.equal(task.trip(a, p).canAssessThreshold, false)
    assert.equal(task.markLoading(job.token), true)
    assert.equal(task.trip(a, p).phase, 'loading')
    assert.equal(task.rejectRequest(job.token, failure), true)
    assert.equal(task.trip(a, p).phase, 'request_error')
    assert.equal(task.trip(a, p).canShowRoute, false)
    assert.equal(task.trip(a, p).result.outcome.durationSeconds, 1440)
    assert.equal(task.trip(b, p).canShowRoute, true)
    assert.equal(task.environment(a, 'transport').error, null)
    assert.equal(task.acceptResult(job.token, trip()), false)
})

test('late answers cannot resurrect deleted or replaced entities, even at identical coordinates', () => {
    const { task, a, b, p, q } = setup()
    const jobs = task.calculatePair()
    task.removeCandidate(a)
    assert.equal(task.snapshot().document.pair.a, null)
    assert.equal(task.acceptResult(tripJob(jobs, a, p).token, trip()), false)
    task.setPlaceSelection(q, address(8))
    assert.equal(task.acceptResult(tripJob(jobs, b, q).token, trip()), false)
    assert.equal(task.acceptResult(tripJob(jobs, b, p).token, trip()), true)
    task.removePlace(p)
    assert.equal(task.acceptResult(tripJob(jobs, b, p).token, trip()), false)
    const c = task.addCandidate(address(1))
    assert.notEqual(c, a)
    assert.equal(task.snapshot().runtime.cells.some(x => x.result?.input.candidateId === a), false)
})

test('street choices belong to a candidate/place, are copied and never launch a calculation', () => {
    const { task, a, p, q } = setup()
    acceptAll(task, task.calculateCandidate(a))
    const start = { lon: .14, lat: .25 }
    task.setStreetChoice(a, p, start, null); start.lon = 88
    assert.equal(task.trip(a, p).phase, 'not_calculated')
    assert.equal(task.trip(a, q).phase, 'settled')
    assert.equal(task.snapshot().runtime.cells.some(c => c.phase === 'queued'), false)
    const job = tripJob(task.calculateCandidate(a), a, p)
    assert.equal(job.input.startRoad.lon, .14)
    assert.equal(tripJob(task.calculateCandidate(a), a, q).input.startRoad, null)
})

test('reads, navigation, input edits, and adding a new place produce no analytic jobs', () => {
    const { task, a, p } = setup()
    task.trip(a, p); task.environment(a, 'water'); task.snapshot(); task.exportDocument()
    const revision = task.exportDocument().documentRevision
    task.navigate('visit', a)
    assert.equal(task.exportDocument().documentRevision, revision)
    task.renamePlace(p, 'Название'); task.setThreshold(p, 40); task.addNote(a, 'Заметка')
    task.assignPair(null, a); task.addPlace(point(), 'Новое', 'walking')
    assert.deepEqual(task.snapshot().runtime.cells, [])
})

test('document projection and restoration retain input only, reject invalid restore atomically', () => {
    const { task, a, p } = setup()
    task.addNote(a, 'Число 24 введено пользователем', p)
    task.setChecklistMark(a, 'visit', p, true)
    acceptAll(task, task.calculatePair())
    const saved = clone(task.exportDocument())
    const keys = []
    function collect(x) { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.push(k); collect(v) } }
    collect(saved)
    for (const forbidden of ['outcome', 'calculatedAt', 'geometry', 'durationSeconds', 'runtime', 'cells', 'phase', 'token']) assert.equal(keys.includes(forbidden), false)
    const bad = clone(saved); bad.pair.b = 'absent'
    unchangedOnThrow(task, () => task.restoreDocument(bad))
    const incoming = { ...clone(saved), runtime: { metrics: 123 }, results: [123] }
    incoming.candidates[0].metrics = { durationSeconds: 24 }
    incoming.candidates[0].address.provenance.metrics = { geometry: 'must not persist' }
    task.restoreDocument(incoming)
    assert.deepEqual(task.exportDocument(), saved)
    assert.deepEqual(task.snapshot().runtime.cells, [])
    assert.equal(task.trip(a, p).phase, 'not_calculated')
    unchangedOnThrow(task, () => task.calculateCandidate(a)) // restored address needs resolver
})

test('replacing the search changes generation and rejects every old answer', () => {
    const { task, a, p } = setup()
    const jobs = task.calculateCandidate(a), saved = clone(task.exportDocument())
    const generation = task.snapshot().runtime.generation
    task.restoreDocument(saved)
    assert.equal(task.snapshot().runtime.generation, generation + 1)
    assert.equal(task.acceptResult(tripJob(jobs, a, p).token, trip()), false)
    assert.equal(task.markLoading(envJob(jobs, a).token), false)
})

test('resolver boundary distinguishes missing/source failure and never falls back to saved coordinates', () => {
    const { task, a, p } = setup()
    task.restoreDocument(clone(task.exportDocument()))
    const request = task.resolutionRequest('candidate', a)
    assert.equal(task.applyResolution(request, 'missing'), true)
    unchangedOnThrow(task, () => task.calculateCandidate(a))
    assert.equal(task.snapshot().runtime.resolutions.find(x => x.id === a).status, 'missing')
    assert.equal(task.applyResolution(task.resolutionRequest('candidate', a), 'source_unavailable'), true)
    const nextRequest = task.resolutionRequest('candidate', a)
    const before = task.exportDocument()
    unchangedOnThrow(task, () => task.applyResolution(nextRequest, 'resolved', address(9)))
    assert.deepEqual(task.exportDocument(), before)
    assert.equal(task.applyResolution(nextRequest, 'resolved', address(1)), true)
    // An unresolved destination must not suppress the independent point-trip/environment.
    const partial = task.calculateCandidate(a)
    assert.equal(partial.length, 7)
    assert.equal(partial.filter(j => j.input.kind === 'trip').every(j => j.input.placeId === p), true)
    const q = task.exportDocument().places.find(x => x.id !== p)
    task.applyResolution(task.resolutionRequest('place', q.id), 'resolved', address(3))
    assert.equal(task.calculateCandidate(a).length, 8)
})

test('changed resolver coordinates invalidate dependent results and reject late resolver replies', () => {
    const { task, a, p } = setup()
    task.addNote(a, 'Исходная заметка')
    const request = task.resolutionRequest('candidate', a)
    const jobs = task.calculateCandidate(a)
    assert.equal(task.applyResolution(request, 'resolved', address(1, { lon: .19 })), true)
    assert.equal(task.acceptResult(tripJob(jobs, a, p).token, trip()), false)
    assert.equal(task.annotations(a).notes[0].needsReview, true)
    assert.equal(task.applyResolution(request, 'missing'), false)
    assert.equal(task.exportDocument().candidates.find(c => c.id === a).address.lon, .19)
})

test('tokens are owner-local and superseded explicit runs reject old replies', () => {
    const first = setup(), second = setup()
    const old = tripJob(first.task.calculateCandidate(first.a), first.a, first.p)
    const other = tripJob(second.task.calculateCandidate(second.a), second.a, second.p)
    assert.equal(first.task.acceptResult(other.token, trip()), false)
    assert.equal(first.task.acceptResult(clone(old.token), trip()), false)
    const next = tripJob(first.task.calculateCandidate(first.a), first.a, first.p)
    assert.equal(first.task.acceptResult(old.token, trip()), false)
    assert.equal(first.task.acceptResult(next.token, trip()), true)
    assert.equal(second.task.trip(second.a, second.p).result, null)
})

test('snapshots, input objects, and received results cannot mutate owner internals', () => {
    const { task, a, p } = setup()
    const job = tripJob(task.calculateCandidate(a), a, p), result = trip()
    task.acceptResult(job.token, result)
    result.provenance.version = 'altered'; result.details.reason = 'altered'
    const state = task.snapshot(), projected = task.trip(a, p)
    assert.throws(() => { state.document.candidates[0].address.lon = 90 }, TypeError)
    assert.throws(() => { task.exportDocument().candidates.push({}) }, TypeError)
    assert.throws(() => { projected.result.outcome.details.reason = 'altered' }, TypeError)
    assert.throws(() => { job.input.start.lon = 90 }, TypeError)
    assert.equal(task.trip(a, p).result.outcome.provenance.version, 'synthetic-v1')
    assert.equal(task.trip(a, p).result.outcome.details.reason, 'synthetic')
})

test('deleted places keep annotations with obsolete basis and a manual mark can be reviewed', () => {
    const { task, a, p, q } = setup()
    task.addNote(a, 'Заметка', p); task.setChecklistMark(a, 'entrance', p, true)
    task.setChecklistMark(a, 'other', q, true)
    task.setPlaceMode(q, 'walking')
    assert.equal(task.annotations(a).checklist.find(m => m.ruleKey === 'other').needsReview, true)
    task.setChecklistMark(a, 'other', q, false)
    assert.equal(task.annotations(a).checklist.find(m => m.ruleKey === 'other').needsReview, false)
    task.removePlace(p)
    assert.equal(task.annotations(a).notes[0].needsReview, true)
    assert.equal(task.annotations(a).checklist.find(m => m.ruleKey === 'entrance').needsReview, true)
    // Historical references may point to a removed place; input restoration must preserve them.
    task.restoreDocument(clone(task.exportDocument()))
    assert.equal(task.annotations(a).notes[0].placeId, p)
})

test('backend statuses are separate from request phases and unavailable values get no assessment', () => {
    const { task, a, p } = setup()
    const job = tripJob(task.calculateCandidate(a), a, p)
    assert.equal(task.acceptResult(job.token, trip({ status: 'UNKNOWN', durationSeconds: null, route: null,
        calculatedAt: null, details: { code: 'SYNTHETIC_UNKNOWN' } })), true)
    const cell = task.trip(a, p)
    assert.equal(cell.phase, 'settled')
    assert.equal(cell.result.outcome.status, 'UNKNOWN')
    assert.equal(cell.result.outcome.calculatedAt, null)
    assert.equal(cell.canAssessThreshold, false)
    assert.equal(cell.canShowRoute, false)
    const retry = tripJob(task.calculateCandidate(a), a, p)
    unchangedOnThrow(task, () => task.acceptResult(retry.token, trip({ durationSeconds: NaN })))
    assert.equal(task.acceptResult(retry.token, trip()), true)
})

test('unknown data versions can be marked stale without treating them as newly observed', () => {
    const { task, a } = setup()
    const job = envJob(task.calculateCandidate(a), a, 'water')
    task.acceptResult(job.token, environment({ provenance: { observedAt: null, version: null }, calculatedAt: null }))
    task.markStale(a, { block: 'water' })
    const cell = task.environment(a, 'water')
    assert.equal(cell.freshness, 'stale')
    assert.equal(cell.result.outcome.provenance.observedAt, null)
    assert.equal(cell.result.outcome.calculatedAt, null)
})

test('generated IDs are never recycled after deletion', () => {
    const task = createSearchTask({ nextId: (() => { const ids = ['search', 'candidate', 'candidate']; return () => ids.shift() })(), now: () => time })
    const c = task.addCandidate(address(1)); task.removeCandidate(c)
    unchangedOnThrow(task, () => task.addCandidate(address(2)))
})

test('without places calculation creates environment jobs only; empty pair cannot calculate', () => {
    const task = build()
    unchangedOnThrow(task, () => task.calculatePair())
    const a = task.addCandidate(address(1))
    const jobs = task.calculateCandidate(a)
    assert.equal(jobs.length, 6)
    assert.equal(jobs.every(j => j.input.kind === 'environment'), true)
    assert.equal(task.snapshot().runtime.cells.every(c => c.phase === 'queued'), true)
})


test('resolver replies are owner-local and only the latest request may change the resolution', () => {
    const first = setup(), second = setup()
    const old = first.task.resolutionRequest('candidate', first.a)
    const latest = first.task.resolutionRequest('candidate', first.a)
    const foreign = second.task.resolutionRequest('candidate', second.a)
    assert.equal(first.task.applyResolution(foreign, 'missing'), false)
    assert.equal(first.task.applyResolution(old, 'missing'), false)
    assert.equal(first.task.applyResolution(latest, 'resolved', address(1)), true)
    assert.equal(first.task.applyResolution(old, 'source_unavailable'), false)
    assert.equal(first.task.applyResolution(latest, 'missing'), false)
    assert.equal(first.task.snapshot().runtime.resolutions.find(r => r.id === first.a).status, 'resolved')
})


test('a missing candidate does not suppress calculation for the other member of the pair', () => {
    const { task, a, b } = setup()
    task.applyResolution(task.resolutionRequest('candidate', a), 'missing')
    const jobs = task.calculatePair()
    assert.equal(jobs.length, 8)
    assert.equal(jobs.every(j => j.input.candidateId === b), true)
})

test('a known source revision changes freshness without inventing a new selection or timestamp', () => {
    const { task, a, b, p } = setup()
    acceptAll(task, task.calculatePair())
    const revision = task.exportDocument().candidates.find(c => c.id === a).selectionRevision
    const value = address(1)
    value.provenance.snapshot = 'synthetic-v2'
    task.applyResolution(task.resolutionRequest('candidate', a), 'resolved', value)
    assert.equal(task.exportDocument().candidates.find(c => c.id === a).selectionRevision, revision)
    assert.equal(task.trip(a, p).freshness, 'stale')
    assert.equal(task.trip(a, p).result.outcome.calculatedAt, time)
    assert.equal(task.environment(a, 'transport').freshness, 'stale')
    assert.equal(task.trip(b, p).freshness, 'current')
})


function missing(task, candidateId) {
    assert.equal(task.applyResolution(task.resolutionRequest('candidate', candidateId), 'missing'), true)
}

test('ordinary address change cannot bypass the candidate limit or redirect the original pending reply', () => {
    const { task, a, b, p } = setup()
    const jobs = task.calculateCandidate(a), oldReply = tripJob(jobs, a, p)
    const next = task.changeCandidateAddress(a, address(7))
    assert.equal(task.acceptResult(oldReply.token, trip()), true)
    assert.equal(task.trip(a, p).result.outcome.durationSeconds, 1440)
    assert.equal(task.trip(next, p).result, null)
    task.addCandidate(address(8)); task.addCandidate(address(9))
    unchangedOnThrow(task, () => task.changeCandidateAddress(a, address(10)))
    assert.equal(task.exportDocument().candidates.length, 5)
    assert.deepEqual(task.exportDocument().pair, { a, b })
})

test('missing replacement is unavailable for resolved, unknown or failed sources and never replaces the same object', () => {
    const { task, a } = setup()
    unchangedOnThrow(task, () => task.prepareMissingCandidateReplacement(a, address(7)))
    for (const status of ['source_unavailable', 'request_error']) {
        task.applyResolution(task.resolutionRequest('candidate', a), status)
        unchangedOnThrow(task, () => task.prepareMissingCandidateReplacement(a, address(7)))
    }
    task.restoreDocument(clone(task.exportDocument()))
    unchangedOnThrow(task, () => task.prepareMissingCandidateReplacement(a, address(7)))
    missing(task, a)
    unchangedOnThrow(task, () => task.prepareMissingCandidateReplacement(a, address(1)))
    unchangedOnThrow(task, () => task.prepareMissingCandidateReplacement(a, { ...point() }))
})

test('missing replacement confirms the exact consequences and atomically transfers only labelled notes at the limit', () => {
    const { task, a, b, p } = setup()
    task.addCandidate(address(4)); task.addCandidate(address(5)); task.addCandidate(address(6))
    const noteId = task.addNote(a, 'Проверить выход', p)
    task.setChecklistMark(a, 'entrance', p, true)
    task.setStreetChoice(a, p, { lon: .14, lat: .25 }, null)
    const jobs = task.calculatePair(), oldReply = tripJob(jobs, a, p), otherReply = tripJob(jobs, b, p)
    task.acceptResult(otherReply.token, trip())
    task.navigate('visit', a)
    missing(task, a)
    const before = task.snapshot(), replacement = address(7)
    const confirmation = task.prepareMissingCandidateReplacement(a, replacement)
    replacement.lon = 88
    assert.deepEqual(task.snapshot(), before) // Preparing or abandoning a confirmation changes nothing.
    assert.equal(confirmation.summary.previousAddress.addressId, 'osm:way:1')
    assert.equal(confirmation.summary.transferredNotes[0].id, noteId)
    assert.equal(confirmation.summary.discardedChecklist[0].ruleKey, 'entrance')
    assert.equal(confirmation.summary.discardedStreetChoices.length, 1)
    assert.deepEqual(confirmation.summary.pairRoles, ['a'])
    assert.throws(() => { confirmation.replacement.lon = 90 }, TypeError)
    const next = task.replaceMissingCandidate(confirmation)
    assert.notEqual(next, a)
    assert.equal(task.exportDocument().documentRevision, before.document.documentRevision + 1)
    assert.equal(task.exportDocument().candidates.length, 5)
    assert.equal(task.exportDocument().candidates.some(c => c.id === a), false)
    assert.equal(task.exportDocument().candidates.find(c => c.id === next).address.lon, .12)
    assert.deepEqual(task.exportDocument().pair, { a: next, b })
    assert.deepEqual(task.snapshot().view, { section: 'addresses', candidateId: next })
    assert.equal(task.acceptResult(oldReply.token, trip()), false)
    assert.equal(task.trip(next, p).phase, 'not_calculated')
    assert.equal(task.environment(next, 'transport').result, null)
    assert.equal(task.exportDocument().streetChoices.some(c => c.candidateId === a || c.candidateId === next), false)
    assert.equal(task.trip(b, p).result.outcome.status, 'AVAILABLE')
    assert.equal(task.snapshot().runtime.cells.some(c => JSON.parse(c.key)[1] === next), false)
    const annotations = task.annotations(next)
    assert.deepEqual(annotations.checklist, [])
    assert.equal(annotations.notes[0].id, noteId)
    assert.equal(annotations.notes[0].text, 'Проверить выход')
    assert.equal(annotations.notes[0].basis.address.addressId, 'osm:way:1')
    assert.equal(annotations.notes[0].previousObject.candidateId, a)
    assert.equal(annotations.notes[0].previousObject.address.addressId, 'osm:way:1')
    assert.equal(annotations.notes[0].originLabel, 'Относилось к прежнему объекту')
    assert.equal(annotations.notes[0].needsReview, true)
    unchangedOnThrow(task, () => task.replaceMissingCandidate(confirmation)) // A confirmation is single-use.
})

test('confirmation is rejected after a note, pair or input revision changes', () => {
    for (const change of [({ task, a }) => task.addNote(a, 'Поздняя заметка'),
        ({ task, a, b }) => task.assignPair(b, a), ({ task }) => task.setRadius(300)]) {
        const state = setup(), { task, a } = state
        missing(task, a)
        const confirmation = task.prepareMissingCandidateReplacement(a, address(7))
        change(state)
        unchangedOnThrow(task, () => task.replaceMissingCandidate(confirmation))
        const renewed = task.prepareMissingCandidateReplacement(a, address(7))
        assert.notEqual(task.replaceMissingCandidate(renewed), a)
    }
})

test('confirmation requires current resolver evidence even when the document revision is unchanged', () => {
    const { task, a } = setup()
    missing(task, a)
    const confirmation = task.prepareMissingCandidateReplacement(a, address(7)), revision = task.exportDocument().documentRevision
    const request = task.resolutionRequest('candidate', a)
    unchangedOnThrow(task, () => task.replaceMissingCandidate(confirmation))
    unchangedOnThrow(task, () => task.prepareMissingCandidateReplacement(a, address(7)))
    task.applyResolution(request, 'missing')
    assert.equal(task.exportDocument().documentRevision, revision)
    unchangedOnThrow(task, () => task.replaceMissingCandidate(confirmation))
    const renewed = task.prepareMissingCandidateReplacement(a, address(7))
    task.applyResolution(task.resolutionRequest('candidate', a), 'resolved', address(1))
    unchangedOnThrow(task, () => task.replaceMissingCandidate(renewed))
})

test('a foreign, copied or pre-restore confirmation cannot substitute a candidate', () => {
    const first = setup(), second = setup()
    missing(first.task, first.a); missing(second.task, second.a)
    const confirmation = first.task.prepareMissingCandidateReplacement(first.a, address(7))
    unchangedOnThrow(second.task, () => second.task.replaceMissingCandidate(confirmation))
    unchangedOnThrow(first.task, () => first.task.replaceMissingCandidate(clone(confirmation)))
    first.task.restoreDocument(clone(first.task.exportDocument()))
    missing(first.task, first.a)
    unchangedOnThrow(first.task, () => first.task.replaceMissingCandidate(confirmation))
})

test('transferred-note origins survive editing, another missing replacement, and document restoration', () => {
    const { task, a, p } = setup()
    const firstNote = task.addNote(a, 'От старого объекта', p)
    missing(task, a)
    const next = task.replaceMissingCandidate(task.prepareMissingCandidateReplacement(a, address(7)))
    task.editNote(next, firstNote, 'Уточнённая заметка о старом объекте')
    const ownNote = task.addNote(next, 'О втором объекте')
    assert.equal(task.annotations(next).notes.find(n => n.id === ownNote).originLabel, null)
    task.removePlace(p) // Historical place references must survive as well.
    missing(task, next)
    const last = task.replaceMissingCandidate(task.prepareMissingCandidateReplacement(next, address(8)))
    const saved = clone(task.exportDocument())
    task.restoreDocument(saved)
    assert.deepEqual(task.exportDocument(), saved)
    const notes = task.annotations(last).notes
    assert.equal(notes.find(n => n.id === firstNote).previousObject.address.addressId, 'osm:way:1')
    assert.equal(notes.find(n => n.id === firstNote).previousObject.candidateId, a)
    assert.equal(notes.find(n => n.id === firstNote).text, 'Уточнённая заметка о старом объекте')
    assert.equal(notes.find(n => n.id === firstNote).placeId, p)
    assert.equal(notes.find(n => n.id === ownNote).previousObject.address.addressId, 'osm:way:7')
    assert.equal(notes.every(n => n.needsReview && n.originLabel === 'Относилось к прежнему объекту'), true)
    const corrupted = clone(saved)
    corrupted.candidates.find(c => c.id === last).notes[0].previousObject.address.addressId = 'osm:way:999'
    unchangedOnThrow(task, () => task.restoreDocument(corrupted))
})

test('same-ID source-coordinate correction retains candidate identity and does not transfer notes', () => {
    const { task, a } = setup()
    task.addNote(a, 'Исходная заметка')
    task.applyResolution(task.resolutionRequest('candidate', a), 'resolved', address(1, { lon: .18 }))
    assert.equal(task.exportDocument().candidates.length, 2)
    assert.equal(task.exportDocument().candidates.find(c => c.id === a).address.lon, .18)
    assert.equal(task.annotations(a).notes[0].previousObject, undefined)
    assert.equal(task.annotations(a).notes[0].needsReview, true)
})


test('a failed replacement ID allocation leaves the old candidate and confirmation consequences untouched', () => {
    const ids = ['search', 'old', 'other', 'place', 'note', 'old']
    const task = createSearchTask({ nextId: () => ids.shift(), now: () => time })
    const a = task.addCandidate(address(1)), b = task.addCandidate(address(2)), p = task.addPlace(point(), 'Место', 'walking')
    task.addNote(a, 'Сохранить заметку', p); task.setChecklistMark(a, 'entrance', p, true)
    task.setStreetChoice(a, p, { lon: .14, lat: .25 }, null); task.assignPair(a, b)
    missing(task, a)
    const confirmation = task.prepareMissingCandidateReplacement(a, address(7))
    unchangedOnThrow(task, () => task.replaceMissingCandidate(confirmation))
})

test('returning to the original address never silently removes a transferred-note warning', () => {
    const { task, a } = setup()
    const note = task.addNote(a, 'От первого объекта')
    missing(task, a)
    const middle = task.replaceMissingCandidate(task.prepareMissingCandidateReplacement(a, address(7)))
    missing(task, middle)
    const last = task.replaceMissingCandidate(task.prepareMissingCandidateReplacement(middle, address(1)))
    const item = task.annotations(last).notes.find(n => n.id === note)
    assert.equal(item.basis.address.addressId, task.exportDocument().candidates.find(c => c.id === last).address.addressId)
    assert.equal(item.needsReview, true)
    assert.equal(item.originLabel, 'Относилось к прежнему объекту')
})
