import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadModule, loadComponent, loadSetup } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'
const loadTripClient = globals => loadModule(new URL('../../resources/js/api/trips.ts', import.meta.url), {
    './errors': loadModule(new URL('../../resources/js/api/errors.ts', import.meta.url), {}, globals),
}, globals)

const { ref, shallowRef } = vue

const tripUtils = loadModule(new URL('../../resources/js/utils/trips.ts', import.meta.url))
const failures = loadModule(new URL('../../resources/js/utils/tripFailure.ts', import.meta.url))
const candidates = loadModule(new URL('../../resources/js/utils/tripCandidates.ts', import.meta.url))
const utils = { ...tripUtils, ...failures, ...candidates }
// Invented values only, unrelated to any saved link or real place.
const selection = { version: 1, mode: 'driving', start: { lon: .1234567890123, lat: .2345678900456 }, places: [
    { lon: .124, lat: .235, label: 'Синтетическая точка A & тест' },
    { lon: .125, lat: .236, label: 'Синтетическая точка B' },
] }

test('trip link retains explicit points, order and personal labels without rounding or address IDs', () => {
    const url = utils.tripUrl(selection)
    const parsed = utils.parseTripLink(url.slice(url.indexOf('#')))
    assert.equal(new URL(url, 'https://synthetic.invalid').search, '')
    assert.equal(parsed.invalid, false)
    assert.deepEqual(parsed.selection, selection)
    assert.equal(utils.parseTripLink('').selection, null)
})

test('invalid, duplicate, unsupported or oversized trip links never become a default trip', () => {
    for (const input of [null, {}, { ...selection, mode: 'cycling' }, { ...selection, version: 2 },
        { ...selection, places: [] }, { ...selection, places: Array(4).fill(selection.places[0]) },
        { ...selection, start: { lon: 181, lat: 56 } }, { ...selection, start: { lon: '92.86', lat: 56 } },
        { ...selection, places: [{ lon: 92.8, lat: 56, label: 'x'.repeat(81) }] }]) {
        assert.deepEqual(utils.parseTripLink('?' + new URLSearchParams({ trip: JSON.stringify(input) })), { selection: null, invalid: true })
    }
    assert.equal(utils.parseTripLink('?trip=%7Bbroken').invalid, true)
    assert.equal(utils.parseTripLink('?trip=' + 'x'.repeat(2001)).invalid, true)
    assert.equal(utils.parseTripLink('?trip={}&trip={}').invalid, true)
})

test('formatting does not turn sub-minute durations or small nonzero snaps into made-up minutes or zero', () => {
    assert.equal(utils.tripDuration(25), 'менее 1 мин')
    assert.equal(utils.tripDuration(0), '0 мин')
    assert.equal(utils.snapDistance(.03), 'менее 0,1 м')
    assert.equal(utils.tripDistance(1200), '1,2 км')
})

const build = (ref, shallowRef, onBeforeUnmount, fetchTrips) => loadModule(new URL('../../resources/js/composables/useTripAnalysis.ts', import.meta.url), { vue: { ...vue, ref, shallowRef, onBeforeUnmount }, '@/api/trips': { fetchTrips } }).useTripAnalysis

test('changing inputs cancels old routes and late successes cannot restore a previous selection', async () => {
    const pending = []
    const state = build(ref, shallowRef, () => {}, (value, signal) => new Promise(resolve => pending.push({ value, signal, resolve })))()
    try {
        const old = state.analyze(selection)
        state.clear()
        assert.equal(pending[0].signal.aborted, true)
        assert.equal(state.analysis.value, null)
        const recent = state.analyze({ ...selection, places: selection.places.slice(1) })
        pending[1].resolve({ results: [{ status: 'NO_PATH', route: null }] })
        await recent
        pending[0].resolve({ results: [{ status: 'AVAILABLE', route: { duration_s: 10 } }] })
        await old
        assert.deepEqual(state.analysis.value.results, [{ status: 'NO_PATH', route: null }])
        assert.equal(state.status.value, 'ready')
    } finally { state.clear() }
})

test('partial results retain independent unknown cells and a failed request can be retried', async () => {
    let fail = true
    const response = { results: [{ status: 'AVAILABLE', route: { duration_s: 12 } }, { status: 'UNAVAILABLE', route: null }] }
    const state = build(ref, shallowRef, () => {}, async () => { if (fail) throw new Error('Нет связи'); return response })()
    try {
        await state.analyze(selection)
        assert.equal(state.status.value, 'error')
        assert.equal(state.analysis.value, null)
        fail = false
        await state.analyze(selection)
        assert.equal(state.error.value, '')
        assert.deepEqual(state.analysis.value, response)
        assert.equal(state.analysis.value.results[1].route, null)
    } finally { state.clear() }
})

