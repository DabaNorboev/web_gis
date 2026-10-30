import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { loadModule, loadComponent } from './support/vue-component.mjs'

const path = name => new URL(`../../resources/js/${name}`, import.meta.url)
const tripUtils = loadModule(path('utils/trips.ts'))
const candidates = loadModule(path('utils/tripCandidates.ts'))
const personal = loadModule(path('utils/comparisonTrips.ts'), { '@/utils/trips': tripUtils })
const failures = loadModule(path('utils/tripFailure.ts'))
const mapUtils = loadModule(path('utils/tripMap.ts'), { '@/utils/tripCandidates': candidates })
// Invented points, no stored personal links or working routing runtime.
const a = { lon: 92.87, lat: 56.01 }, b = { lon: 92.89, lat: 56.02 }, goal = { lon: 92.91, lat: 56.03 }
const clone = value => JSON.parse(JSON.stringify(value))
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
function response(request, statuses = []) {
    const walking = request.mode === 'walking'
    const source = { name: 'Synthetic graph', engine: walking ? 'ORS' : 'OSRM', profile: walking ? 'foot-walking' : 'driving', dataset_version: 'synthetic-v1', observed_at: null, prepared_at: '2026-01-01', engine_version: 'test', pbf_sha256: 'synthetic' }
    return { mode: request.mode, ...(walking ? { route_scope: 'street_points' } : {}), start: request.start, source, limitation: 'Synthetic routing only.',
        results: request.places.map((place, index) => {
            const start = request.start.road ?? request.start, target = place.road ?? place, status = statuses[index] ?? 'AVAILABLE', available = status === 'AVAILABLE'
            const metric = (key, value) => ({ key, value, quality: { method: value === null ? null : 'synthetic' }, ...(walking ? { scope: 'street_points' } : {}) })
            const approach = point => ({ status: point.road ? 'UNKNOWN' : 'NOT_INCLUDED', original: point, selected_street: point.road ?? point, selection_shift_m: 123, distance_m: null, duration_s: null })
            return { index, label: place.label, start: request.start, target: place, status, reason: 'Synthetic reason', checks: [],
                diagnostics: { version: 1, issues: available ? [] : [{ code: 'NO_PATH', category: 'obstacle', stage: 'routing', location: 'route', target_index: index }] },
                ...(walking ? { route_scope: 'street_points', street_points: { start, target }, approaches: { start: approach(request.start), target: approach(place) }, selection_kind: 'DIFFERENT_STREET_POINTS', address_metrics: { distance: metric('distance', null), duration: metric('duration', null) } } : {}),
                route: available ? { geometry: { type: 'LineString', coordinates: [[start.lon, start.lat], [target.lon, target.lat]] }, distance_m: 1200 + index, duration_s: 300, ...(walking ? { scope: 'street_points' } : {}) } : null,
                snaps: available ? { start: { original: request.start, matched: start, distance_m: 0 }, target: { original: place, matched: target, distance_m: 0 } } : null,
                road_choices: null, metrics: { distance: metric('distance', available ? 1200 + index : null), duration: metric('duration', available ? 300 : null) },
            }
        }) }
}
function setup() {
    const scope = vue.effectScope(), cleanups = [], requests = [], saves = [], standaloneSaves = [], settled = []
    const hooks = { ...vue, onBeforeUnmount: fn => cleanups.push(fn) }
    const api = loadModule(path('api/trips.ts'), {}, { fetch: (_url, options) => new Promise((resolve, reject) => requests.push({ selection: JSON.parse(options.body), signal: options.signal, resolve, reject })) })
    const analysis = loadModule(path('composables/useTripAnalysis.ts'), { vue: hooks, '@/api/trips': api })
    const comparison = loadModule(path('composables/useComparisonTrips.ts'), { vue: hooks, '@/api/trips': api, '@/utils/trips': tripUtils })
    const state = loadModule(path('composables/useTripsState.ts'), { vue: hooks, '@/composables/useTripAnalysis': analysis, '@/utils/tripCandidates': candidates })
    const adapter = loadModule(path('composables/useHomeTrips.ts'), { vue: hooks, '@/composables/useComparisonTrips': comparison, '@/composables/useTripsState': state, '@/utils/trips': tripUtils, '@/utils/tripCandidates': candidates, '@/utils/tripMap': mapUtils })
    const sides = { left: vue.shallowReactive({ id: null, profile: null, knownAddress: null, status: 'empty' }), right: vue.shallowReactive({ id: null, profile: null, knownAddress: null, status: 'empty' }) }
    const context = vue.ref({ kind: 'profile', side: 'left' }), activeSide = vue.ref('left')
    const input = { sides, radius: vue.ref(500), activeSide, context,
        activate(value) { context.value = value; if (value.side) activeSide.value = value.side; else if (value.trip?.side) activeSide.value = value.trip.side },
        saveAddressTrips: (value, mode) => saves.push([clone(value), mode]),
        standaloneEffects: { saveSelection: (value, mode) => standaloneSaves.push([clone(value), mode]), beginRun: reveal => async current => { if (current()) settled.push(reveal) } },
    }
    const model = scope.run(() => adapter.useHomeTrips(input))
    const resolve = (request, statuses, edit = value => value) => request.resolve({ ok: true, json: async () => edit(response(request.selection, statuses)) })
    const setSide = (side, id, point = a) => { Object.assign(sides[side], { id, status: id ? 'ready' : 'empty', profile: id ? { address: { id, label: `Synthetic ${side}` }, point, radius_m: input.radius.value } : null }) }
    const addGoal = (point = goal) => { const id = model.addresses.add(); if (id && point) model.addresses.setPoint(id, point); return id }
    const independent = (count = 1) => {
        Object.assign(model.standalone.draft.start, a)
        for (let i = 1; i < count; i++) model.standalone.addPlace()
        model.standalone.draft.places.forEach((place, i) => Object.assign(place, { ...goal, lon: goal.lon + i * .01 }))
    }
    const WalkingTripDetails = loadComponent(path('components/WalkingTripDetails.vue'), { '@/utils/trips': tripUtils })
    const ComparisonTripData = loadComponent(path('components/ComparisonTripData.vue'), { '@/utils/trips': tripUtils, '@/components/WalkingTripDetails.vue': WalkingTripDetails })
    const HomeTripsEditor = loadComponent(path('components/home/HomeTripsEditor.vue'), { '@/components/TripPointPicker.vue': { render: () => null }, '@/composables/useHomeTrips': adapter })
    const HomeResultDialog = loadComponent(path('components/home/HomeResultDialog.vue'))
    const HomeTripCell = loadComponent(path('components/home/HomeTripCell.vue'), { '@/components/home/HomeResultDialog.vue': HomeResultDialog,
        '@/components/WalkingTripDetails.vue': WalkingTripDetails, '@/utils/comparisonTrips': personal, '@/utils/trips': tripUtils,
        '@/utils/tripFailure': failures, '@/utils/tripCandidates': candidates })
    const panelDeps = { '@/components/home/HomeTripCell.vue': HomeTripCell, '@/components/home/HomeTripsEditor.vue': HomeTripsEditor, '@/components/TripPointPicker.vue': { render: () => null }, '@/components/ComparisonTripData.vue': ComparisonTripData,
        '@/components/WalkingTripDetails.vue': WalkingTripDetails, '@/composables/useHomeTrips': adapter, '@/utils/comparisonTrips': personal,
        '@/utils/trips': tripUtils, '@/utils/tripFailure': failures, '@/utils/tripCandidates': candidates }
    return { model, input, context, sides, requests, saves, standaloneSaves, settled, adapter, resolve, setSide, addGoal, independent,
        render: () => renderToString(vue.createSSRApp(loadComponent(path('components/home/HomeTripsPanel.vue'), panelDeps), { model, input })),
        panel() { const component = loadComponent(path('components/home/HomeTripsPanel.vue'), panelDeps, { inlineTemplate: false }); return scope.run(() => component.setup({ model, input }, { expose() {}, emit() {} })) },
        async dispose() { cleanups.forEach(fn => fn()); scope.stop(); requests.forEach(request => resolve(request)); await tick() },
    }
}
const trip = (side, placeId) => ({ scenario: 'addresses', side, placeId })
const show = (h, value) => h.input.activate({ kind: 'trip', trip: value })
function choice(value, end, point) {
    const row = value.results[0]
    row.status = 'NEEDS_REFINEMENT'; row.route = null; row.snaps = null
    row.metrics.distance.value = null; row.metrics.duration.value = null
    row.road_choices = { start: { status: 'NONE' }, target: { status: 'NONE' }, [end]: { status: 'CHOOSE', candidates: [{ point, distance_m: 4, name: 'Synthetic street' }] } }
    row.diagnostics.issues = [{ code: 'SNAP_CHOICE_REQUIRED', category: 'ambiguity', stage: 'snap', location: end, target_index: 0 }]
    return value
}

