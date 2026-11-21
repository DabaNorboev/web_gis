import { geocodingModule } from './support/geocoding.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadModule } from './support/vue-component.mjs'
import { input, responseFor, normalized } from './fixtures/place-analysis.mjs'
const errors = loadModule(new URL('../../resources/js/api/errors.ts', import.meta.url))
const api = loadModule(new URL('../../resources/js/api/placeAnalysis.ts', import.meta.url), { './errors': errors, './geocoding': geocodingModule(errors) })
function setup(timeoutMs = 1000) {
    const pending = []; let cleanup
    const { usePlaceAnalysis } = loadModule(new URL('../../resources/js/composables/usePlaceAnalysis.ts', import.meta.url), {
        vue: { ...vue, onBeforeUnmount: fn => { cleanup = fn } }, '@/api/errors': errors,
        '@/api/placeAnalysis': { ...api, fetchPlaceAnalysis: (request, signal) => new Promise((resolve, reject) => pending.push({ request, signal, resolve, reject })) },
    })
    const state = usePlaceAnalysis({ timeoutMs }); state.setInput(input)
    return { state, pending, cleanup: () => cleanup() }
}
const finish = (p, statuses = {}) => p.resolve(responseFor(p.request, statuses))
test('independent delivery and retry do not wait for or reset other blocks', async () => {
    const { state, pending, cleanup } = setup()
    const all = state.loadAll()
    finish(pending[0], { poi: 'READY' }); await Promise.resolve(); await Promise.resolve()
    assert.equal(state.blocks.poi.phase, 'ready'); assert.equal(state.blocks.air.phase, 'loading')
    pending[2].reject(new errors.ApiRequestError('http', 503)); finish(pending[1]); await all
    assert.equal(state.blocks.air.phase, 'error'); assert.equal(state.blocks.satellite.phase, 'unavailable')
    const before = state.blocks.poi.response; const retry = state.load('air'); assert.equal(pending.length, 4)
    finish(pending[3]); await retry
    assert.equal(state.blocks.poi.response, before); assert.equal(state.blocks.air.phase, 'unavailable'); cleanup()
})
test('date preserves pending POI/air and old request echo, selection invalidates only air, radius invalidates all', async () => {
    const { state, pending, cleanup } = setup()
    const all = state.loadAll()
    state.setInput({ ...input, date: '2024-01-01' })
    assert.equal(pending[0].signal.aborted, false); assert.equal(pending[1].signal.aborted, true); assert.equal(pending[2].signal.aborted, false)
    pending.forEach(p => finish(p, { poi: 'READY' })); await all
    assert.equal(state.blocks.poi.phase, 'ready'); assert.equal(state.blocks.air.phase, 'unavailable'); assert.equal(state.blocks.satellite.phase, 'idle')
    state.setInput({ ...input, date: '2024-01-01', stations: { selected_ids: ['x'], radius_m: 1000 } })
    assert.equal(state.blocks.poi.phase, 'ready'); assert.equal(state.blocks.air.phase, 'idle')
    state.setInput({ ...input, radius_m: 1000 }); assert.equal(state.map.value, null)
    for (const block of Object.values(state.blocks)) assert.equal(block.phase, 'idle')
    cleanup()
})
test('place A-B-A and unmount reject late response, error and finally', async () => {
    const { state, pending, cleanup } = setup()
    const old = state.loadAll()
    state.setInput({ place: { kind: 'point', lon: .13, lat: .23 } }); state.setInput(input)
    const current = state.load('poi'); assert.equal(pending[0].signal.aborted, true)
    finish(pending[0], { poi: 'READY' }); pending[1].reject(new Error('private')); finish(pending[2]); await old
    assert.equal(state.blocks.poi.phase, 'loading'); assert.equal(state.blocks.satellite.phase, 'idle'); assert.equal(state.map.value, null)
    cleanup(); finish(pending[3], { poi: 'READY' }); await current
    assert.equal(state.blocks.poi.phase, 'idle'); assert.equal(state.map.value, null)
})
test('timeout is bounded even if fetch ignores abort, late success cannot overwrite retry', async () => {
    const { state, pending, cleanup } = setup(10)
    await state.load('air'); assert.equal(state.blocks.air.error.kind, 'timeout'); assert.equal(pending[0].signal.aborted, true)
    const retry = state.load('air'); finish(pending[1]); await retry
    finish(pending[0], { air: 'READY' }); await Promise.resolve()
    assert.equal(state.blocks.air.phase, 'unavailable'); cleanup()
})
test('changed resolver origin invalidates all dependent results until explicit update', async () => {
    const { state, pending, cleanup } = setup(); state.setInput({ place: { kind: 'address', address_id: 'osm:node:1' } })
    const all = state.loadAll(); finish(pending[0], { poi: 'READY' }); await Promise.resolve(); await Promise.resolve()
    const changed = responseFor(pending[1].request); changed.place.point.lon += .01; pending[1].resolve(changed)
    finish(pending[2]); await all
    assert.equal(state.blocks.poi.phase, 'idle'); assert.equal(state.blocks.satellite.error.code, 'ADDRESS_POINT_CHANGED'); assert.equal(state.map.value, null)
    cleanup()
})
test('renewed authorization preserves ready blocks and rejects late replies from the old token', async () => {
    const { state, pending, cleanup } = setup()
    const c = { kind: 'address', selection_id: '12345678-1234-4234-8234-123456789012', label: 'Synthetic', point: { lon: .4, lat: .5 }, building: null,
        address: { provider_id: 'fixture', components: { country_code: 'ru', locality: null, street: 'Synthetic', number: { raw: '10', key: '10', base: '10', fraction: null, letter: null, corpus: null, structure: null, parse_status: 'COMPLETE' } },
            precision: { level: 'house', reason: null, accuracy_m: null, accuracy_reason: 'NOT_VALIDATED' }, number_match: 'EXACT',
            source: { provider: 'geoapify', provider_result_type: 'building', observed_at: null, source_updated_at: null, received_at: '2026-11-15T00:00:00Z', normalization_version: 1,
                attribution: [{ text: 'Powered by Geoapify', url: 'https://www.geoapify.com/' }] }, scope_id: 'scope', scope_sha256: 'a'.repeat(64) } }
    const external = token => ({ analysis_version: 2, place: { kind: 'address', selection_token: token }, expected_place: c })
    const reply = p => ({ ...responseFor({ ...p.request, place: { kind: 'point', ...c.point } }), analysis_version: 2, place: structuredClone(c) })
    try {
        state.setInput(external('old')); const all = state.loadAll()
        pending[0].resolve(reply(pending[0])); await Promise.resolve(); await Promise.resolve()
        const ready = state.blocks.poi.response
        state.setInput(external('new'))
        assert.equal(state.blocks.poi.response, ready); assert.equal(state.blocks.poi.phase, 'unavailable')
        assert.equal(pending[1].signal.aborted, true)
        pending[1].reject(new errors.ApiRequestError('http', 410, 'SELECTION_EXPIRED'))
        pending[2].resolve(reply(pending[2])); await all
        assert.equal(state.blocks.satellite.error, null); assert.equal(state.blocks.air.phase, 'idle')
        const reload = state.load('satellite')
        state.retireSelection(); assert.equal(state.input.value.place.selection_token, '')
        assert.equal(state.blocks.poi.response, ready)
        assert.equal(state.blocks.satellite.phase, 'error'); assert.equal(state.blocks.satellite.error.code, 'SNAPSHOT_EXPIRED')
        pending[3].resolve(reply(pending[3])); await reload
        assert.equal(state.blocks.satellite.phase, 'error')
        await state.load('poi'); assert.equal(pending.length, 4)
    } finally { cleanup() }
})