// Domain tests execute the real module and real transport, mocking only fetch and lifecycle.
const settleTrips = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
function tripsHarness(initial, reply) {
    const disposed = [], calls = [], saves = [], scope = vue.effectScope()
    const lifecycleVue = { ...vue, onBeforeUnmount: fn => disposed.push(fn) }
    const transport = loadModule(new URL('../../resources/js/composables/useTripAnalysis.ts', import.meta.url), {
        vue: lifecycleVue, '@/api/trips': { fetchTrips(value, signal) { calls.push(value); return reply(value, signal) } },
    })
    const { useTripsState } = loadModule(new URL('../../resources/js/composables/useTripsState.ts', import.meta.url), {
        vue: lifecycleVue, '@/composables/useTripAnalysis': transport, '@/utils/tripCandidates': candidates,
    })
    const trips = scope.run(() => useTripsState({
        saveSelection(value, mode) { saves.push({ value, mode }) }, beginRun: () => async () => {},
    }))
    trips.restore(initial)
    return { trips, state: trips, calls, saves, dispose() { disposed.forEach(fn => fn()); scope.stop() } }
}

test('trip fetch uses a fixed URL, no-store and no-referrer; selection travels only in POST body', async () => {
    let seen
    const { fetchTrips } = loadTripClient({ fetch: async (url, options) => {
        seen = { url, options }; return { ok: true, json: async () => ({ mode: 'driving', start: selection.start, results: selection.places.map((target, index) => ({ index, start: selection.start, target, status: 'UNKNOWN', route: null, snaps: null, metrics: { distance: { value: null }, duration: { value: null } } })) }) }
    } })
    await fetchTrips(selection, new AbortController().signal)
    assert.equal(seen.url, '/api/v1/trips/analyze')
    assert.equal(seen.options.referrerPolicy, 'no-referrer')
    assert.equal(seen.options.cache, 'no-store')
    assert.equal(seen.options.method, 'POST')
    assert.deepEqual(JSON.parse(seen.options.body).places, selection.places)
})

const roadSelection = { ...selection, start: { ...selection.start, road: { lon: .1235, lat: .2346 } },
    places: selection.places.map(p => ({ ...p, road: { lon: p.lon + .00001, lat: p.lat } })) }

test('original and road points both round-trip through fragment and invalid road data is refused', () => {
    assert.deepEqual(utils.parseTripLink(utils.tripUrl(roadSelection).split('#')[1]).selection, roadSelection)
    for (const bad of [null, { lon: 0 }, { lon: '0', lat: 0 }, { lon: Infinity, lat: 0 }]) {
        const changed = { ...selection, start: { ...selection.start, road: bad } }
        assert.equal(utils.parseTripLink('?' + new URLSearchParams({ trip: JSON.stringify(changed) })).invalid, true)
    }
})

const mapUtils = loadModule(new URL('../../resources/js/utils/tripMap.ts', import.meta.url), { '@/utils/tripCandidates': candidates })
const snaps = { start: { original: selection.start, matched: roadSelection.start.road, distance_m: 10 },
    target: { original: selection.places[0], matched: roadSelection.places[0].road, distance_m: 8 } }
const accepted = { index: 0, label: 'Синтетическая A', status: 'AVAILABLE', reason: 'Synthetic', checks: [], snaps,
    route: { geometry: { type: 'LineString', coordinates: [[snaps.start.matched.lon, snaps.start.matched.lat], [snaps.target.matched.lon, snaps.target.matched.lat]] }, distance_m: 100, duration_s: 480 } }