test('one available address calculates without B; reload/radius retains its start and results, unavailable profile cannot calculate', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); const id = h.addGoal()
        assert.equal(h.requests.length, 0)
        const run = h.model.addresses.calculate(); assert.equal(h.requests.length, 1)
        assert.deepEqual(h.requests[0].selection.start, a)
        h.resolve(h.requests[0]); await run
        const row = h.model.addresses.cell('left', id).row
        h.input.radius.value = 300; h.sides.left.profile = null; h.sides.left.status = 'loading'
        assert.deepEqual(h.model.addresses.starts.left.point, a)
        assert.equal(h.model.addresses.cell('left', id).row, row)
        await h.model.addresses.calculate(); assert.equal(h.requests.length, 1)
        h.setSide('left', 'synthetic:a'); assert.equal(h.model.addresses.cell('left', id).row, row)
        h.setSide('right', 'synthetic:b', b); h.sides.right.status = 'unavailable'; h.sides.right.profile = null
        const again = h.model.addresses.calculate(); assert.equal(h.requests.length, 2)
        h.resolve(h.requests[1]); await again
        h.setSide('left', null); assert.equal(h.model.addresses.cell('left', id).row, null)
        assert.equal(h.model.addresses.starts.left.point, null)
    } finally { await h.dispose() }
})

