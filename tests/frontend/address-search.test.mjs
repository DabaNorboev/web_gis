import * as vue from 'vue'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
import { ref, shallowRef, watch, effectScope } from 'vue'

const build = (ref, shallowRef, watch, onBeforeUnmount, searchAddresses) => loadModule(new URL('../../resources/js/composables/useAddressSearch.ts', import.meta.url), {
    vue: { ...vue, ref, shallowRef, watch, onBeforeUnmount }, '@/api/addresses': { searchAddresses },
}).useAddressSearch
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const address = { id: 'address:example', label: 'проспект Мира, 10', object_count: 2, bounds: [92.89,56.01,92.90,56.02], objects: [{id:'osm:way:1'}, {id:'osm:way:2'}] }
const response = (data) => ({ data, meta: { quality: { availability: 'AVAILABLE' } } })
function setup(api) {
    const scope = effectScope()
    let cleanup
    const factory = build(ref, shallowRef, watch, (fn) => { cleanup = fn }, api)
    const state = scope.run(factory)
    return { state, dispose() { cleanup(); scope.stop() } }
}

test('typing debounces requests and never selects the first response automatically', async () => {
    const calls = []
    const { state, dispose } = setup(async (query) => { calls.push(query); return response([address]) })
    try {
        state.query.value = 'Мир'
        await pause(80)
        state.query.value = 'Мира 10'
        assert.deepEqual(calls, [])
        await pause(340)
        assert.deepEqual(calls, ['Мира 10'])
        assert.equal(state.activeIndex.value, -1)
        assert.equal(state.query.value, 'Мира 10')
        assert.deepEqual(state.results.value, [address])
        state.choose(address)
        assert.equal(state.query.value, address.label)
        assert.equal(state.open.value, false)
        assert.deepEqual(state.results.value, [])
        await pause(320)
        assert.equal(calls.length, 1)
    } finally { dispose() }
})

test('late results cannot replace newer input, a newer response, or a cleared search', async () => {
    const pending = []
    const { state, dispose } = setup((query, signal) => new Promise(resolve => pending.push({ query, signal, resolve })))
    try {
        state.query.value = 'Старый адрес'
        const old = state.search()
        state.query.value = 'Новый адрес'
        assert.equal(pending[0].signal.aborted, true)
        const recent = state.search()
        pending[1].resolve(response([address]))
        await recent
        pending[0].resolve(response([{ ...address, label: 'Устаревший ответ' }]))
        await old
        assert.equal(state.results.value[0].label, address.label)
        state.query.value = 'Другой адрес'
        const last = state.search()
        state.clear()
        pending[2].resolve(response([address]))
        await last
        assert.equal(state.query.value, '')
        assert.deepEqual(state.results.value, [])
        assert.equal(state.open.value, false)
    } finally { dispose() }
})

test('errors can be retried, and Escape or disposal invalidates pending responses', async () => {
    let fail = true
    let resolvePending
    const { state, dispose } = setup(async () => {
        if (fail) throw new Error('offline')
        return new Promise(resolve => { resolvePending = resolve })
    })
    state.query.value = 'Мира 10'
    await state.search()
    assert.equal(state.status.value, 'error')
    fail = false
    const retry = state.search()
    state.close()
    resolvePending(response([address]))
    await retry
    assert.equal(state.open.value, false)
    assert.deepEqual(state.results.value, [])
    const last = state.search()
    dispose()
    resolvePending(response([address]))
    await last
    assert.deepEqual(state.results.value, [])
})
