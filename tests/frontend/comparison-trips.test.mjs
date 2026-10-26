import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { stateModule, personalUtils, ComparisonTrips, ComparisonShare, ComparisonTripData, failure } from './support/comparison-trips-dependencies.mjs'

const a = { lon: 92.87, lat: 56.01 }, b = { lon: 92.89, lat: 56.02 }
const source = { name: 'Synthetic OSM', engine: 'OSRM', dataset_version: 'test-v1', observed_at: null }
function response(selection, statuses = []) {
    return { mode: selection.mode ?? 'driving', start: selection.start, source, limitation: 'Synthetic, no actual traffic or parking.', results: selection.places.map((target, index) => {
        const available = !statuses[index]
        const snap = point => ({ original: point, matched: point.road ?? { lon: point.lon + .00001, lat: point.lat }, distance_m: 1 })
        return { index, start: selection.start, target, label: target.label, status: available ? 'AVAILABLE' : 'UNKNOWN', reason: 'Text says start, never used for location', checks: [],
            diagnostics: { version: 1, issues: available ? [] : [{ code: 'TEST', category: 'obstacle', stage: 'snap', location: statuses[index], target_index: index }] },
            route: available ? { geometry: { type: 'LineString', coordinates: [[selection.start.lon, selection.start.lat], [target.lon, target.lat]] }, distance_m: 1234 + index, duration_s: 321 } : null,
            snaps: available ? { start: snap(selection.start), target: snap(target) } : null,
            road_choices: null, metrics: { distance: { value: available ? 1234 : null }, duration: { value: available ? 321 : null } } }
    }) }
}
function setup(count = 3) {
    const pending = []; let cleanup
    const { useComparisonTrips } = stateModule((selection, signal) => new Promise((resolve, reject) => pending.push({ selection, signal, resolve, reject })), { ...vue, onBeforeUnmount: fn => { cleanup = fn } })
    const state = useComparisonTrips()
    state.setStart('left', 'a', a); state.setStart('right', 'b', b)
    const ids = Array.from({ length: count }, (_, i) => { const id = state.add(); state.setPoint(id, { lon: 92.91 + i * .01, lat: 56.03 }); return id })
    const resolve = (request, statuses) => request.resolve(response(request.selection, statuses))
    return { state, ids, pending, resolve, cleanup: () => cleanup() }
}
test('one and three common goals are grouped by start into two requests, giving two and six results', async () => {
    for (const count of [1, 3]) {
        const { state, pending, ids, resolve, cleanup } = setup(count)
        try {
            assert.equal(pending.length, 0)
            const run = state.calculate()
            assert.equal(pending.length, 2)
            assert.deepEqual(pending[0].selection.places, pending[1].selection.places)
            assert.deepEqual(pending[0].selection.start, a); assert.deepEqual(pending[1].selection.start, b)
            pending.forEach(p => resolve(p)); await run
            assert.equal(ids.flatMap(id => ['left', 'right'].map(side => state.cell(side, id).row)).filter(personalUtils.acceptedTrip).length, count * 2)
        } finally { cleanup() }
    }
})
test('partial and total refusal keep null metrics and do not declare the successful side better', async () => {
    const { state, pending, ids, resolve, cleanup } = setup()
    try {
        const run = state.calculate(); resolve(pending[0], [null, 'target', 'route']); resolve(pending[1], ['start', 'target', 'both_endpoints']); await run
        assert.equal(state.cell('left', ids[0]).row.status, 'AVAILABLE')
        assert.equal(state.cell('right', ids[0]).row.route, null)
        assert.match(personalUtils.pairedTripFact(state.cell('left', ids[0]), state.cell('right', ids[0])), /Недостаточно/)
        assert.match(personalUtils.pairedTripFact(state.cell('left', ids[1]), state.cell('right', ids[1])), /Недостаточно/)
        assert.equal(state.cell('left', ids[1]).row.metrics.distance.value, null)
    } finally { cleanup() }
})
test('rename preserves results; changing a target clears only its pair, removing it preserves stable identities', async () => {
    const { state, pending, ids, resolve, cleanup } = setup()
    try {
        const run = state.calculate(); pending.forEach(p => resolve(p)); await run
        const saved = state.cell('left', ids[2]).row
        state.places.value[2].label = 'Родители'
        assert.equal(state.cell('left', ids[2]).row, saved)
        state.setPoint(ids[1], { lon: 92.95, lat: 56.03 })
        assert.equal(state.cell('left', ids[1]).row, null); assert.equal(state.cell('right', ids[1]).row, null)
        assert.equal(state.cell('left', ids[2]).row, saved)
        state.remove(ids[0]); assert.equal(state.places.value[1].id, ids[2]); assert.equal(state.cell('left', ids[2]).row, saved)
        assert.equal(pending.length, 2)
    } finally { cleanup() }
})
test('changing address A clears only A immediately; same ID profile loading on radius change preserves routes', async () => {
    const { state, pending, ids, resolve, cleanup } = setup(1)
    try {
        const run = state.calculate(); pending.forEach(p => resolve(p)); await run
        const left = state.cell('left', ids[0]).row, right = state.cell('right', ids[0]).row
        state.setStart('left', 'a', null); assert.equal(state.cell('left', ids[0]).row, left)
        state.setStart('left', 'a', a); assert.equal(pending.length, 2)
        state.setStart('left', 'new-a', null)
        assert.equal(state.starts.left.point, null); assert.equal(state.cell('left', ids[0]).row, null)
        assert.equal(state.cell('right', ids[0]).row, right)
    } finally { cleanup() }
})
test('single goal retry maps request index zero to stable third goal and isolates per-trip road hints', async () => {
    const { state, pending, ids, resolve, cleanup } = setup()
    try {
        state.setRoad('left', ids[2], 'start', { lon: 92.87001, lat: 56.01 })
        state.setRoad('left', ids[2], 'target', { lon: 92.93001, lat: 56.03 })
        const run = state.calculate('left', ids[2]); assert.equal(pending.length, 1)
        assert.equal(pending[0].selection.places.length, 1)
        assert.equal(pending[0].selection.start.road.lon, 92.87001)
        resolve(pending[0], ['target']); await run
        assert.equal(state.cell('left', ids[2]).row.index, 0)
        const messages = failure.tripFailureMessages(state.cell('left', ids[2]).row, 'Родители')
        assert.equal(messages[0].location, 'target'); assert.match(messages[0].title, /Родители/)
        assert.equal(state.cell('right', ids[2]).hints.target, undefined)
        assert.equal(state.cell('left', ids[0]).hints.start, undefined)
    } finally { cleanup() }
})
test('road edit clears own result even in an incomplete form; failed retry never revives former success', async () => {
    const { state, pending, ids, resolve, cleanup } = setup(2)
    try {
        const first = state.calculate(); pending.forEach(p => resolve(p)); await first
        state.setPoint(ids[1], null)
        state.setRoad('left', ids[0], 'start', a)
        assert.equal(state.cell('left', ids[0]).row, null)
        assert.equal(state.cell('right', ids[0]).row.status, 'AVAILABLE')
        await state.calculate(); assert.match(state.formError.value, /Выберите/)
        const retry = state.calculate('left', ids[0]); pending.at(-1).reject(Error('technical')); await retry
        assert.equal(state.cell('left', ids[0]).row, null); assert.equal(state.cell('left', ids[0]).status, 'error')
    } finally { cleanup() }
})
test('late batch response after editing or deleting one goal applies only unchanged cells', async () => {
    const { state, pending, ids, resolve, cleanup } = setup()
    try {
        const first = state.calculate()
        state.setPoint(ids[0], { lon: 92.97, lat: 56.03 }); state.remove(ids[1])
        pending.forEach(p => resolve(p)); await first
        for (const side of ['left', 'right']) {
            assert.equal(state.cell(side, ids[0]).row, null)
            assert.equal(state.cells[side][ids[1]], undefined)
            assert.equal(state.cell(side, ids[2]).row.target.lon, 92.91 + 2 * .01)
        }
    } finally { cleanup() }
})
test('newer failed request and reset/restore with same ID reject all previous responses', async () => {
    const { state, pending, ids, resolve, cleanup } = setup(1)
    try {
        const first = state.calculate('left', ids[0])
        const second = state.calculate('left', ids[0]); pending[1].reject(Error()); await second
        resolve(pending[0]); await first; assert.equal(state.cell('left', ids[0]).row, null)
        const old = state.calculate('left', ids[0]), link = JSON.parse(JSON.stringify(state.linkSelection.value))
        state.restore(link)
        const fresh = state.calculate('left', ids[0]); pending.at(-1).reject(Error()); await fresh
        resolve(pending[2]); await old
        assert.equal(state.cell('left', ids[0]).row, null); assert.equal(state.cell('left', ids[0]).status, 'error')
    } finally { cleanup() }
})
test('fragment roundtrip bounds validates duplicates, versions, points, labels, hints and encoded size', () => {
    const value = { version: 1, mode: 'driving', places: [{ id: 'work', label: '<Работа & учёба>', point: a }], roads: { left: { work: { target: b } } } }
    const encoded = personalUtils.comparisonTripsFragment(value)
    assert.ok(encoded.startsWith('#places=')); assert.ok(!encoded.includes('?'))
    assert.deepEqual(JSON.parse(JSON.stringify(personalUtils.parseComparisonTrips(encoded).selection)), value)
    for (const invalid of [{ ...value, mode: 'cycling' }, { ...value, mode: null }, { ...value, version: 2 }, { ...value, places: [] }, { ...value, places: [...value.places, ...value.places] }, { ...value, places: [{ ...value.places[0], point: { lon: 181, lat: 1 } }] }, { ...value, roads: { left: { foreign: { target: b } } } }, { ...value, places: [{ ...value.places[0], label: 'x'.repeat(81) }] }])
        assert.equal(personalUtils.parseComparisonTrips('#places=' + encodeURIComponent(JSON.stringify(invalid))).invalid, true)
    for (const invalid of ['#places=bad', encoded + '&places={}', '#places=' + 'x'.repeat(16000)]) assert.equal(personalUtils.parseComparisonTrips(invalid).invalid, true)
    assert.deepEqual(personalUtils.parseComparisonTrips('#main-content'), { selection: null, invalid: false })
})
test('paired route fact requires accepted compatible sources, respects displayed precision and never turns a refusal into zero', () => {
    const accepted = response({ start: a, places: [{ ...b, label: 'Цель' }] }).results[0]
    const first = { row: accepted, source }
    const different = { row: { ...accepted, route: { ...accepted.route, distance_m: 1235 } }, source }
    assert.match(personalUtils.pairedTripFact(first, different), /одинакова в показанной точности/)
    assert.match(personalUtils.pairedTripFact(first, { ...different, source: { ...source, dataset_version: 'other' } }), /различаются/)
    assert.match(personalUtils.pairedTripFact(first, { ...different, source: null }), /различаются/)
    const refused = { ...first, row: { ...accepted, status: 'UNKNOWN', route: null, snaps: null } }
    assert.match(personalUtils.pairedTripFact(first, refused), /Недостаточно подтверждённых/)
    assert.match(personalUtils.pairedTripFact(first, { ...first, row: { ...accepted, route: { ...accepted.route, distance_m: -1 } } }), /Недостаточно подтверждённых/)
})
test('real component renders a compact pair, escaped labels, null refusals and separate source/privacy panels', async () => {
    const { state, pending, ids, resolve, cleanup } = setup(1)
    try {
        state.places.value[0].label = '<Работа>'
        const run = state.calculate(); resolve(pending[0]); resolve(pending[1], ['route']); await run
        const html = await renderToString(vue.createSSRApp(ComparisonTrips, { model: state, invalidLink: false }))
        assert.match(html, /А → &lt;Работа&gt;/); assert.match(html, /Б → &lt;Работа&gt;/)
        assert.equal((html.match(/class="personal-distance"/g) ?? []).length, 1)
        assert.match(html, /Показать маршрут А/)
        assert.match(html, /модельное время без пробок/); assert.doesNotMatch(html, /<table|<input|Источник расчёта/)
        const data = await renderToString(vue.createSSRApp(ComparisonTripData, { model: state }))
        assert.match(data, /Дата наблюдения: неизвестна/); assert.match(data, /Подход к дороге и парковка не рассчитаны/)
        assert.equal((data.match(/Источник расчёта/g) ?? []).length, 1)
        assert.match(data, /Точки и проверка · А → &lt;Работа&gt;/)
        const share = await renderToString(vue.createSSRApp(ComparisonShare, { addressUrl: 'http://synthetic.invalid/compare?left=a', personalUrl: 'http://synthetic.invalid/compare?left=a#places=example' }))
        assert.match(share, /Получатель увидит личные точки, подписи и дорожный выбор/)
        assert.ok(share.indexOf('Получатель увидит') < share.indexOf('Ссылка с личными местами'))
    } finally { cleanup() }
})