test('three shared goals, independent failures and stable third-goal retry; no fourth goal or zero for an unknown', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); h.setSide('right', 'synthetic:b', b)
        const ids = [h.addGoal(), h.addGoal(b), h.addGoal(a)]
        assert.equal(h.model.addresses.add(), undefined)
        const run = h.model.addresses.calculate(); assert.equal(h.requests.length, 2)
        h.resolve(h.requests[0], ['AVAILABLE', 'NO_PATH']); h.requests[1].reject(Error('Synthetic failure')); await run
        assert.equal(h.model.addresses.cell('left', ids[0]).row.status, 'AVAILABLE')
        assert.equal(h.model.addresses.cell('left', ids[1]).row.metrics.distance.value, null)
        assert.equal(h.model.addresses.cell('right', ids[0]).status, 'error')
        const saved = h.model.addresses.cell('left', ids[0]).row
        const retry = h.model.addresses.calculate('right', ids[2]); assert.equal(h.requests[2].selection.places.length, 1)
        h.resolve(h.requests[2]); await retry
        show(h, trip('right', ids[2]))
        assert.equal(h.model.map.value.trip.placeId, ids[2]); assert.equal(h.model.addresses.cell('right', ids[2]).row.index, 0)
        assert.equal(h.model.map.value.overlay.data.features.filter(f => f.properties.kind === 'route').length, 1)
        h.model.addresses.places.value[0].label = '<Synthetic & label>'
        assert.equal(h.model.addresses.cell('left', ids[0]).row, saved)
        const html = await h.render()
        assert.match(html, /&lt;Synthetic &amp; label&gt;/); assert.match(html, /Повторить эту поездку/)
        assert.match(html, /Дата наблюдения: неизвестна/); assert.match(html, /Недостаточно подтверждённых/)
        assert.doesNotMatch(html, /0 мин|0 км/)
    } finally { await h.dispose() }
})

