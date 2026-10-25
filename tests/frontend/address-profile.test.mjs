import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, loadComponent } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'

const build = (ref, shallowRef, onBeforeUnmount, fetchAddressProfile) => loadModule(new URL('../../resources/js/composables/useAddressProfile.ts', import.meta.url), {
    vue: { ...vue, ref, shallowRef, onBeforeUnmount }, '@/api/profiles': { fetchAddressProfile },
}).useAddressProfile
function setup(api) {
    let cleanup
    const factory = build(vue.ref, vue.shallowRef, fn => { cleanup = fn }, api)
    return { state: factory('osm:way:1'), dispose() { cleanup() } }
}

test('profile radius changes clear old data and ignore late or disposed responses', async () => {
    const pending = []
    const { state, dispose } = setup((id, radius, signal) => new Promise(resolve => pending.push({ id, radius, signal, resolve })))
    const first = state.load()
    state.setRadius(300)
    assert.equal(pending[0].signal.aborted, true)
    assert.equal(pending[1].id, 'osm:way:1')
    assert.equal(pending[1].radius, 300)
    assert.equal(state.profile.value, null)
    pending[1].resolve({ address: { id: 'osm:way:1' }, radius_m: 300 })
    await Promise.resolve()
    pending[0].resolve({ radius_m: 500 })
    await first
    assert.equal(state.profile.value.radius_m, 300)
    state.setRadius(500)
    assert.equal(state.profile.value, null)
    dispose()
    assert.equal(pending[2].signal.aborted, true)
    pending[2].resolve({ radius_m: 500 })
    await Promise.resolve()
    assert.equal(state.profile.value, null)
})

test('unknown ID, unavailable address source and network failure remain distinct and retryable', async () => {
    let code = 404
    const { state, dispose } = setup(async () => {
        if (code) throw Object.assign(new Error('request failed'), { status: code })
        return { address: { id: 'osm:way:1' }, radius_m: 500 }
    })
    try {
        await state.load()
        assert.equal(state.status.value, 'not_found')
        code = 503; await state.load(); assert.equal(state.status.value, 'unavailable')
        code = 500; await state.load(); assert.equal(state.status.value, 'error')
        code = 0; await state.load(); assert.equal(state.status.value, 'ready')
    } finally { dispose() }
})

const display = loadModule(new URL('../../resources/js/utils/metricDisplay.ts', import.meta.url))
const metric = (value, availability = 'AVAILABLE', unit = '%') => ({ key: 'example', value, unit, source: 'OpenStreetMap', dataset_import_id: 1,
    observed_at: null, source_updated_at: '2026-10-18T20:25:06Z', calculated_at: '2026-10-19T18:00:00Z', quality: { method: value === null ? null : 'DERIVED', availability, freshness: 'UNKNOWN', reason: 'Ограничения источника.' } })
const card = loadComponent(new URL('../../resources/js/components/MetricCard.vue', import.meta.url), { '@/utils/metricDisplay': display })

test('metric card distinguishes zero, missing values and source dates, and exposes limits', async () => {
    const zero = await ssr.renderToString(vue.createSSRApp(card, { label: 'Территории по OSM', metric: metric(0) }))
    assert.match(zero, /0 %/)
    assert.match(zero, /наблюдение: неизвестна/)
    assert.match(zero, /18\.10\.2026/)
    assert.match(zero, /Это не дата наблюдения/)
    assert.match(zero, /Ограничения источника/)
    const missing = await ssr.renderToString(vue.createSSRApp(card, { label: 'Вода', metric: metric(null, 'INSUFFICIENT_DATA') }))
    assert.match(missing, /Недостаточно данных/)
    assert.doesNotMatch(missing, /0 %/)
    assert.equal(display.formatMetric(metric(0.001)), '<0,1 %')
    for (const value of [Number.MIN_VALUE, 0.000001, 0.049, 0.09999]) {
        const small = await ssr.renderToString(vue.createSSRApp(card, { label: 'Доля территории', metric: metric(value) }))
        assert.match(small, /&lt;0,1 %/)
        assert.doesNotMatch(small, />0 %</)
    }
    assert.equal(display.formatMetric(metric(0.1)), '0,1 %')
    assert.equal(display.formatMetric(metric(0.2, 'AVAILABLE', 'm')), '<1 м')
    assert.equal(display.profileUrl('osm:way:123', 300), '/address/osm%3Away%3A123?radius_m=300')
})
