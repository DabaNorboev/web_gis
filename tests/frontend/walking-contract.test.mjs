import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { loadModule, loadComponent } from './support/vue-component.mjs'

const utils = loadModule(new URL('../../resources/js/utils/trips.ts', import.meta.url))
const candidates = loadModule(new URL('../../resources/js/utils/tripCandidates.ts', import.meta.url))
const map = loadModule(new URL('../../resources/js/utils/tripMap.ts', import.meta.url), { '@/utils/tripCandidates': candidates })
const failures = loadModule(new URL('../../resources/js/utils/tripFailure.ts', import.meta.url))
const selection = { version: 1, mode: 'walking', start: { lon: .12, lat: .23, road: { lon: .1203, lat: .23 } },
    places: [{ lon: .121, lat: .231, road: { lon: .1213, lat: .231 }, label: 'Синтетическая цель' }] }
const point = p => ({ lon: p.lon, lat: p.lat })
const metric = value => ({ value, scope: 'street_points', quality: { method: value === null ? null : 'DERIVED' } })
function response() {
    const start = point(selection.start), target = point(selection.places[0])
    const streets = { start: selection.start.road, target: selection.places[0].road }
    const approach = (original, selected_street) => ({ status: 'UNKNOWN', original, selected_street,
        selection_shift_m: 30, distance_m: null, duration_s: null })
    return { mode: 'walking', route_scope: 'street_points', start,
        source: { engine: 'ORS', profile: 'foot-walking' }, results: [{ index: 0, start, target,
            status: 'AVAILABLE', route_scope: 'street_points', street_points: streets,
            selection_kind: 'DIFFERENT_STREET_POINTS', approaches: { start: approach(start, streets.start), target: approach(target, streets.target) },
            address_metrics: { distance: metric(null), duration: metric(null) },
            metrics: { distance: metric(123), duration: metric(90) },
            route: { scope: 'street_points', distance_m: 123, duration_s: 90,
                geometry: { type: 'LineString', coordinates: [[streets.start.lon, streets.start.lat], [streets.target.lon, streets.target.lat]] } },
            snaps: { start: { original: streets.start, matched: streets.start }, target: { original: streets.target, matched: streets.target } },
            road_choices: null, checks: [] }] }
}
function api(json, record = () => {}) {
    return loadModule(new URL('../../resources/js/api/trips.ts', import.meta.url), {}, { fetch: async (url, options) => {
        record(url, options)
        return { ok: true, json: async () => typeof json === 'function' ? json() : json }
    } }).fetchTrips
}

test('walking HTTP contract retains explicit street inputs only in private POST body', async () => {
    const expected = response()
    const actual = await api(expected, (url, options) => {
        assert.equal(url, '/api/v1/trips/analyze')
        assert.equal(options.cache, 'no-store'); assert.equal(options.referrerPolicy, 'no-referrer')
        assert.deepEqual(JSON.parse(options.body), { mode: 'walking', start: selection.start, places: selection.places })
    })(selection, new AbortController().signal)
    assert.deepEqual(actual, expected)
})

test('cross-mode, wrong object, wrong street or missing street scope never enter walking state', async () => {
    const mutations = [
        r => { r.mode = 'driving' }, r => { r.start.lon += .01 }, r => { r.results[0].target.lat += .01 },
        r => { r.results[0].street_points.target.lon += .01 }, r => { delete r.route_scope },
        r => { delete r.results[0].route_scope }, r => { delete r.results[0].route.scope },
        r => { r.results[0].metrics.distance.scope = 'objects' }, r => { r.source.engine = 'OSRM' },
        r => { r.results.push(structuredClone(r.results[0])) },
    ]
    for (const mutate of mutations) {
        const value = structuredClone(response()); mutate(value)
        await assert.rejects(api(value)(selection, new AbortController().signal), /Ответ не соответствует/)
    }
})