test('map contexts and display never fetch; manual streets preserve original objects and isolate side/goal', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); h.setSide('right', 'synthetic:b', b)
        const ids = [h.addGoal(), h.addGoal(b)], ref = trip('right', ids[1]), road = { lon: 92.89003, lat: 56.02 }
        h.input.activate({ kind: 'pick-street', trip: ref, end: 'start' })
        assert.equal(h.requests.length, 0)
        const context = clone(h.context.value)
        h.model.selectMap({ context: { ...context, end: 'target' }, point: road }); assert.equal(h.requests.length, 0)
        h.model.selectMap({ context, point: { lon: 181, lat: 56 } }); assert.equal(h.requests.length, 0)
        h.model.selectMap({ context, point: road }); assert.equal(h.requests.length, 1)
        assert.deepEqual(h.requests[0].selection.start, { ...b, road })
        assert.deepEqual(h.model.addresses.starts.right.point, b)
        assert.deepEqual(h.model.addresses.places.value[1].point, b)
        assert.equal(h.model.addresses.cell('left', ids[1]).hints.start, undefined)
        assert.equal(h.model.addresses.cell('right', ids[0]).hints.start, undefined)
        h.resolve(h.requests[0]); await tick()
        h.input.activate({ kind: 'profile', side: 'left' }); assert.equal(h.model.map.value, null)
        show(h, ref); h.input.radius.value = 300; assert.equal(h.requests.length, 1)
        h.model.addresses.setPoint(ids[1], goal)
        assert.equal(h.context.value.kind, 'profile'); assert.equal(h.model.map.value, null)
        h.model.selectMap({ context, point: a }); assert.equal(h.requests.length, 1)
    } finally { await h.dispose() }
})

test('candidate requires current context, overlay sequence and prepared point; second stale event cannot repeat', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); const id = h.addGoal(), ref = trip('left', id), road = { lon: 92.91003, lat: 56.03 }
        const run = h.model.addresses.calculate(); h.resolve(h.requests[0], [], value => choice(value, 'target', road)); await run
        show(h, ref); const context = clone(h.context.value), sequence = h.model.map.value.overlay.sequence
        const event = { context, sequence, end: 'target', point: road }
        h.model.selectMap({ ...event, sequence: sequence - 1 }); h.model.selectMap({ ...event, point: a })
        assert.equal(h.requests.length, 1)
        h.model.selectMap({ ...event, point: { ...road, lon: road.lon + 1e-8 }, context: { trip: { placeId: id, side: 'left', scenario: 'addresses' }, kind: 'trip' } }); assert.equal(h.requests.length, 2)
        h.model.selectMap(event); assert.equal(h.requests.length, 2)
        h.resolve(h.requests[1]); await tick()
        assert.deepEqual(h.model.addresses.cell('left', id).hints.target, road)
        assert.deepEqual(h.model.addresses.places.value[0].point, goal)
    } finally { await h.dispose() }
})

test('standalone stable IDs survive removal and map target key 1 maps to the retained goal, not request index', async () => {
    const h = setup()
    try {
        h.independent(3)
        const refs = [0, 1, 2].map(i => h.adapter.homeStandaloneTrip(h.model, i))
        h.model.standalone.submit(); h.resolve(h.requests[0], [], value => {
            choice({ results: [value.results[2]] }, 'target', a); return value
        }); await tick()
        h.model.standalone.removePlace(0)
        assert.deepEqual(h.adapter.homeStandaloneTrip(h.model, 1), refs[2])
        show(h, refs[2]); const overlay = h.model.map.value.overlay
        assert.equal(overlay.data.features.find(f => f.properties.kind === 'candidate').properties.key, '1')
        const otherRoad = clone(h.model.standalone.draft.places[0].road)
        h.model.selectMap({ context: clone(h.context.value), sequence: overlay.sequence, end: 'target', point: a })
        assert.equal(h.requests.length, 2)
        assert.deepEqual(h.requests[1].selection.places[0].road, otherRoad)
        assert.deepEqual(h.requests[1].selection.places[1].road, a)
        assert.equal(Number(h.model.standalone.draft.places[1].lon), goal.lon + .02)
        h.model.standalone.removePlace(1); assert.equal(h.model.map.value, null)
        assert.equal(h.context.value.kind, 'point')
        h.resolve(h.requests[1]); await tick()
        assert.equal(h.model.standalone.analysis.value.results.length, 1)
    } finally { await h.dispose() }
})