test('actual map data retains originals, separate road ends, dashed connectors and only accepted routes', () => {
    const points = [{ key: 'S', point: selection.start }, { key: '1', point: selection.places[0] }]
    const data = mapUtils.tripMapData(points, { results: [accepted, { ...accepted, index: 1, status: 'UNKNOWN' }] })
    assert.equal(data.features.filter(f => f.properties.kind === 'route').length, 1)
    assert.equal(data.features.filter(f => f.properties.kind === 'connector').length, 2)
    assert.equal(data.features.filter(f => f.properties.kind === 'matched').length, 2)
    assert.deepEqual(data.features.find(f => f.properties.kind === 'original').geometry.coordinates, [selection.start.lon, selection.start.lat])
    const empty = mapUtils.tripMapData(points, null)
    assert.equal(empty.features.filter(f => f.geometry.type === 'LineString').length, 0)
    const choice = { status: 'CHOOSE', point: null, candidates: [{ point: { lon: .1, lat: .1 }, distance_m: 4 }, { point: { lon: .2, lat: .1 }, distance_m: 4.4 }] }
    assert.equal(mapUtils.tripMapData(points, { results: [{ ...accepted, status: 'NEEDS_REFINEMENT', road_choices: { start: choice } }] }).features.filter(f => f.properties.kind === 'candidate').length, 2)
    const source = readFileSync(new URL('../../resources/js/utils/tripMap.ts', import.meta.url), 'utf8')
    assert.ok(source.includes("'line-dasharray': [2, 3]"))
})

const refusal = (status, checks) => ({ ...accepted, index: 1, label: 'Синтетическая B', status, checks, reason: 'RAW_TECHNICAL_REASON', route: null, snaps: null,
    diagnostics: { version: 1, issues: checks.filter(code => code !== 'SNAP_NO_SAFE_CANDIDATE' || checks.length === 1).map(code => ({ code,
        category: code.includes('ACCESS') ? 'access' : code.includes('BARRIER') ? 'obstacle' : code === 'SNAP_CHOICE_REQUIRED' ? 'ambiguity' : code === 'ROUTER_UNAVAILABLE' ? 'service' : code === 'OUTSIDE_CONFIRMED_COVERAGE' ? 'coverage' : code === 'SNAP_NO_SAFE_CANDIDATE' ? 'distance' : 'insufficient_data',
        stage: 'snap', location: code === 'ROUTER_UNAVAILABLE' ? 'unknown' : code.includes('SOURCE_') ? 'route' : 'target', target_index: code === 'ROUTER_UNAVAILABLE' || code.includes('SOURCE_') ? null : 1 })) } })
const refusalCases = [
    [refusal('NEEDS_REFINEMENT', ['SNAP_NO_SAFE_CANDIDATE']), 'Нужно уточнить место 2', 'В пределах 35 м', 'point'],
    [refusal('UNKNOWN', ['SOURCE_NODE_ACCESS_UNKNOWN']), 'Ограничение на участке маршрута', 'Недостаточно данных о разрешённом', 'review'],
    [refusal('NEEDS_REFINEMENT', ['SNAP_NO_SAFE_CANDIDATE', 'SNAP_THROUGH_BARRIER']), 'Нужно уточнить место 2', 'В модели найдено препятствие', 'point'],
    [refusal('OUTSIDE_PILOT', ['OUTSIDE_CONFIRMED_COVERAGE']), 'Нужно уточнить место 2', 'территорию пилота', 'point'],
    [refusal('UNAVAILABLE', ['ROUTER_UNAVAILABLE']), 'Расчёт временно недоступен', 'Повторите расчёт', 'retry'],
]

test('failure guidance is selected from backend codes and never claims an unknown gate is closed', () => {
    for (const [row, title, actionText, action] of refusalCases) {
        const message = utils.tripFailureMessage(row)
        assert.equal(message.title, title)
        assert.ok(message.description.includes(actionText))
        assert.equal(message.action, action)
        assert.doesNotMatch(message.title + message.description, /RAW_|SOURCE_|SNAP_|private|lift_gate|проезд запрещён|ограда закрыта/)
    }
    assert.equal(utils.tripFailureMessage(refusal('NEEDS_REFINEMENT', ['SNAP_CHOICE_REQUIRED'])).action, 'choice')
    assert.equal(utils.tripFailureMessage({ ...refusal('UNKNOWN', []), diagnostics: undefined, reason: 'Старт SNAP_THROUGH_BARRIER' }).location, 'unknown')
})

test('late refusal cannot reappear after a point edit', async () => {
    let finish
    const state = build(ref, shallowRef, () => {}, () => new Promise(resolve => { finish = resolve }))()
    try {
        const pending = state.analyze(selection)
        state.clear()
        finish({ results: [refusal('NEEDS_REFINEMENT', ['SNAP_THROUGH_BARRIER'])] })
        await pending
        assert.equal(state.analysis.value, null)
        assert.equal(state.status.value, 'idle')
    } finally { state.clear() }
})