test('mode switch aborts all cells without fetching and preserves original IDs points and labels', async () => {
    const { state, pending, ids, resolve, cleanup } = setup(2)
    try {
        state.setRoad('left', ids[0], 'start', a)
        state.setRoad('right', ids[1], 'target', b)
        const original = JSON.stringify(state.places.value), starts = JSON.stringify(state.starts)
        const old = state.calculate()
        state.cell('right', ids[0]).options.target = [{ point: b, distance_m: 2 }]
        state.cell('right', ids[1]).error = 'old error'; state.formError.value = 'old form error'
        const count = pending.length
        state.setMode('walking')
        assert.equal(state.mode.value, 'walking'); assert.equal(pending.length, count)
        assert.equal(state.linkSelection.value.version, 2)
        assert.ok(pending.every(p => p.signal.aborted))
        assert.equal(JSON.stringify(state.places.value), original); assert.equal(JSON.stringify(state.starts), starts)
        for (const side of ['left', 'right']) for (const id of ids) {
            const value = state.cell(side, id)
            assert.equal(value.row, null); assert.equal(value.status, 'idle'); assert.equal(value.source, null)
            assert.deepEqual(JSON.parse(JSON.stringify(value.hints)), {}); assert.equal(value.options.target.length, 0)
            assert.equal(value.error, ''); assert.equal(value.limitation, '')
        }
        assert.equal(state.formError.value, '')
        pending.forEach(p => resolve(p)); await old
        assert.ok(ids.every(id => !state.cell('left', id).row && !state.cell('right', id).row))
        const fresh = state.calculate('left', ids[0]), request = pending.at(-1)
        assert.equal(request.selection.mode, 'walking'); assert.equal(request.selection.start.road, undefined)
        request.resolve({ ...response(request.selection), mode: 'driving' }); await fresh
        assert.equal(state.cell('left', ids[0]).status, 'error')
        assert.equal(state.cell('left', ids[0]).row, null)
    } finally { cleanup() }
})
test('walking has independent partial results, never adopts engine matches or car candidates, and shows manual choices before request', async () => {
    const { state, pending, ids, resolve, cleanup } = setup(2)
    try {
        state.setMode('walking')
        const before = await renderToString(vue.createSSRApp(ComparisonTrips, { model: state, invalidLink: false }))
        assert.match(before, /for="comparison-trip-mode"[^>]*>Режим маршрута/)
        assert.match(before, /Уличная точка старта А/); assert.match(before, /Уличная точка цели Б/)
        const run = state.calculate()
        for (const request of pending) {
            const value = response(request.selection, [null, 'target'])
            for (const row of value.results) {
                row.route_scope = 'street_points'
                row.selection_kind = 'DIFFERENT_STREET_POINTS'
                row.street_points = { start: a, target: b }
                row.approaches = Object.fromEntries(['start', 'target'].map(end => [end, { status: 'UNKNOWN', selection_shift_m: 50, distance_m: null, duration_s: null }]))
                row.metrics.distance.scope = 'street_points'
                row.metrics.duration.scope = 'street_points'
                if (row.route) row.route.scope = 'street_points'
                row.road_choices = { start: { status: 'NEEDS_REFINEMENT', manual: true } }
            }
            request.resolve(value)
        }
        await run
        assert.equal(state.cell('left', ids[0]).row.status, 'AVAILABLE')
        assert.equal(state.cell('left', ids[1]).row.status, 'UNKNOWN')
        assert.equal(state.cell('left', ids[1]).row.metrics.distance.value, null)
        assert.deepEqual(JSON.parse(JSON.stringify(state.cell('left', ids[0]).hints)), {})
        assert.equal(state.cell('left', ids[0]).options.start.length, 0)
        const fact = personalUtils.pairedTripFact(state.cell('left', ids[0]), state.cell('right', ids[0]), 'walking')
        assert.match(fact, /уличных частей/); assert.match(fact, /Полный путь от объектов и подходы не рассчитаны/)
        const after = await renderToString(vue.createSSRApp(ComparisonTrips, { model: state, invalidLink: false }))
        assert.match(after, /Только уличная часть/); assert.match(after, /Уличная точка старта А/)
        assert.doesNotMatch(after, /модель, без пробок/)
        const data = await renderToString(vue.createSSRApp(ComparisonTripData, { model: state }))
        assert.match(data, /Выбраны другие уличные точки/); assert.match(data, /Подход от объекта к улице неизвестен/)
        assert.match(data, /Полный путь между исходными объектами неизвестен/); assert.doesNotMatch(data, /Радиус проверки — 35 м/)
    } finally { cleanup() }
})
test('old comparison links default to driving while new walking links retain mode and per-cell streets', () => {
    const legacy = { version: 1, places: [{ id: 'work', label: 'Synthetic', point: a }], roads: { left: { work: { target: b } } } }
    const old = '#places=' + encodeURIComponent(JSON.stringify(legacy))
    assert.equal(personalUtils.parseComparisonTrips(old).selection.mode, 'driving')
    const walking = { ...legacy, version: 2, mode: 'walking' }
    const parsed = personalUtils.parseComparisonTrips(personalUtils.comparisonTripsFragment(walking)).selection
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), walking)
})