test('one mode aborts both owners and clears streets; late responses cannot write results, roads or standalone history', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); const id = h.addGoal(); h.independent()
        const run = h.model.addresses.calculate(); h.model.standalone.submit()
        assert.equal(h.requests.length, 2)
        h.model.addresses.setMode('walking')
        assert.equal(h.model.standalone.mode.value, 'walking'); assert.ok(h.requests.every(r => r.signal.aborted))
        const saves = h.standaloneSaves.length
        h.resolve(h.requests[0]); h.resolve(h.requests[1]); await run; await tick()
        assert.equal(h.model.addresses.cell('left', id).row, null); assert.equal(h.model.standalone.analysis.value, null)
        assert.equal(h.standaloneSaves.length, saves); assert.equal(h.settled.length, 0)
        h.model.standalone.setMode('driving'); assert.equal(h.model.addresses.mode.value, 'driving')
        assert.equal(h.requests.length, 2)
    } finally { await h.dispose() }
})

test('walking data keeps objects, streets and unknown approaches separate; no approach connector and failed cell is independent', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); const id = h.addGoal(), ref = trip('left', id)
        h.model.addresses.setMode('walking')
        h.model.addresses.setRoad('left', id, 'start', b); h.model.addresses.setRoad('left', id, 'target', a)
        const run = h.model.addresses.calculate(); h.resolve(h.requests[0]); await run
        show(h, ref)
        const features = h.model.map.value.overlay.data.features
        assert.equal(features.filter(f => f.properties.kind === 'connector').length, 0)
        assert.equal(features.filter(f => f.properties.kind === 'route').length, 1)
        assert.deepEqual(features.filter(f => f.properties.kind === 'original').map(f => f.geometry.coordinates), [[a.lon, a.lat], [goal.lon, goal.lat]])
        assert.deepEqual(features.filter(f => f.properties.kind === 'proposed').map(f => f.geometry.coordinates), [[b.lon, b.lat], [a.lon, a.lat]])
        const html = await h.render()
        assert.match(html, /Полный путь между исходными объектами неизвестен/)
        assert.match(html, /Расстояние и время подхода неизвестны/)
        assert.match(html, /Выбраны другие уличные точки/)
    } finally { await h.dispose() }
})

test('restores never merge drafts or echo address saves; standalone restore preserves explicit mode and rechecks via existing API', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); const id = h.addGoal(); h.independent(2)
        const before = clone(h.model.standalone.draft), link = clone(h.model.addresses.linkSelection.value), count = h.saves.length
        h.model.addresses.restore(link); assert.equal(h.saves.length, count)
        assert.deepEqual(clone(h.model.standalone.draft), before); assert.equal(h.requests.length, 0)
        h.model.standalone.restore({ version: 1, mode: 'walking', start: { ...b, road: a }, places: [{ ...a, label: 'Separate', road: goal }] })
        assert.equal(h.model.addresses.mode.value, 'walking'); assert.equal(h.saves.length, count)
        assert.equal(h.model.addresses.places.value[0].id, id)
        assert.deepEqual(h.model.addresses.places.value[0].point, goal)
        assert.equal(h.requests.length, 1); assert.equal(h.requests[0].selection.mode, 'walking')
        h.resolve(h.requests[0]); await tick()
        assert.equal(h.standaloneSaves.at(-1)[1], 'replace')
        h.model.addresses.reset(); assert.equal(h.model.standalone.draft.places[0].label, 'Separate')
    } finally { await h.dispose() }
})