const alternatives = [
    { point: { lon: .1251, lat: .236 }, distance_m: 11.1, name: 'Синтетическая <улица>' },
    { point: { lon: .1249, lat: .236 }, distance_m: 11.2 },
]
const waitingRow = { ...refusal('NEEDS_REFINEMENT', ['SNAP_CHOICE_REQUIRED']), road_choices: {
    start: { status: 'SELECTED', point: roadSelection.start.road, candidates: [] },
    target: { status: 'CHOOSE', point: null, candidates: alternatives },
} }
function choiceReply(value) {
    const road = value.places[1].road
    return { results: [accepted, road ? { ...accepted, index: 1, label: waitingRow.label,
        road_choices: { start: waitingRow.road_choices.start, target: { status: 'SELECTED', manual: true, point: road, candidates: alternatives.filter(c => utils.sameRoadPoint(c.point, road)) } } } : waitingRow], source: null, limitation: 'Synthetic' }
}

test('hover and focus share a candidate identity without selecting it or making an extra request', async () => {
    const h = tripsHarness(selection, choiceReply)
    try {
        await settleTrips()
        h.trips.candidateFocus('2-1', 'pointer')
        assert.equal(h.trips.highlightedCandidate.value, '2-1')
        h.trips.candidateFocus('2-0', 'focus')
        assert.equal(h.trips.highlightedCandidate.value, '2-0')
        h.trips.candidateFocus('2-1', 'pointer')
        assert.equal(h.trips.highlightedCandidate.value, '2-1')
        h.trips.candidateFocus(null, 'pointer')
        assert.equal(h.trips.highlightedCandidate.value, '2-0')
        h.trips.candidateFocus('2-1', 'pointer')
        h.trips.candidateFocus(null, 'focus')
        assert.equal(h.trips.highlightedCandidate.value, '2-1')
        assert.equal(h.trips.selection().places[1].road, undefined)
        assert.equal(h.calls.length, 1)
    } finally { h.dispose() }
})

test('a saved road hint outside the current candidates does not appear selected in an ambiguous response', async () => {
    const h = tripsHarness(roadSelection, () => ({ results: [accepted, waitingRow] }))
    try {
        await settleTrips()
        assert.equal(h.trips.candidateGroups.value[0].selected, null)
        assert.equal(h.calls.length, 1)
    } finally { h.dispose() }
})

test('candidate GeoJSON retains both real positions and marks the selected option after routing', () => {
    const group = { key: '2', label: 'Место 2', candidates: alternatives, selected: alternatives[1].point }
    const data = mapUtils.tripMapData([{ key: '2', point: selection.places[1] }], choiceReply(roadSelection), [group])
    const candidates = data.features.filter(f => f.properties.kind === 'candidate')
    assert.equal(candidates.length, 2)
    assert.deepEqual(candidates.map(f => f.geometry.coordinates), alternatives.map(c => [c.point.lon, c.point.lat]))
    assert.deepEqual(candidates.map(f => f.properties.selected), [false, true])
    assert.ok(candidates.every(f => f.properties.waiting === false))
})

test('crowded candidate buttons separate in pixels without modifying source positions', () => {
    const points = [{ x: 100, y: 100 }, { x: 103, y: 100 }], before = structuredClone(points)
    const offsets = utils.candidateMarkerOffsets(points, [{ x: 101, y: 100 }])
    const drawn = points.map((p, i) => ({ x: p.x + offsets[i][0], y: p.y + offsets[i][1] }))
    assert.ok(Math.hypot(drawn[0].x - drawn[1].x, drawn[0].y - drawn[1].y) >= 44)
    assert.deepEqual(points, before)
    assert.deepEqual(utils.candidateMarkerOffsets([{ x: 10, y: 10 }], []), [[0, 0]])
})

test('action summary uses existing backend guidance and describes ambiguity as a choice with a count', () => {
    assert.equal(utils.tripActionNotice(accepted), null)
    const choice = utils.tripActionNotice(waitingRow)
    assert.equal(choice.text, 'Место 2: выберите дорожную точку места 2 — вариантов: 2')
    assert.equal(choice.label, 'Выбрать вариант')
    assert.doesNotMatch(choice.text, /ошибк|отказ|SNAP_|RAW_/)
    for (const [row, title, , action] of refusalCases) {
        const notice = utils.tripActionNotice(row)
        assert.ok(notice.text.includes(title.toLocaleLowerCase('ru')))
        assert.equal(notice.label, action === 'retry' ? 'Повторить расчёт' : action === 'review' ? 'Проверить точки' : 'Уточнить место 2')
        assert.doesNotMatch(notice.text, /SOURCE_|SNAP_|ROUTER_|RAW_|закрыта|запрещён/)
    }
    const both = utils.tripActionNotice({ ...waitingRow, road_choices: { start: waitingRow.road_choices.target, target: waitingRow.road_choices.target } })
    assert.ok(both.text.includes('вариантов: 4'))
})

