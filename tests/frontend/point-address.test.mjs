import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import { evaluateModule, loadComponent } from './support/vue-component.mjs'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const response = (match, ids = ['osm:way:1']) => ({ data: { match, requires_choice: ids.length > 1, candidates: ids.map(id => ({ id, label: 'Тестовая, 10', object_type: 'building', geometry_type: 'POLYGON', distance_m: match === 'CONTAINING' ? 0 : 25 })) }, meta: { source: 'OpenStreetMap', dataset_import_id: 3, observed_at: null, source_updated_at: null, quality: { availability: 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Ограничения' }, coverage: { status: 'UNKNOWN', reason: 'Покрытие неизвестно' } } })
const tick = async () => { await Promise.resolve(); await Promise.resolve() }
function setup(fetch) {
    let dispose
    const point = vue.ref(null), scope = vue.effectScope()
    const hooks = { ...vue, onBeforeUnmount: fn => { dispose = fn } }
    const { usePointAddress } = evaluateModule(source('../../resources/js/composables/usePointAddress.ts'), { vue: hooks, '@/api/pointAddress': { resolvePointAddress: fetch } })
    const state = scope.run(() => usePointAddress(point))
    return { point, state, dispose: () => { dispose(); scope.stop() } }
}

test('point label choice preserves coordinates and does not request again for the same point', async () => {
    let calls = 0
    const { point, state, dispose } = setup(async () => { calls++; return response('CONTAINING', ['osm:way:1', 'osm:way:2']) })
    try {
        assert.equal(state.status.value, 'idle')
        const original = { lon: 92.90000012345678, lat: 56.00000012345678 }
        point.value = original
        assert.equal(state.status.value, 'loading')
        await tick()
        assert.equal(state.selected.value, null)
        state.choose('osm:way:2')
        assert.equal(state.selected.value.id, 'osm:way:2')
        state.choose('missing')
        assert.equal(state.selected.value.id, 'osm:way:2')
        assert.deepEqual(point.value, original)
        point.value = { ...original }
        assert.equal(calls, 1)
        point.value = null
        assert.equal(state.result.value, null)
        assert.equal(state.selected.value, null)
        assert.equal(state.status.value, 'idle')
    } finally { dispose() }
})
test('late responses cannot label a changed or cleared point even if abort has no effect', async () => {
    const pending = []
    const { point, state, dispose } = setup((coordinates, signal) => new Promise(resolve => pending.push({ coordinates, signal, resolve })))
    try {
        point.value = { lon: 0, lat: 0 }
        point.value = { lon: 1, lat: 1 }
        assert.equal(pending[0].signal.aborted, true)
        pending[1].resolve(response('NEARBY', ['osm:node:2']))
        await tick()
        pending[0].resolve(response('CONTAINING'))
        await tick()
        assert.equal(state.selected.value.id, 'osm:node:2')
        assert.deepEqual(point.value, { lon: 1, lat: 1 })
        point.value = { lon: 2, lat: 2 }
        point.value = null
        pending[2].resolve(response('CONTAINING'))
        await tick()
        assert.equal(state.result.value, null)
        assert.equal(state.status.value, 'idle')
    } finally { dispose() }
})
test('retry resolves the current point after failure; no result retains the point', async () => {
    let fail = true
    const { point, state, dispose } = setup(async () => { if (fail) throw Error('offline'); return response('NONE', []) })
    try {
        point.value = { lon: 0, lat: 0 }
        await tick()
        assert.equal(state.status.value, 'error')
        assert.deepEqual(point.value, { lon: 0, lat: 0 })
        fail = false
        await state.retry()
        assert.equal(state.status.value, 'ready')
        assert.equal(state.selected.value, null)
        assert.deepEqual(point.value, { lon: 0, lat: 0 })
    } finally { dispose() }
})
test('unmount invalidates the pending response and aborts its request', async () => {
    let finish, signal
    const { point, state, dispose } = setup((_, s) => { signal = s; return new Promise(resolve => { finish = resolve }) })
    point.value = { lon: 0, lat: 0 }
    dispose()
    assert.equal(signal.aborted, true)
    finish(response('CONTAINING'))
    await tick()
    assert.equal(state.result.value, null)
})
test('label API sends precise coordinates only in local POST JSON with no-store and no-referrer', async () => {
    const calls = [], previous = globalThis.fetch
    globalThis.fetch = async (...args) => { calls.push(args); return { ok: true, json: async () => response('NONE', []) } }
    try {
        const { resolvePointAddress } = evaluateModule(source('../../resources/js/api/pointAddress.ts'))
        const point = { lon: 92.90000012345678, lat: 56.00000012345678 }
        await resolvePointAddress(point, new AbortController().signal)
        assert.equal(calls[0][0], '/api/v1/addresses/resolve-point')
        const init = calls[0][1]
        assert.equal(init.method, 'POST'); assert.equal(init.cache, 'no-store'); assert.equal(init.referrerPolicy, 'no-referrer')
        assert.deepEqual(JSON.parse(init.body), point)
    } finally { globalThis.fetch = previous }
})
test('real label component distinguishes containment, proximity, ambiguity, no data, loading and failure', async () => {
    async function render(data, status = 'ready') {
        const state = { result: vue.ref(data), status: vue.ref(status), selectedId: vue.ref(null), selected: vue.ref(data && !data.data.requires_choice ? data.data.candidates[0] ?? null : null), choose() {}, retry() {} }
        const component = loadComponent(new URL('../../resources/js/components/PointAddressLabel.vue', import.meta.url), { '@/composables/usePointAddress': { usePointAddress: () => state } })
        return renderToString(vue.createSSRApp(component, { point: { lon: 0, lat: 0 } }))
    }
    assert.match(await render(response('CONTAINING')), /Внутри или на границе/)
    const near = await render(response('NEARBY'))
    assert.match(near, /Рядом с Тестовая, 10/); assert.match(near, /25 м по прямой/); assert.doesNotMatch(near, /href=/)
    const ambiguous = await render(response('CONTAINING', ['osm:way:1', 'osm:way:2']))
    assert.match(ambiguous, /Выберите подпись/); assert.equal((ambiguous.match(/type="radio"/g) ?? []).length, 2)
    assert.doesNotMatch(ambiguous, / checked/)
    assert.match(await render(response('NONE', [])), /Точка анализа/)
    assert.match(await render(null, 'error'), /Повторить определение адреса/)
    assert.match(await render(null, 'loading'), /Определяем адрес/)
    const unavailable = response('NONE', []); unavailable.meta.quality.availability = 'UNAVAILABLE'
    assert.match(await render(unavailable), /Адресные данные недоступны/)
    assert.match(await render(unavailable), /Повторить определение адреса/)
})