test('real panel handlers keep drafts across scenarios, limit goals and retry only the requested standalone failure', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); const id = h.addGoal(); h.independent(2)
        const panel = h.panel(), savedDraft = clone(h.model.standalone.draft)
        panel.changeScenario('standalone'); panel.changeScenario('addresses')
        assert.equal(h.requests.length, 0); assert.deepEqual(clone(h.model.standalone.draft), savedDraft)
        assert.equal(h.model.addresses.places.value[0].id, id)
        h.model.standalone.submit(); h.resolve(h.requests[0]); await tick()
        const savedRow = h.model.standalone.analysis.value.results[0]
        panel.changeScenario('standalone'); panel.retry(h.adapter.homeStandaloneTrip(h.model, 1))
        h.requests[1].reject(Error('Synthetic failure')); await tick()
        assert.deepEqual(h.model.standalone.analysis.value.results, [savedRow])
        assert.deepEqual(h.model.standalone.failedChoiceIndices.value, [1])
        assert.deepEqual(h.model.standalone.draft.places[1].lon, savedDraft.places[1].lon)
        const ref = h.adapter.homeStandaloneTrip(h.model, 1)
        panel.pickGoal(ref); h.model.selectMap({ context: clone(h.context.value), point: b })
        assert.equal(h.requests.length, 2); assert.equal(h.model.standalone.draft.places[1].lon, String(b.lon))
        panel.changeMode({ target: { value: 'walking' } }); assert.equal(h.model.standalone.mode.value, 'walking')
        panel.changeMode({ target: { value: 'cycling' } }); assert.equal(h.model.addresses.mode.value, 'walking')
    } finally { await h.dispose() }
})

test('unmount aborts all transports and invalidates late standalone effects and address responses', async () => {
    const h = setup()
    h.setSide('left', 'synthetic:a'); const id = h.addGoal(); h.independent()
    const run = h.model.addresses.calculate(); h.model.standalone.submit()
    const count = h.standaloneSaves.length
    await h.dispose(); await run
    assert.ok(h.requests.every(r => r.signal.aborted))
    assert.equal(h.model.addresses.cells.left[id], undefined)
    assert.equal(h.model.standalone.analysis.value, null)
    assert.equal(h.standaloneSaves.length, count); assert.equal(h.settled.length, 0)
    const total = h.requests.length
    await h.model.addresses.calculate(); assert.equal(h.requests.length, total)
})

test('right-only works and replacing A during a batch rejects only old A, retaining the independent B response', async () => {
    const h = setup()
    try {
        h.setSide('right', 'synthetic:b', b); const id = h.addGoal()
        const one = h.model.addresses.calculate(); assert.equal(h.requests.length, 1)
        assert.deepEqual(h.requests[0].selection.start, b); h.resolve(h.requests[0]); await one
        h.setSide('left', 'synthetic:a')
        const batch = h.model.addresses.calculate()
        h.sides.left.id = 'synthetic:replacement'; h.sides.left.profile = null; h.sides.left.status = 'loading'
        h.resolve(h.requests[1]); h.resolve(h.requests[2]); await batch
        assert.equal(h.model.addresses.cell('left', id).row, null)
        assert.equal(h.model.addresses.cell('right', id).row.status, 'AVAILABLE')
        assert.equal(h.model.addresses.starts.left.point, null)
    } finally { await h.dispose() }
})

test('selection saves are batched, labels replace history and restore never echoes even after the Vue queue', async () => {
    const h = setup()
    try {
        const id = h.addGoal(); await tick()
        assert.equal(h.saves.length, 1); assert.equal(h.saves[0][1], 'push')
        h.model.addresses.places.value[0].label = 'Renamed'; await tick()
        assert.equal(h.saves.length, 2); assert.equal(h.saves[1][1], 'replace')
        assert.equal(h.requests.length, 0)
        const restored = clone(h.model.addresses.linkSelection.value); restored.places[0].label = 'Restored'
        h.model.addresses.restore(restored); await tick(); assert.equal(h.saves.length, 2)
        h.model.addresses.setPoint(id, b); await tick()
        assert.equal(h.saves.length, 3); assert.equal(h.saves[2][1], 'push')
        h.model.addresses.reset(); await tick()
        assert.deepEqual(h.saves.at(-1), [null, 'push'])
        assert.deepEqual(Object.keys(h.model.addresses.cells.left), [])
    } finally { await h.dispose() }
})