test('removing a middle target reindexes only retained results and candidates; adding leaves them visible', async () => {
    const three = { ...selection, places: [...selection.places, { lon: .126, lat: .237, label: 'Синтетическая C' }] }
    const third = { ...waitingRow, index: 2 }
    const h = tripsHarness(three, () => ({ results: [accepted, { ...accepted, index: 1 }, third] }))
    try {
        await settleTrips()
        h.trips.removePlace(1)
        assert.deepEqual(h.state.analysis.value.results.map(row => row.index), [0, 1])
        assert.equal(h.state.analysis.value.results[0], accepted)
        assert.equal(h.state.analysis.value.results[1].status, 'NEEDS_REFINEMENT')
        assert.equal(h.trips.candidateGroups.value[0].key, '2')
        assert.deepEqual(h.trips.dirtyIndices.value, [])
        await h.trips.addPlace()
        assert.equal(h.state.analysis.value.results.length, 2)
        assert.deepEqual(h.trips.dirtyIndices.value, [2])
    } finally { h.dispose() }
})

test('the actual request state aborts after a coordinate edit and late answers cannot overwrite retained siblings', async () => {
    const pending = []
    let defer = false
    const h = tripsHarness(selection, (value, signal) => defer ? new Promise(resolve => pending.push({ value, signal, resolve })) : Promise.resolve(choiceReply(value)))
    try {
        for (let i = 0; i < 4; i++) await settleTrips()
        defer = true
        h.trips.chooseRoad('2', alternatives[1].point)
        assert.equal(h.state.analysis.value.results[0], accepted)
        h.trips.draft.places[1].lon = .3
        assert.equal(pending[0].signal.aborted, true)
        assert.deepEqual(h.state.analysis.value.results, [accepted])
        pending[0].resolve(choiceReply(pending[0].value))
        for (let i = 0; i < 4; i++) await settleTrips()
        assert.deepEqual(h.state.analysis.value.results, [accepted])
        assert.deepEqual(h.trips.dirtyIndices.value, [1])
        assert.equal(h.trips.draft.places[1].road, undefined)
        assert.equal(h.trips.candidateGroups.value.length, 0)
    } finally { h.dispose() }
})

for (const location of ['start', 'target', 'both_endpoints', 'route', 'unknown']) test(`Goal 6 structured ${location} localization ignores misleading reason/checks`, () => {
    const row = { ...refusal('UNKNOWN', ['SNAP_THROUGH_BARRIER']), reason: 'Уточнить старт', diagnostics: { version: 1, issues: [{ code: 'FUTURE_CODE', category: 'access', stage: 'geometry', location, target_index: ['target', 'both_endpoints'].includes(location) ? 1 : null }] } }
    const message = utils.tripFailureMessage(row)
    assert.equal(message.location, location)
    assert.equal(message.action, ['route', 'unknown'].includes(location) ? 'review' : 'point')
    assert.doesNotMatch(message.description, /перед ним|до этого участка|ограждение|проезд запрещён/)
    if (location === 'target') assert.equal(message.label, 'Уточнить место 2')
    if (location === 'start') assert.equal(message.label, 'Уточнить старт')
})

test('Goal 6 missing or mismatched request target indices never guess a problematic endpoint', () => {
    const row = refusalCases[0][0]
    assert.equal(utils.tripFailureMessage({ ...row, diagnostics: undefined }).location, 'unknown')
    assert.equal(utils.tripFailureMessage({ ...row, diagnostics: { version: 1, issues: [{ ...row.diagnostics.issues[0], target_index: 0 }] } }).location, 'unknown')
    assert.equal(utils.tripFailureMessage({ ...row, diagnostics: { version: 2, issues: row.diagnostics.issues } }).location, 'unknown')
})