test('walking comparison links require v2 so the former v1 reader rejects them instead of using driving', () => {
    const legacy = { version: 1, places: [{ id: 'work', label: 'Synthetic', point: a }], roads: {} }
    const rawFragment = value => '#places=' + encodeURIComponent(JSON.stringify(value))
    // The previous reader accepted only version 1 and always routed it as driving.
    const previousReader = hash => {
        const input = JSON.parse(new URLSearchParams(hash.slice(1)).get('places'))
        return input.version === 1 ? { mode: 'driving' } : null
    }
    const driving = personalUtils.parseComparisonTrips(rawFragment(legacy)).selection
    assert.equal(driving.version, 1); assert.equal(driving.mode, 'driving')
    const drivingEncoded = personalUtils.comparisonTripsFragment(driving)
    assert.deepEqual(previousReader(drivingEncoded), { mode: 'driving' })
    const walking = { ...legacy, version: 2, mode: 'walking' }
    const encoded = personalUtils.comparisonTripsFragment(walking)
    assert.equal(personalUtils.parseComparisonTrips(encoded).selection.version, 2)
    assert.equal(previousReader(encoded), null)
    assert.equal(personalUtils.comparisonTripsFragment({ ...walking, version: 1 }), encoded)
    for (const invalid of [{ ...walking, version: 1 }, { ...legacy, version: 2 }, { ...legacy, version: 2, mode: 'driving' }, { ...walking, mode: 'cycling' }, { ...walking, mode: null }]) {
        assert.deepEqual(personalUtils.parseComparisonTrips(rawFragment(invalid)), { selection: null, invalid: true })
    }
})