test('fabricated approach or complete-object metrics cannot become accepted walking output', async () => {
    for (const mutate of [
        r => { r.results[0].address_metrics.duration.value = 0 },
        r => { r.results[0].address_metrics.distance.quality.method = 'DERIVED' },
        r => { r.results[0].approaches.start.distance_m = 0 },
        r => { r.results[0].approaches.target.duration_s = 10 },
        r => { r.results[0].approaches.start.status = 'NOT_INCLUDED' },
    ]) {
        const value = structuredClone(response()); mutate(value)
        await assert.rejects(api(value)(selection, new AbortController().signal), /Ответ не соответствует/)
    }
})

test('walking failure retains null measures and malformed JSON never exposes response text', async () => {
    const value = response(), row = value.results[0]
    Object.assign(row, { status: 'UNKNOWN', route: null, snaps: null, metrics: { distance: metric(null), duration: metric(null) } })
    assert.equal((await api(value)(selection, new AbortController().signal)).results[0].metrics.duration.value, null)
    row.metrics.duration.value = 0
    await assert.rejects(api(value)(selection, new AbortController().signal), /Ответ не соответствует/)
    await assert.rejects(api(() => { throw new SyntaxError('SYNTHETIC_PRIVATE_RESPONSE') })(selection, new AbortController().signal), error => {
        assert.equal(error.message.includes('SYNTHETIC_PRIVATE_RESPONSE'), false); return true
    })
})

test('walking map separates objects, selected streets and checked endpoints without inventing approaches', () => {
    const result = response()
    const points = [{ key: 'S', point: point(selection.start), road: selection.start.road }, { key: '1', point: point(selection.places[0]), road: selection.places[0].road }]
    const before = structuredClone({ points, result })
    const data = map.tripMapData(points, result)
    const features = kind => data.features.filter(f => f.properties.kind === kind)
    assert.deepEqual(features('original').map(f => f.geometry.coordinates), [[.12, .23], [.121, .231]])
    assert.deepEqual(features('proposed').map(f => f.geometry.coordinates), [[.1203, .23], [.1213, .231]])
    assert.equal(features('matched').length, 2); assert.equal(features('route').length, 1)
    assert.equal(features('connector').length, 0)
    assert.deepEqual({ points, result }, before)
    const pending = map.tripMapData(points, null, [], 'walking')
    assert.equal(pending.features.filter(f => f.properties.role === 'selected_street').length, 2)
    assert.equal(pending.features.filter(f => f.geometry.type === 'LineString').length, 0)
    delete result.results[0].route.scope
    assert.equal(map.tripMapData(points, result).features.filter(f => f.properties.kind === 'route').length, 0)
})

test('walking diagnostics use the pedestrian limit and access wording', () => {
    const row = response().results[0]
    row.status = 'NEEDS_REFINEMENT'; row.route = null
    row.diagnostics = { version: 1, issues: [
        { code: 'SNAP_LIMIT_EXCEEDED', category: 'distance', location: 'start', target_index: null },
        { code: 'FOOT_ACCESS_UNKNOWN', category: 'access', location: 'start', target_index: null },
    ] }
    const text = failures.tripFailureMessage(row).description
    assert.match(text, /20 м/); assert.match(text, /пешем/); assert.doesNotMatch(text, /35 м|автомобильном|проезд/)
})

test('walking details keep unknown metrics distinct from a genuine zero selection shift', async () => {
    const component = loadComponent(new URL('../../resources/js/components/WalkingTripDetails.vue', import.meta.url), { '@/utils/trips': utils })
    const row = response().results[0]
    row.metrics.distance.value = null; row.metrics.duration.value = null; row.approaches.start.selection_shift_m = 0
    const html = await renderToString(vue.createSSRApp(component, { row }))
    assert.match(html, /Расстояние неизвестно/); assert.match(html, /Время неизвестно/)
    assert.match(html, /Геометрическое смещение объекта к улице: 0 м/)
    assert.match(html, /Полный путь между исходными объектами неизвестен/)
})