test('Goal 6 mixed issues retain independently proven start, target and route positions', () => {
    const issues = ['start', 'target', 'route'].map(location => ({ code: 'TEST', category: 'obstacle', stage: 'geometry', location, target_index: location === 'target' ? 1 : null }))
    assert.deepEqual(utils.tripFailureMessages({ ...refusal('UNKNOWN', []), diagnostics: { version: 1, issues } }).map(message => message.location), ['start', 'target', 'route'])
})

test('Goal 6 removing earlier target reindexes retained structured diagnostics with its result', async () => {
    const h = tripsHarness(selection, () => ({ results: [accepted, refusalCases[0][0]] }))
    try {
        await settleTrips()
        h.trips.removePlace(0)
        const row = h.state.analysis.value.results[0]
        assert.equal(row.index, 0)
        assert.equal(row.diagnostics.issues[0].target_index, 0)
        assert.equal(utils.tripFailureMessage(row).label, 'Уточнить место 1')
    } finally { h.dispose() }
})

for (const change of ['target', 'start', 'remove', 'reset', 'restore', 'new request', 'unmount', 'mode']) {
    test(`standalone state ignores delivered late response after ${change}`, async () => {
        const pending = []
        let defer = false
        const h = tripsHarness(selection, (value, signal) => defer
            ? new Promise(resolve => pending.push({ value, signal, resolve })) : Promise.resolve(choiceReply(value)))
        try {
            await settleTrips()
            defer = true
            h.trips.submit()
            if (change === 'target') h.trips.draft.places[1].lon = .8
            if (change === 'start') h.trips.draft.start.lat = .9
            if (change === 'remove') h.trips.removePlace(0)
            if (change === 'reset') h.trips.restore(null)
            if (change === 'restore') h.trips.restore(roadSelection)
            if (change === 'new request') h.trips.chooseRoad('2', alternatives[1].point)
            if (change === 'unmount') h.dispose()
            if (change === 'mode') h.trips.setMode('walking')
            assert.equal(pending[0].signal.aborted, true)
            const before = {
                analysis: h.trips.analysis.value, status: h.trips.status.value, error: h.trips.error.value,
                selection: JSON.stringify(h.trips.selection()), candidates: JSON.stringify(h.trips.candidateGroups.value),
                dirty: [...h.trips.dirtyIndices.value], pending: [...h.trips.pendingChoiceIndices.value], saves: h.saves.length,
            }
            // Delivery deliberately ignores abort, as when the response already left the network.
            pending[0].resolve({ results: [accepted, waitingRow] })
            await settleTrips()
            assert.equal(h.trips.analysis.value, before.analysis)
            assert.equal(h.trips.status.value, before.status)
            assert.equal(h.trips.error.value, before.error)
            assert.equal(JSON.stringify(h.trips.selection()), before.selection)
            assert.equal(JSON.stringify(h.trips.candidateGroups.value), before.candidates)
            assert.deepEqual(h.trips.dirtyIndices.value, before.dirty)
            assert.deepEqual(h.trips.pendingChoiceIndices.value, before.pending)
            assert.equal(h.saves.length, before.saves)
            if (pending[1]) {
                pending[1].resolve({ results: [{ ...accepted, route: null, status: 'UNKNOWN', snaps: null }] })
                await settleTrips()
                assert.equal(h.trips.analysis.value.results[0].status, 'UNKNOWN')
            }
        } finally { h.dispose() }
    })
}


const walkingSelection = { ...selection, mode: 'walking' }
const street = { start: { lon: .1236, lat: .2347 }, target: { lon: .1242, lat: .2352 } }
const walkingRow = {
    ...accepted, start: selection.start, target: selection.places[0], route_scope: 'street_points',
    street_points: street, selection_kind: 'DIFFERENT_STREET_POINTS',
    approaches: Object.fromEntries(['start', 'target'].map(end => [end, { status: 'UNKNOWN',
        original: end === 'start' ? selection.start : selection.places[0], selected_street: street[end],
        selection_shift_m: end === 'start' ? 33 : 12, distance_m: null, duration_s: null, reason: 'Synthetic approach unknown' }])),
    address_metrics: { distance: { value: null }, duration: { value: null } },
    metrics: { distance: { value: 100 }, duration: { value: 480 } },
}

