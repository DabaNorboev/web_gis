import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadModule, loadComponent, loadSetup } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'
const { ref, shallowRef } = vue

const tripUtils = loadModule(new URL('../../resources/js/utils/trips.ts', import.meta.url))
const failures = loadModule(new URL('../../resources/js/utils/tripFailure.ts', import.meta.url))
const candidates = loadModule(new URL('../../resources/js/utils/tripCandidates.ts', import.meta.url))
const utils = { ...tripUtils, ...failures, ...candidates }
function pageDependencies(deps) {
    return {
        '@/utils/trips': tripUtils, '@/utils/tripFailure': failures, '@/utils/tripCandidates': candidates,
        '@/composables/useTripsState': loadModule(new URL('../../resources/js/composables/useTripsState.ts', import.meta.url), {
            vue: deps.vue ?? vue, '@/composables/useTripAnalysis': { useTripAnalysis: deps.useTripAnalysis },
            '@/utils/tripCandidates': candidates,
        }),
        '@/layouts/PlaceLayout.vue': deps.PlaceLayout, '@/components/TripPointPicker.vue': deps.TripPointPicker,
        '@/components/map/TripMap.vue': deps.TripMap,
    }
}
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
    for (const input of [null, {}, { ...selection, mode: 'walking' }, { ...selection, version: 2 },
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

function pageHarness(initial = '/trips', reply, dom = {}, realState = false) {
    const mounted = [], disposed = [], calls = [], handlers = new Map(), scope = vue.effectScope()
    const historyEntries = [initial]
    let index = 0
    const win = { location: new URL(initial, 'https://synthetic.invalid'), innerWidth: 1200,
        addEventListener(name, fn) { handlers.set(name, fn) }, removeEventListener(name) { handlers.delete(name) } }
    const navigate = url => { win.location = new URL(url, 'https://synthetic.invalid') }
    win.history = {
        pushState(_state, _title, url) { historyEntries.splice(++index); historyEntries.push(url); navigate(url) },
        replaceState(_state, _title, url) { historyEntries[index] = url; navigate(url) },
        go(delta) { index += delta; navigate(historyEntries[index]); handlers.get('popstate')?.(); handlers.get('hashchange')?.() },
    }
    const state = realState ? build(ref, shallowRef, fn => disposed.push(fn), (value, signal) => { calls.push(value); return reply(value, signal) })() : { analysis: shallowRef(null), status: ref('idle'), error: ref(''), clear(retained = null) { state.analysis.value = retained; state.status.value = 'idle'; state.error.value = '' }, analyze(value, retained = null) { calls.push(value); if (reply) { const response = reply(value); if (response?.then) { state.analysis.value = retained; state.status.value = 'loading'; return response.then(r => { state.analysis.value = r; state.status.value = 'ready'; return r }) } state.analysis.value = response; return Promise.resolve(response) } } }
    const deps = { ...vue, vue: { ...vue, onBeforeUnmount: fn => disposed.push(fn) }, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => disposed.push(fn), useTripAnalysis: () => state, ...utils, window: win,
        document: { title: '', querySelector: () => null, getElementById: () => ({ focus() {}, scrollIntoView() {} }), ...dom } }
    if (!realState) disposed.push(() => state.clear())
    const page = scope.run(() => loadSetup(new URL('../../resources/js/pages/TripsPage.vue', import.meta.url), ['submit', 'reset', 'returnToForm', 'draft', 'invalidLink', 'chooseRoad', 'mapChoice', 'choose', 'selection', 'candidateGroups', 'add', 'remove', 'activeRoad', 'announcement', 'rowCandidateGroups', 'highlightedCandidate', 'candidateFocus', 'pendingChoiceIndices', 'actionNotices', 'dismissActionNotice', 'openActionNotice', 'dirtyIndices', 'summaryTitle', 'resultEntries', 'nextStep', 'active', 'activePointReady', 'nextPoint', 'allPointsReady', 'saveDraftLink'], { ...pageDependencies(deps), vue: { ...vue, onMounted: deps.onMounted, onBeforeUnmount: deps.onBeforeUnmount } }, { window: win, document: deps.document }))
    mounted.forEach(fn => fn())
    return { page, win, calls, state, historyEntries, handlers, dispose() { disposed.forEach(fn => fn()); scope.stop() } }
}

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

test('page restores fragment on direct load/reload and back/forward without duplicate requests', () => {
    const first = utils.tripUrl(selection)
    const h = pageHarness(first)
    try {
        assert.deepEqual(h.calls, [selection])
        const reload = pageHarness(h.win.location.pathname + h.win.location.hash)
        assert.deepEqual(reload.calls, [selection]); reload.dispose()
        h.page.draft.places[0].label = 'Синтетическая замена'
        h.page.submit()
        assert.equal(h.win.location.search, '')
        assert.equal(h.historyEntries.length, 2)
        h.win.history.go(-1)
        assert.deepEqual(h.calls.at(-1), selection)
        assert.equal(h.calls.length, 3)
        h.win.history.go(1)
        assert.equal(h.calls.at(-1).places[0].label, 'Синтетическая замена')
        h.page.returnToForm()
        assert.ok(h.win.location.hash.startsWith('#trip='))
        h.page.reset()
        assert.equal(h.win.location.hash, '')
        h.win.history.go(-1)
        assert.equal(h.calls.at(-1).places[0].label, 'Синтетическая замена')
    } finally { h.dispose() }
})

test('old query links migrate in place; malformed and ambiguous links never calculate', () => {
    const old = '/trips?' + new URLSearchParams({ trip: JSON.stringify(selection) })
    const h = pageHarness(old)
    assert.equal(h.win.location.search, '')
    assert.ok(h.win.location.hash.startsWith('#trip='))
    assert.equal(h.historyEntries.length, 1)
    assert.deepEqual(h.calls, [selection]); h.dispose()
    for (const url of ['/trips?trip=invalid', '/trips#trip=invalid', old + utils.tripUrl(selection).slice(6), '/trips#trip={}&trip={}']) {
        const invalid = pageHarness(url)
        assert.equal(invalid.page.invalidLink.value, true)
        assert.equal(invalid.calls.length, 0)
        assert.equal(invalid.win.location.search, '')
        invalid.dispose()
    }
})

async function renderPage(value = null) {
    const deps = { ...utils,
        PlaceLayout: { inheritAttrs: false, props: ['document'], render() { return this.$slots.default() } }, TripMap: { render: () => null }, TripPointPicker: { render: () => null },
        useTripAnalysis: () => ({ analysis: shallowRef(value), status: ref('idle'), error: ref(''), clear() {}, analyze() {} }) }
    const component = loadComponent(new URL('../../resources/js/pages/TripsPage.vue', import.meta.url), pageDependencies(deps))
    const html = await ssr.renderToString(vue.createSSRApp(component))
    return html
}
test('rendered page warns the recipient can see coordinates and labels of every point', async () => {
    const html = await renderPage()
    assert.ok(html.includes('Получатель ссылки сможет увидеть координаты и подписи всех сохранённых точек.'))
    assert.ok(html.includes('истории этого браузера'))
})

test('trip fetch uses a fixed URL, no-store and no-referrer; selection travels only in POST body', async () => {
    let seen
    const { fetchTrips } = loadModule(new URL('../../resources/js/api/trips.ts', import.meta.url), {}, { fetch: async (url, options) => {
        seen = { url, options }; return { ok: true, json: async () => ({ results: [] }) }
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

test('manual road change keeps original point and survives reload/back/forward/reset', async () => {
    const h = pageHarness(utils.tripUrl(roadSelection))
    try {
        assert.deepEqual(h.calls[0], roadSelection)
        const next = { lon: .1236, lat: .2347 }
        h.page.chooseRoad('S', next)
        assert.deepEqual(h.calls.at(-1).start, { ...selection.start, road: next })
        assert.equal(h.win.location.search, '')
        const reloaded = pageHarness(h.win.location.pathname + h.win.location.hash)
        assert.deepEqual(reloaded.calls[0], h.calls.at(-1)); reloaded.dispose()
        h.win.history.go(-1); assert.deepEqual(h.calls.at(-1), roadSelection)
        h.win.history.go(1); assert.deepEqual(h.calls.at(-1).start.road, next)
        h.page.reset(); assert.equal(h.state.analysis.value, null)
        h.win.history.go(-1); assert.deepEqual(h.calls.at(-1).start.road, next)
        h.page.mapChoice('start'); h.page.choose({ lon: .2, lat: .3 })
        assert.equal(h.page.draft.start.road, undefined)
    } finally { h.dispose() }
})

test('automatic checked road choices are stored without erasing the result or original markers', async () => {
    const response = { results: [{ index: 0, road_choices: { start: { status: 'SELECTED', point: roadSelection.start.road }, target: { status: 'SELECTED', point: roadSelection.places[0].road } } }] }
    const h = pageHarness(utils.tripUrl(selection), () => response)
    try {
        await Promise.resolve()
        assert.deepEqual(h.state.analysis.value, response)
        assert.deepEqual(h.page.selection().start, roadSelection.start)
        assert.equal(h.historyEntries.length, 1)
        const saved = utils.parseTripLink(h.win.location.hash).selection
        assert.deepEqual(saved.start, roadSelection.start)
        assert.deepEqual(saved.places[0], roadSelection.places[0])
        h.page.draft.start.lon = .4
        assert.equal(h.state.analysis.value, null)
        assert.equal(h.page.draft.start.road, undefined)
    } finally { h.dispose() }
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

test('each available result labels secondary model time explicitly; refusals have no minutes', async () => {
    const html = await renderPage({ results: [accepted, { ...accepted, index: 1, status: 'UNKNOWN', route: null, snaps: null }], source: null, limitation: 'Synthetic' })
    assert.equal((html.match(/модельное время без актуальных пробок/g) || []).length, 1)
    assert.ok(html.includes('Парковка и подход не учтены.'))
    assert.ok(html.includes('Короткий подход между точками не включён в расстояние и время.'))
    assert.equal((html.match(/около 8 мин/g) || []).length, 1)
})

test('adding another place after a road edit selects a new original point, not another road hint', async () => {
    const h = pageHarness(utils.tripUrl(roadSelection))
    try {
        h.page.chooseRoad('S', { lon: .1235, lat: .2346 })
        assert.equal(h.page.activeRoad.value, true)
        await h.page.add()
        assert.equal(h.page.activeRoad.value, false)
        h.page.choose({ lon: .3, lat: .4 })
        assert.equal(Number(h.page.draft.places[2].lon), .3)
        assert.equal(h.page.draft.places[2].road, undefined)
    } finally { h.dispose() }
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

test('each rendered refusal has an expanded inline notice beside its successful sibling and codes only in details', async () => {
    for (const [row, title] of refusalCases) {
        const html = await renderPage({ results: [accepted, row], source: null, limitation: 'Synthetic' })
        const warning = html.match(/<div id="trip-failure-1"[^>]*class="trip-failure"[^>]*>([\s\S]*?)<\/div><\/div>/)?.[1]
        assert.ok(warning?.includes(title), title)
        assert.doesNotMatch(warning, /<details|RAW_TECHNICAL_REASON|SOURCE_|SNAP_|ROUTER_/)
        assert.ok(html.includes('aria-describedby="trip-failure-1"'))
        assert.ok(html.includes('role="status" aria-live="polite" aria-atomic="true"'))
        assert.ok(html.includes('data-status="AVAILABLE"'))
        assert.equal((html.match(/class="trip-values"/g) ?? []).length, 1)
        assert.ok(html.includes('<summary>Подробности проверки</summary>'))
        assert.doesNotMatch(html, /aria-modal|role="dialog"/)
        if (row.status === 'UNAVAILABLE') assert.ok(warning.includes('Повторить расчёт'))
    }
})

test('editing a point immediately removes an old refusal and announces the need for a new calculation', async () => {
    const response = { results: [refusal('UNKNOWN', ['SOURCE_NODE_ACCESS_UNKNOWN'])] }
    const h = pageHarness(utils.tripUrl(selection), () => response)
    try {
        await Promise.resolve()
        assert.ok(h.page.announcement.value.includes('Ограничение на участке маршрута'))
        h.page.draft.places[1].lon = .3
        assert.equal(h.state.analysis.value, null)
        assert.ok(h.page.announcement.value.includes('Прежние результаты этих поездок убраны'))
        assert.ok(!h.page.announcement.value.includes('Ограничение на участке маршрута'))
        h.page.submit()
        await Promise.resolve()
        assert.equal(h.state.analysis.value, response)
    } finally { h.dispose() }
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

test('ambiguous choices are a neutral waiting state with linked options inside the correct trip card', async () => {
    const html = await renderPage(choiceReply(selection))
    assert.ok(html.includes('Ожидает выбора дорожной точки'))
    assert.ok(html.includes('Маршрут пока не рассчитан: рядом несколько допустимых вариантов привязки'))
    assert.ok(html.includes('trip-choice-notice'))
    const second = html.slice(html.indexOf('data-status="NEEDS_REFINEMENT"'))
    assert.ok(second.includes('Дорожные варианты: Место 2, поездка 2'))
    assert.ok(second.includes('data-candidate-id="2-0"'))
    assert.ok(second.includes('data-candidate-id="2-1"'))
    assert.ok(second.includes('Вариант 1 — 11,1 м'))
    assert.ok(second.includes('Синтетическая &lt;улица&gt;'))
    assert.ok(!second.includes('Синтетическая <улица>'))
    assert.ok(!second.includes('Временная техническая ошибка'))
    assert.equal((html.match(/class="trip-values"/g) ?? []).length, 1)
})

test('list and map selection preserve the successful sibling while calculating and survive fragment history', async () => {
    let finish, delayed = false
    const h = pageHarness(utils.tripUrl(selection), value => delayed ? new Promise(resolve => { finish = () => resolve(choiceReply(value)) }) : choiceReply(value))
    try {
        await Promise.resolve()
        assert.equal(h.calls.length, 1)
        assert.equal(h.page.selection().places[1].road, undefined)
        assert.equal(h.page.candidateGroups.value.length, 1)
        delayed = true
        h.page.chooseRoad('2', alternatives[1].point)
        assert.equal(h.state.analysis.value.results[0], accepted)
        assert.equal(h.state.analysis.value.results[1].route, null)
        assert.deepEqual(h.page.pendingChoiceIndices.value, [1])
        assert.equal(h.win.location.search, '')
        assert.deepEqual(utils.parseTripLink(h.win.location.hash).selection.places[1].road, alternatives[1].point)
        finish()
        for (let i = 0; i < 3; i++) await Promise.resolve()
        assert.equal(h.state.analysis.value.results[1].status, 'AVAILABLE')
        assert.deepEqual(h.page.candidateGroups.value[0].selected, alternatives[1].point)
        assert.equal(h.page.candidateGroups.value[0].candidates.length, 2)
        delayed = false
        h.page.chooseRoad('2', alternatives[0].point)
        await Promise.resolve()
        h.win.history.go(-1)
        await Promise.resolve()
        assert.deepEqual(h.page.selection().places[1].road, alternatives[1].point)
        h.win.history.go(1)
        await Promise.resolve()
        assert.deepEqual(h.page.selection().places[1].road, alternatives[0].point)
        const reload = pageHarness(h.win.location.pathname + h.win.location.hash, choiceReply)
        await Promise.resolve()
        assert.deepEqual(reload.page.candidateGroups.value[0].selected, alternatives[0].point)
        reload.dispose()
        h.page.draft.places[1].lon = .3
        assert.equal(h.page.draft.places[1].road, undefined)
        assert.deepEqual(h.state.analysis.value.results, [accepted])
        assert.deepEqual(h.page.dirtyIndices.value, [1])
        assert.equal(h.page.candidateGroups.value.length, 0)
    } finally { h.dispose() }
})

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

test('summary includes every trip, accessible actions and full success as well as partial results', async () => {
    const html = await renderPage({ results: [accepted, waitingRow, { ...refusalCases[1][0], index: 2 }] })
    const summary = html.match(/<section class="trip-action-summary"[\s\S]*?<\/section>/)?.[0]
    assert.ok(summary?.includes('Рассчитано 1 из 3'))
    assert.ok(summary.includes('aria-labelledby="trip-action-summary-title"'))
    assert.ok(summary.includes('aria-describedby="trip-action-summary-item-1"'))
    assert.ok(summary.includes('aria-label="Выбрать вариант, место 2"'))
    assert.ok(summary.includes('aria-label="Проверить точки, место 3"'))
    assert.ok(summary.includes('aria-label="Скрыть уведомление"'))
    assert.equal((html.match(/class="trip-values"/g) ?? []).length, 1)
    assert.ok(html.includes('data-needs-choice="true"'))
    assert.ok(html.includes('id="trip-result-1" tabindex="-1"'))
    assert.doesNotMatch(html, /aria-modal|role="dialog"/)
    const success = await renderPage({ results: [accepted] })
    assert.ok(success.includes('class="trip-action-summary"'))
    assert.ok(success.includes('Рассчитано 1 из 1'))
    assert.ok(success.includes('aria-label="К результату, место 1"'))
})

test('closing preserves results; edits replace only the affected summary item and a new run reopens it', async () => {
    let finish, delayed = false
    const h = pageHarness(utils.tripUrl(selection), () => delayed ? new Promise(resolve => { finish = resolve }) : { results: [accepted, waitingRow] })
    try {
        await Promise.resolve()
        assert.equal(h.page.actionNotices.value.length, 2)
        const before = h.state.analysis.value
        await h.page.dismissActionNotice()
        assert.equal(h.page.actionNotices.value.length, 0)
        assert.equal(h.state.analysis.value, before)
        assert.equal(h.page.candidateGroups.value[0].candidates.length, 2)
        h.page.submit()
        await Promise.resolve()
        assert.equal(h.page.actionNotices.value.length, 2)
        h.page.draft.places[1].lon = .3
        assert.deepEqual(h.page.actionNotices.value.map(n => n.action), ['result', 'calculate'])
        assert.equal(h.page.summaryTitle.value, 'Рассчитано 1 из 2 · нужен пересчёт')
        delayed = true
        h.page.submit()
        assert.equal(h.page.actionNotices.value.length, 2)
        assert.deepEqual(h.state.analysis.value.results, [accepted])
        assert.equal(h.page.actionNotices.value[1].text, 'Место 2: проверяем путь')
        finish({ results: [accepted, { ...accepted, index: 1 }] })
        for (let i = 0; i < 3; i++) await Promise.resolve()
        assert.equal(h.page.summaryTitle.value, 'Рассчитано 2 из 2')
        assert.ok(h.page.actionNotices.value.every(n => n.action === 'result'))
    } finally { h.dispose() }
})

test('summary navigation focuses the card choice or action without calculating or selecting a candidate', async () => {
    const seen = []
    const target = { focus: options => seen.push(['focus', options]), scrollIntoView: options => seen.push(['target-scroll', options]) }
    const card = { querySelector: selector => { seen.push(['selector', selector]); return target }, scrollIntoView: options => seen.push(['card-scroll', options]) }
    const h = pageHarness(utils.tripUrl(selection), choiceReply, { getElementById: id => { seen.push(['card', id]); return card } })
    try {
        await Promise.resolve()
        for (const row of [waitingRow, refusalCases[0][0], refusalCases[4][0]]) await h.page.openActionNotice(utils.tripActionNotice(row))
        assert.deepEqual(seen.filter(c => c[0] === 'selector').map(c => c[1]), [
            '[data-needs-choice="true"] button[data-candidate-id]', '[data-trip-action="refine"]', '[data-trip-action="retry"]',
        ])
        assert.equal(seen.filter(c => c[0] === 'focus').length, 3)
        assert.ok(seen.filter(c => c[0] === 'card').every(c => c[1] === 'trip-result-1'))
        assert.equal(h.calls.length, 1)
        assert.equal(h.page.selection().places[1].road, undefined)
    } finally { h.dispose() }
})

test('editing one target drops only its route and candidate state, while editing start drops all routes', async () => {
    const h = pageHarness(utils.tripUrl(selection), choiceReply)
    try {
        await Promise.resolve()
        const route = h.state.analysis.value.results[0].route
        h.page.draft.places[1].lat = ''
        assert.equal(h.state.analysis.value.results.length, 1)
        assert.equal(h.state.analysis.value.results[0].route, route)
        assert.deepEqual(h.page.dirtyIndices.value, [1])
        assert.equal(h.page.candidateGroups.value.length, 0)
        const data = mapUtils.tripMapData([], h.state.analysis.value, h.page.candidateGroups.value)
        assert.equal(data.features.filter(f => f.properties.kind === 'route').length, 1)
        assert.ok(!data.features.some(f => f.properties.kind === 'candidate'))
        h.page.draft.start.lat = .9
        assert.equal(h.state.analysis.value, null)
        assert.deepEqual(h.page.dirtyIndices.value, [0, 1])
        assert.equal(h.page.summaryTitle.value, 'Рассчитано 0 из 2 · нужен пересчёт')
    } finally { h.dispose() }
})

test('renaming does not cancel or clear routes and the completed name round-trips through fragment history', async () => {
    const h = pageHarness(utils.tripUrl(selection), choiceReply)
    try {
        await Promise.resolve()
        const before = h.state.analysis.value
        h.page.draft.places[0].label = 'Новое синтетическое имя'
        assert.equal(h.state.analysis.value, before)
        assert.equal(h.calls.length, 1)
        assert.deepEqual(h.page.dirtyIndices.value, [])
        h.page.saveDraftLink()
        assert.equal(h.calls.length, 1)
        assert.equal(utils.parseTripLink(h.win.location.hash).selection.places[0].label, 'Новое синтетическое имя')
        h.win.history.go(-1)
        assert.equal(h.page.draft.places[0].label, selection.places[0].label)
        h.win.history.go(1)
        assert.equal(h.page.draft.places[0].label, 'Новое синтетическое имя')
    } finally { h.dispose() }
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

test('renaming during a request keeps the request alive and its current name in the saved link', async () => {
    let finish, requestSignal
    const h = pageHarness(utils.tripUrl(selection), (value, signal) => { requestSignal = signal; return new Promise(resolve => { finish = () => resolve(choiceReply(value)) }) }, {}, true)
    try {
        h.page.draft.places[0].label = 'Синтетическое новое имя'
        assert.equal(requestSignal.aborted, false)
        finish()
        for (let i = 0; i < 4; i++) await Promise.resolve()
        assert.equal(h.state.analysis.value.results[0].status, 'AVAILABLE')
        assert.equal(utils.parseTripLink(h.win.location.hash).selection.places[0].label, 'Синтетическое новое имя')
        assert.equal(h.page.draft.places[0].label, 'Синтетическое новое имя')
    } finally { h.dispose() }
})

test('a failed candidate request never becomes a successful empty route after another point changes', async () => {
    let fail = false
    const h = pageHarness(utils.tripUrl(selection), value => fail ? Promise.reject(new Error('Synthetic outage')) : Promise.resolve(choiceReply(value)), {}, true)
    try {
        for (let i = 0; i < 4; i++) await Promise.resolve()
        fail = true
        h.page.chooseRoad('2', alternatives[0].point)
        for (let i = 0; i < 4; i++) await Promise.resolve()
        assert.equal(h.state.status.value, 'error')
        assert.equal(h.page.actionNotices.value[1].action, 'retry')
        h.page.draft.places[0].lat = .9
        assert.equal(h.state.analysis.value, null)
        assert.equal(h.page.summaryTitle.value, 'Рассчитано 0 из 2 · нужен пересчёт')
        assert.deepEqual(h.page.dirtyIndices.value, [0, 1])
    } finally { h.dispose() }
})

test('repeated technical failures after a road edit never resurrect the old success or metrics', async () => {
    const metric = value => ({ value, quality: { method: 'DERIVED', availability: 'AVAILABLE' } })
    const changed = { ...accepted, index: 1, route: { ...accepted.route, distance_m: 735, duration_s: 913,
        geometry: { type: 'LineString', coordinates: [[.1235, .2346], [.125, .236]] } },
        metrics: { distance: metric(735), duration: metric(913) } }
    let fail = false
    const h = pageHarness(utils.tripUrl(selection), () => fail ? Promise.reject(new Error('Synthetic outage')) : Promise.resolve({ results: [accepted, changed] }), {}, true)
    const settled = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }
    const check = () => {
        assert.deepEqual(h.state.analysis.value.results, [accepted])
        assert.equal(h.page.resultEntries.value[1].row, null)
        assert.equal(h.page.summaryTitle.value, 'Рассчитано 1 из 2')
        assert.deepEqual(h.page.actionNotices.value.map(n => n.action), ['result', 'retry'])
        assert.doesNotMatch(h.page.announcement.value, /Поездка 2: путь рассчитан/)
        const routes = mapUtils.tripMapData([], h.state.analysis.value).features.filter(f => f.properties.kind === 'route')
        assert.equal(routes.length, 1)
        assert.deepEqual(routes[0].geometry, accepted.route.geometry)
    }
    try {
        await settled()
        assert.equal(h.page.summaryTitle.value, 'Рассчитано 2 из 2')
        fail = true
        h.page.chooseRoad('2', alternatives[0].point)
        await settled()
        assert.equal(h.state.status.value, 'error')
        check()
        for (let attempt = 0; attempt < 2; attempt++) {
            h.page.submit()
            assert.deepEqual(h.state.analysis.value.results, [accepted])
            await settled()
            assert.equal(h.state.status.value, 'error')
            check()
        }
    } finally { h.dispose() }
})

for (const key of ['1', 'S']) test(`road edit ${key} immediately discards dependent results even with an unfilled place`, async () => {
    const first = { ...accepted, metrics: { distance: { value: 100 }, duration: { value: 480 } } }
    const changed = { ...accepted, index: 1, route: { ...accepted.route, distance_m: 735, duration_s: 913,
        geometry: { type: 'LineString', coordinates: [[.1235, .2346], [.125, .236]] } },
        metrics: { distance: { value: 735 }, duration: { value: 913 } } }
    const pending = []
    let defer = false
    const h = pageHarness(utils.tripUrl(selection), (value, signal) => defer ? new Promise(resolve => pending.push({ signal, resolve })) : Promise.resolve({ results: [first, changed] }), {}, true)
    try {
        for (let i = 0; i < 4; i++) await Promise.resolve()
        await h.page.add()
        assert.equal(h.page.allPointsReady.value, false)
        const calls = h.calls.length
        h.page.chooseRoad(key, alternatives[0].point)
        assert.equal(h.calls.length, calls)
        const expected = key === 'S' ? [] : [changed]
        assert.deepEqual(h.state.analysis.value?.results ?? [], expected)
        assert.equal(h.page.resultEntries.value[0].row, null)
        assert.deepEqual(h.page.dirtyIndices.value, key === 'S' ? [0, 1, 2] : [0, 2])
        assert.equal(h.page.summaryTitle.value, `Рассчитано ${expected.length} из 3 · нужен пересчёт`)
        assert.equal(h.page.actionNotices.value[0].action, 'calculate')
        assert.doesNotMatch(h.page.announcement.value, /Поездка 1: путь рассчитан/)
        const routes = mapUtils.tripMapData([], h.state.analysis.value).features.filter(f => f.properties.kind === 'route')
        assert.equal(routes.length, expected.length)
        if (expected.length) assert.deepEqual(routes[0].geometry, changed.route.geometry)
        // A later calculation must not recover the discarded result from retained state.
        defer = true
        h.page.draft.places[2].lon = .126
        h.page.draft.places[2].lat = .237
        h.page.submit()
        assert.deepEqual(h.state.analysis.value?.results ?? [], expected)
        h.page.draft.places[2].lat = ''
        assert.equal(pending[0].signal.aborted, true)
        pending[0].resolve({ results: [first, changed] })
        for (let i = 0; i < 4; i++) await Promise.resolve()
        assert.deepEqual(h.state.analysis.value?.results ?? [], expected)
    } finally { h.dispose() }
})

test('mobile steps advance only on explicit action, keep coordinates and transfer keyboard focus to the map', async () => {
    let focusCount = 0
    const h = pageHarness('/trips', undefined, { querySelector: () => ({ focus() { focusCount++ } }) })
    h.win.innerWidth = 390
    try {
        await h.page.nextStep()
        assert.equal(h.page.active.value, 'start')
        h.page.choose(selection.start)
        assert.equal(h.page.active.value, 'start')
        assert.equal(h.page.activePointReady.value, true)
        assert.equal(h.calls.length, 0)
        await h.page.nextStep()
        assert.equal(h.page.active.value, 0)
        assert.equal(h.page.draft.places[0].lon, '')
        assert.equal(focusCount, 1)
        h.page.choose(selection.places[0])
        assert.equal(h.page.allPointsReady.value, true)
        await h.page.add(true)
        assert.equal(h.page.active.value, 1)
        assert.equal(h.page.activeRoad.value, false)
        assert.equal(h.page.draft.places[1].lon, '')
        await h.page.mapChoice('start')
        assert.deepEqual(h.page.selection(), null) // New blank target still needs a user's choice.
        assert.equal(Number(h.page.draft.start.lon), selection.start.lon)
        assert.equal(Number(h.page.draft.places[0].lon), selection.places[0].lon)
        assert.equal(h.calls.length, 0)
    } finally { h.dispose() }
})

test('all-refused summary preserves reasons and retry/choice actions without successful metrics', async () => {
    const html = await renderPage({ results: [{ ...refusalCases[0][0], index: 0 }, waitingRow, { ...refusalCases[4][0], index: 2 }] })
    const summary = html.match(/<section class="trip-action-summary"[\s\S]*?<\/section>/)?.[0]
    assert.ok(summary.includes('Рассчитано 0 из 3'))
    assert.ok(summary.includes('положение проблемы неизвестно'))
    assert.ok(summary.includes('вариантов: 2'))
    assert.ok(summary.includes('Повторить расчёт, место 3'))
    assert.equal((html.match(/class="trip-values"/g) ?? []).length, 0)
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

test('Goal 6 general technical retry cannot keep an earlier full success', async () => {
    let fail = false
    const h = pageHarness(utils.tripUrl(selection), () => fail ? Promise.reject(new Error('Synthetic outage')) : Promise.resolve({ results: [accepted, { ...accepted, index: 1 }] }), {}, true)
    try {
        for (let i = 0; i < 5; i++) await Promise.resolve()
        fail = true
        h.page.submit()
        for (let i = 0; i < 5; i++) await Promise.resolve()
        assert.deepEqual(h.state.analysis.value.results, [])
        assert.ok(h.page.actionNotices.value.every(notice => notice.action === 'retry'))
    } finally { h.dispose() }
})

for (const change of ['target', 'start', 'remove', 'reset', 'restore', 'new request', 'unmount']) {
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

test('page unmount removes history/resize handlers and cancels the connected real state', async () => {
    let finish, signal
    const h = pageHarness(utils.tripUrl(selection), (_value, active) => {
        signal = active
        return new Promise(resolve => { finish = resolve })
    }, {}, true)
    assert.deepEqual([...h.handlers.keys()].sort(), ['hashchange', 'popstate', 'resize'])
    h.dispose()
    assert.equal(signal.aborted, true)
    assert.equal(h.handlers.size, 0)
    finish({ results: [accepted, waitingRow] })
    await settleTrips()
    assert.equal(h.state.analysis.value, null)
    assert.equal(h.page.candidateGroups.value.length, 0)
    assert.equal(h.page.draft.start.road, undefined)
})
