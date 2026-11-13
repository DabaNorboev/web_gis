import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadModule } from './support/vue-component.mjs'

import { pointReference } from './fixtures/point-address-reference.mjs'

const labelApi = new URL('../../resources/js/composables/usePointAddress.ts', import.meta.url)
const hookUrl = new URL('../../resources/js/composables/useAnalysisPointAddress.ts', import.meta.url)
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
function setup() {
    const lookups = [], resolutions = [], selections = [], cleanups = []
    const hooks = { ...vue, onBeforeUnmount: fn => cleanups.push(fn) }
    const lookup = loadModule(labelApi, { vue: hooks, '@/api/pointAddress': { resolvePointAddress: (point, signal) => new Promise((resolve, reject) => lookups.push({ point, signal, resolve, reject })) } })
    const factory = loadModule(hookUrl, { vue: hooks, '@/composables/usePointAddress': lookup,
        '@/api/searchProfiles': { resolveAddress: (id, signal) => new Promise((resolve, reject) => resolutions.push({ id, signal, resolve, reject })) } }).useAnalysisPointAddress
    const point = vue.ref(null), scope = vue.effectScope()
    const state = scope.run(() => factory(point, address => selections.push(address)))
    return { point, state, lookups, resolutions, selections, dispose() { cleanups.forEach(fn => fn()); scope.stop() } }
}
test('reference lookup and explicit address resolution never mutate the precise chosen coordinates', async () => {
    const h = setup()
    const original = { lon: .123456789012345, lat: .234567890123456 }
    h.point.value = original; h.lookups[0].resolve(pointReference()); await tick()
    assert.deepEqual(h.point.value, original); assert.equal(h.selections.length, 0)
    assert.equal(h.state.candidates.value[0].distance_m, 25)
    const transition = h.state.analyzeAddress('osm:way:1')
    assert.equal(h.resolutions[0].id, 'osm:way:1'); assert.deepEqual(h.point.value, original)
    const address = { id: 'osm:way:1', label: 'Synthetic resolved address', object: { lon: .4, lat: .5 } }
    h.resolutions[0].resolve({ address }); await transition
    assert.deepEqual(h.selections, [address]); assert.deepEqual(h.point.value, original); h.dispose()
})
test('no match, outside coverage, malformed distance and lookup failure have no transition candidate', async () => {
    for (const mutate of [() => pointReference('NONE'), () => { const r = pointReference(); r.meta.coverage.status = 'OUTSIDE_SERVICE_AREA'; return r },
        () => { const r = pointReference(); r.data.candidates[0].distance_m = null; return r },
        () => { const r = pointReference(); r.data.candidates[0].distance_m = 101; return r }]) {
        const h = setup(); h.point.value = { lon: 0, lat: 0 }; h.lookups[0].resolve(mutate()); await tick()
        assert.deepEqual(h.state.candidates.value, []); await h.state.analyzeAddress('osm:way:1')
        assert.equal(h.resolutions.length, 0); assert.deepEqual(h.point.value, { lon: 0, lat: 0 }); h.dispose()
    }
    const h = setup(); h.point.value = { lon: 0, lat: 0 }; h.lookups[0].reject(Error('PRIVATE_CANARY')); await tick()
    assert.equal(h.state.status.value, 'error'); assert.deepEqual(h.state.candidates.value, []); h.dispose()
})
test('late lookup and late resolver cannot attach an old address to a changed point, including A-B-A', async () => {
    const h = setup(); const a = { lon: 0, lat: 0 }
    h.point.value = a; h.point.value = { lon: 1, lat: 1 }
    h.lookups[1].resolve(pointReference('NEARBY', ['osm:node:2'])); await tick()
    h.lookups[0].resolve(pointReference()); await tick()
    assert.equal(h.state.candidates.value[0].id, 'osm:node:2')
    const old = h.state.analyzeAddress('osm:node:2')
    h.point.value = a
    assert.equal(h.resolutions[0].signal.aborted, true)
    h.resolutions[0].resolve({ address: { id: 'osm:node:2' } }); await old
    assert.equal(h.selections.length, 0); assert.equal(h.state.transitionPending.value, false)
    h.lookups[2].resolve(pointReference()); await tick()
    const pending = h.state.analyzeAddress('osm:way:1'); h.dispose()
    h.resolutions[1].resolve({ address: { id: 'osm:way:1' } }); await pending
    assert.equal(h.selections.length, 0)
})
test('resolver failure preserves point and label; ties remain separate explicit choices', async () => {
    const h = setup(); h.point.value = { lon: 0, lat: 0 }
    h.lookups[0].resolve(pointReference('NEARBY', ['osm:way:1', 'osm:way:2'])); await tick()
    assert.equal(h.state.candidates.value.length, 2)
    const action = h.state.analyzeAddress('osm:way:2'); h.resolutions[0].reject(Error('PRIVATE_CANARY')); await action
    assert.equal(h.state.transitionError.value, true); assert.equal(h.state.candidates.value.length, 2)
    assert.deepEqual(h.point.value, { lon: 0, lat: 0 }); assert.equal(h.selections.length, 0); h.dispose()
})