test('explicit standalone start/goal map selection does not adopt the address scenario; external context selects its panel', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); const id = h.addGoal(), panel = h.panel()
        const original = clone(h.model.addresses.linkSelection.value), ref = h.adapter.homeStandaloneTrip(h.model, 0)
        const startContext = { kind: 'pick-start', scenario: 'standalone' }
        h.input.activate(startContext); assert.equal(panel.scenario.value, 'standalone')
        h.model.selectMap({ context: startContext, point: b })
        assert.deepEqual(h.model.standalone.readPoint(h.model.standalone.draft.start), b)
        assert.equal(h.model.standalone.readPoint(h.model.standalone.draft.places[0]), null)
        const goalContext = { kind: 'pick-goal', scenario: 'standalone', placeId: ref.placeId }
        h.input.activate(goalContext); h.model.selectMap({ context: goalContext, point: a })
        assert.equal(h.requests.length, 0)
        assert.deepEqual(h.model.standalone.readPoint(h.model.standalone.draft.places[0]), a)
        assert.deepEqual(clone(h.model.addresses.linkSelection.value), original)
        show(h, trip('left', id)); assert.equal(panel.scenario.value, 'addresses')
        h.model.selectMap({ context: goalContext, point: goal })
        assert.deepEqual(h.model.standalone.readPoint(h.model.standalone.draft.places[0]), a)
    } finally { await h.dispose() }
})

test('walking candidates are fresh unselected choices, old context/sequence and a mode edit cannot choose them', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); const id = h.addGoal(), ref = trip('left', id)
        h.model.addresses.setMode('walking'); h.model.addresses.setRoad('left', id, 'target', a)
        const run = h.model.addresses.calculate(); h.resolve(h.requests[0], [], value => choice(value, 'target', a)); await run
        show(h, ref)
        const event = { context: clone(h.context.value), sequence: h.model.map.value.overlay.sequence, end: 'target', point: a }
        const panel = h.panel(); assert.equal(panel.entries.value[0].groups.find(group => group.end === 'target').selected, undefined)
        h.input.activate({ kind: 'profile', side: 'left' }); show(h, ref)
        h.model.selectMap(event); assert.equal(h.requests.length, 1)
        const context = { kind: 'pick-street', trip: ref, end: 'start' }
        h.input.activate(context); h.model.addresses.setMode('driving')
        assert.equal(h.context.value.kind, 'profile')
        h.model.selectMap({ context, point: b }); assert.equal(h.requests.length, 1)
        assert.deepEqual(h.model.addresses.cell('left', id).hints, {})
    } finally { await h.dispose() }
})


test('restoring an absent draft retains the global walking mode without invalidating the other scenario', async () => {
    const h = setup()
    try {
        h.setSide('left', 'synthetic:a'); const id = h.addGoal(); h.independent()
        h.model.addresses.setMode('walking')
        const run = h.model.addresses.calculate('left'); h.resolve(h.requests[0]); await run
        const row = h.model.addresses.cell('left', id).row
        h.model.standalone.restore(null, true)
        assert.equal(h.model.standalone.invalidLink.value, true)
        assert.equal(h.model.addresses.mode.value, 'walking')
        assert.equal(h.model.standalone.mode.value, 'walking')
        assert.equal(h.model.addresses.cell('left', id).row, row)
        h.independent(); h.model.standalone.submit(); h.resolve(h.requests[1]); await tick()
        const result = h.model.standalone.analysis.value
        h.model.addresses.restore(null)
        assert.equal(h.model.standalone.mode.value, 'walking')
        assert.equal(h.model.standalone.analysis.value, result)
        assert.equal(h.requests.length, 2)
    } finally { await h.dispose() }
})