test('mode switch clears prior results, candidates, road hints and errors while retaining originals and labels', async () => {
    const h = tripsHarness(selection, value => Promise.resolve(choiceReply(value)))
    try {
        await settleTrips()
        assert.ok(h.trips.candidateGroups.value.length)
        h.trips.formError.value = 'Synthetic error'
        h.trips.invalidLink.value = true
        h.trips.setMode('walking')
        assert.equal(h.calls.length, 1)
        assert.equal(h.trips.mode.value, 'walking')
        assert.equal(h.trips.analysis.value, null)
        assert.equal(h.trips.status.value, 'idle')
        assert.equal(h.trips.error.value, '')
        assert.equal(h.trips.formError.value, '')
        assert.equal(h.trips.invalidLink.value, false)
        assert.equal(h.trips.hasCalculated.value, false)
        assert.deepEqual(h.trips.candidateGroups.value, [])
        assert.deepEqual(h.trips.pendingChoiceIndices.value, [])
        assert.deepEqual(h.trips.failedChoiceIndices.value, [])
        assert.deepEqual(h.trips.selection(), walkingSelection)
        h.trips.submit()
        assert.equal(h.calls.length, 2)
        assert.equal(h.calls[1].mode, 'walking')
        await settleTrips()
        assert.equal(h.trips.draft.start.road, undefined)
        assert.equal(h.trips.draft.places[0].road, undefined)
    } finally { h.dispose() }
})

test('walking response never promotes server choice or snapped coordinates into explicit streets or history', async () => {
    const reply = { mode: 'walking', results: [{ ...walkingRow, road_choices: {
        start: { status: 'SELECTED', point: street.start }, target: { status: 'NEEDS_REFINEMENT', point: street.target },
    } }] }
    const h = tripsHarness(walkingSelection, () => Promise.resolve(reply))
    try {
        await settleTrips()
        assert.equal(h.trips.draft.start.road, undefined)
        assert.equal(h.trips.draft.places[0].road, undefined)
        assert.deepEqual(h.saves.at(-1).value, walkingSelection)
        h.trips.chooseRoad('S', street.start)
        assert.equal(h.calls.length, 2)
        assert.deepEqual(h.calls.at(-1).start, { ...selection.start, road: street.start })
        await settleTrips()
        h.trips.resetRoad('S')
        assert.equal(h.calls.at(-1).start.road, undefined)
        assert.deepEqual(h.trips.selection().start, selection.start)
    } finally { h.dispose() }
})

const walkingAlternatives = [
    { point: { lon: .12402, lat: .23501 }, distance_m: 2.3, name: 'Synthetic street A' },
    { point: { lon: .12404, lat: .23502 }, distance_m: 4.6, name: 'Synthetic street B' },
]
function walkingChoiceRow(location = 'target') {
    return { ...walkingRow, index: 0, status: 'NEEDS_REFINEMENT', route: null, snaps: null,
        diagnostics: { version: 1, issues: [{ code: 'SNAP_CHOICE_REQUIRED', category: 'ambiguity', stage: 'snap',
            location, target_index: location === 'start' ? null : 0 }] },
        road_choices: { start: { status: location === 'start' ? 'CHOOSE' : 'SELECTED',
            ...(location === 'start' ? { candidates: walkingAlternatives } : { point: street.start }) },
            target: { status: location === 'start' ? 'SELECTED' : 'CHOOSE',
                ...(location === 'start' ? { point: street.target } : { candidates: walkingAlternatives }) } } }
}

test('walking candidate selection preserves originals, checks normally, drops previous alternatives and ignores late replies', async () => {
    let defer = false
    const pending = [], initial = { ...walkingSelection, places: [walkingSelection.places[0]] }
    const chosen = walkingAlternatives[1].point
    const h = tripsHarness(initial, (value, signal) => {
        const response = value.places[0].road ? { mode: 'walking', results: [{ ...walkingRow,
            road_choices: { start: { status: 'SELECTED', point: street.start }, target: { status: 'SELECTED', point: chosen } } }] }
            : { mode: 'walking', results: [walkingChoiceRow()] }
        return defer ? new Promise(resolve => pending.push({ value, signal, resolve, response })) : Promise.resolve(response)
    })
    try {
        await settleTrips()
        assert.equal(h.trips.selection().places[0].road, undefined)
        h.trips.chooseRoad('1', chosen)
        assert.equal(h.calls.length, 2)
        assert.deepEqual(h.calls[1].places[0], { ...initial.places[0], road: chosen })
        assert.deepEqual(h.calls[1].start, initial.start)
        await settleTrips()
        assert.equal(h.trips.analysis.value.results[0].status, 'AVAILABLE')
        assert.deepEqual(h.trips.candidateGroups.value, [])
        assert.deepEqual(h.trips.selection().places[0].road, chosen)
        assert.deepEqual(h.saves.at(-1).value.places[0], { ...initial.places[0], road: chosen })
        defer = true
        h.trips.chooseRoad('1', walkingAlternatives[0].point)
        h.trips.setMode('driving')
        assert.equal(pending[0].signal.aborted, true)
        pending[0].resolve(pending[0].response)
        await settleTrips()
        assert.equal(h.trips.analysis.value, null)
        assert.deepEqual(h.trips.candidateGroups.value, [])
        assert.equal(h.trips.selection().places[0].road, undefined)
    } finally { h.dispose() }
})

test('walking SELECTED without candidates has no mandatory empty choice and stale explicit input does not select a CHOOSE option', async () => {
    const withStreet = { ...walkingSelection, places: [{ ...walkingSelection.places[0], road: walkingAlternatives[0].point }] }
    const h = tripsHarness(withStreet, () => Promise.resolve({ mode: 'walking', results: [walkingChoiceRow()] }))
    try {
        await settleTrips()
        assert.equal(h.trips.candidateGroups.value.length, 1)
        assert.equal(h.trips.candidateGroups.value[0].key, '1')
        assert.equal(h.trips.candidateGroups.value[0].selected, null)
        assert.deepEqual(h.trips.selection(), withStreet)
    } finally { h.dispose() }
})


for (const outcome of ['AVAILABLE', 'UNKNOWN', 'partial']) {
    test(`walking manual street edit drops checked candidates immediately and after ${outcome}`, async () => {
        const pending = [], initial = { ...walkingSelection, places: [walkingSelection.places[0]] }
        const manual = { lon: .8, lat: .9 }
        const h = tripsHarness(initial, (value, signal) => value.places[0].road
            ? new Promise(resolve => pending.push({ value, signal, resolve }))
            : Promise.resolve({ mode: 'walking', results: [walkingChoiceRow()] }))
        try {
            await settleTrips()
            assert.equal(h.trips.candidateGroups.value[0].candidates.length, 2)
            h.trips.chooseRoad('1', manual)
            assert.deepEqual(h.trips.candidateGroups.value, [])
            assert.equal(h.trips.analysis.value.results[0].route, null)
            assert.deepEqual(h.trips.selection().places[0], { ...initial.places[0], road: manual })
            const row = { ...walkingRow, status: outcome, route: outcome === 'AVAILABLE' ? walkingRow.route : null,
                road_choices: { start: { status: 'SELECTED', point: street.start }, target: { status: outcome === 'AVAILABLE' ? 'SELECTED' : 'UNKNOWN',
                    point: outcome === 'AVAILABLE' ? manual : null, candidates: walkingAlternatives } } }
            pending[0].resolve({ mode: 'walking', results: outcome === 'partial' ? [] : [row] })
            await settleTrips()
            assert.deepEqual(h.trips.candidateGroups.value, [])
            assert.deepEqual(h.trips.selection().places[0].road, manual)
            if (outcome === 'UNKNOWN') assert.equal(h.trips.analysis.value.results[0].route, null)
        } finally { h.dispose() }
    })
}

test('walking only presents fresh CHOOSE candidates after a manual edit and ignores superseded candidate replies', async () => {
    const pending = [], initial = { ...walkingSelection, places: [walkingSelection.places[0]] }
    const fresh = [{ point: { lon: .80001, lat: .90001 }, distance_m: 1.2, name: 'New street input' }]
    const h = tripsHarness(initial, (value, signal) => value.places[0].road
        ? new Promise(resolve => pending.push({ value, signal, resolve }))
        : Promise.resolve({ mode: 'walking', results: [walkingChoiceRow()] }))
    try {
        await settleTrips()
        h.trips.chooseRoad('1', { lon: .8, lat: .9 })
        h.trips.chooseRoad('1', { lon: .81, lat: .91 })
        assert.equal(pending[0].signal.aborted, true)
        pending[0].resolve({ mode: 'walking', results: [walkingChoiceRow()] })
        await settleTrips()
        assert.deepEqual(h.trips.candidateGroups.value, [])
        const row = walkingChoiceRow()
        row.road_choices.target.candidates = fresh
        pending[1].resolve({ mode: 'walking', results: [row] })
        await settleTrips()
        assert.deepEqual(h.trips.candidateGroups.value.map(group => group.candidates), [fresh])
        assert.deepEqual(h.trips.selection().places[0].road, { lon: .81, lat: .91 })
    } finally { h.dispose() }
})
