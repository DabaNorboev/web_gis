import { personalState, personalUtils } from './support/comparison-trips-dependencies.mjs'
import { topics, facts } from './support/overview-dependencies.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, loadComponent, loadSetup } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'
import { mapDependencies } from './support/map-dependencies.mjs'

const build = (ref, shallowReactive, onBeforeUnmount, fetchAddressProfile) => loadModule(new URL('../../resources/js/composables/useAddressComparison.ts', import.meta.url), {
    vue: { ...vue, ref, shallowReactive, onBeforeUnmount }, '@/api/profiles': { fetchAddressProfile },
}).useAddressComparison
const profile = (id, radius = 500) => ({ address: { id }, radius_m: radius })
function setup(initial = { left: 'osm:way:1', right: 'osm:node:2', radius: 500 }) {
    let cleanup
    const pending = [], changes = []
    const factory = build(vue.ref, vue.shallowReactive, fn => { cleanup = fn }, (id, radius, signal) => new Promise((resolve, reject) => pending.push({ id, radius, signal, resolve, reject })))
    const state = factory(initial, selection => changes.push(selection))
    return { state, pending, changes, dispose() { cleanup(); for (const p of pending) p.resolve(profile(p.id, p.radius)) } }
}

test('two profiles load independently; replacing and clearing one side preserves the other and rejects stale responses', async () => {
    const { state, pending, changes, dispose } = setup()
    try {
        const loaded = state.load()
        assert.equal(pending.length, 2)
        pending[0].resolve(profile('osm:way:1')); pending[1].resolve(profile('osm:node:2')); await loaded
        const right = state.sides.right.profile
        state.choose('left', 'osm:way:3')
        assert.equal(state.sides.left.profile, null)
        assert.equal(state.sides.right.profile, right)
        assert.equal(pending.length, 3)
        state.choose('left', 'osm:way:4')
        assert.equal(pending[2].signal.aborted, true)
        pending[3].resolve(profile('osm:way:4')); await Promise.resolve()
        pending[2].resolve(profile('osm:way:3')); await Promise.resolve()
        assert.equal(state.sides.left.profile.address.id, 'osm:way:4')
        state.choose('left', null)
        assert.equal(state.sides.left.status, 'empty')
        assert.equal(state.sides.left.profile, null)
        assert.equal(state.sides.right.profile, right)
        assert.deepEqual(changes.at(-1), { left: null, right: 'osm:node:2', radius: 500 })
    } finally { dispose() }
})

test('common radius clears both profiles and late old-radius results never mix with new results', async () => {
    const { state, pending, changes, dispose } = setup()
    try {
        const old = state.load()
        state.setRadius(300)
        assert.equal(pending.length, 4)
        assert.equal(pending[0].signal.aborted, true)
        assert.equal(pending[1].signal.aborted, true)
        assert.equal(state.sides.left.profile, null); assert.equal(state.sides.right.profile, null)
        for (const p of pending.slice(2)) p.resolve(profile(p.id, 300))
        await Promise.resolve()
        for (const p of pending.slice(0,2)) p.resolve(profile(p.id, 500))
        await old
        assert.equal(state.sides.left.profile.radius_m, 300)
        assert.equal(state.sides.right.profile.radius_m, 300)
        assert.deepEqual(changes, [{ left: 'osm:way:1', right: 'osm:node:2', radius: 300 }])
        state.setRadius(1000); assert.equal(pending.length, 4)
        state.choose('left', state.sides.left.id); assert.equal(changes.length, 1)
    } finally { dispose() }
})

test('invalid ID and unavailable source remain side-local and retryable; missing side makes no request', async () => {
    const { state, pending, dispose } = setup({ left: null, right: 'bad-id', radius: 500 })
    try {
        const loaded = state.load()
        assert.equal(pending.length, 1)
        assert.equal(state.sides.left.status, 'empty')
        pending[0].reject(Object.assign(new Error(), { status: 404 })); await loaded
        assert.equal(state.sides.right.status, 'not_found')
        const retry = state.loadSide('right')
        pending[1].reject(Object.assign(new Error(), { status: 503 })); await retry
        assert.equal(state.sides.right.status, 'unavailable')
        const error = state.loadSide('right')
        pending[2].reject(new Error('network')); await error
        assert.equal(state.sides.right.status, 'error')
        state.choose('right', 'osm:node:2')
        pending[3].resolve(profile('osm:node:2')); await Promise.resolve()
        assert.equal(state.sides.right.status, 'ready')
    } finally { dispose() }
})

test('back/forward restoration loads only changed sides and never pushes another history entry', async () => {
    const { state, pending, changes, dispose } = setup()
    try {
        const loaded = state.load()
        for (const p of pending) p.resolve(profile(p.id)); await loaded
        state.choose('right', 'osm:way:3')
        state.restore({ left: 'osm:way:1', right: 'osm:node:2', radius: 500 })
        assert.equal(pending.length, 4)
        assert.equal(pending[2].signal.aborted, true)
        pending[3].resolve(profile('osm:node:2')); await Promise.resolve()
        assert.equal(state.sides.right.profile.address.id, 'osm:node:2')
        assert.equal(changes.length, 1)
        dispose()
        assert.equal(pending[3].signal.aborted, true)
        pending[2].resolve(profile('osm:way:3')); await Promise.resolve()
        assert.equal(state.sides.right.profile.address.id, 'osm:node:2')
    } finally { dispose() }
})

test('a response with another object or radius cannot be presented as the requested comparison', async () => {
    const { state, pending, dispose } = setup()
    try {
        const loaded = state.load()
        pending[0].resolve(profile('osm:way:99'))
        pending[1].resolve(profile('osm:node:2', 300))
        await loaded
        assert.equal(state.sides.left.status, 'error'); assert.equal(state.sides.right.status, 'error')
        assert.equal(state.sides.left.profile, null); assert.equal(state.sides.right.profile, null)
    } finally { dispose() }
})

const comparison = loadModule(new URL('../../resources/js/utils/comparison.ts', import.meta.url))
const { parseComparison, comparisonUrl, comparisonDifferences } = comparison

test('shared URL round-trips exact object IDs, empty sides, Cyrillic and invalid IDs without execution', () => {
    const selection = { left: 'osm:way:123', right: 'bad <ID> & Киренского', radius: 300 }
    assert.deepEqual(parseComparison(comparisonUrl(selection).split('?')[1]), selection)
    assert.deepEqual(parseComparison('left=osm%3Anode%3A1&radius_m=1000'), { left: 'osm:node:1', right: null, radius: 500 })
    assert.deepEqual(parseComparison(''), { left: null, right: null, radius: 500 })
})
test('different source dates, snapshots, methods, availability and coverage produce explicit comparison notes', () => {
    const left = { value: 0, unit: '%', source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: '2026-10-18', method_version: 'v1', quality: { method: 'DERIVED', availability: 'AVAILABLE', freshness: 'UNKNOWN' } }
    const right = { ...left, dataset_import_id: 2, observed_at: '2026-10-10', source_updated_at: '2026-10-19', quality: { method: null, availability: 'INSUFFICIENT_DATA', freshness: 'STALE' }, method_version: 'v2' }
    const notes = comparisonDifferences(left, right, { status: 'COVERED' }, { status: 'PARTIAL' })
    assert.equal(notes.length, 7)
    assert.match(notes.join(' '), /не означает ноль/)
    assert.deepEqual(comparisonDifferences(left, left, { status: 'COVERED' }, { status: 'COVERED' }), [])
    assert.deepEqual(comparisonDifferences(undefined, right), [])
    assert.match(comparisonDifferences(left, { ...left, unit: 'm2' })[0], /Единицы различаются/)
})

const display = loadModule(new URL('../../resources/js/utils/metricDisplay.ts', import.meta.url))
const presentation = loadModule(new URL('../../resources/js/utils/profilePresentation.ts', import.meta.url))
const paired = loadModule(new URL('../../resources/js/utils/comparisonPresentation.ts', import.meta.url), { './profilePresentation': presentation })
function fullProfile(id) {
    const result = { address: { id, label: id === 'osm:way:1' ? 'Ленина, 102' : 'Киренского, 32' }, point: { lat: 56, lon: 92.9 }, radius_m: 500, map: {}, blocks: {} }
    for (const key of ['transport','parks','vegetation','water','roads','railways']) {
        const metrics = {}
        for (const field of key === 'transport' ? ['stops_count','nearest_stop_distance'] : ['nearest_distance','share','area','length']) {
            metrics[field] = { key: field, value: 0, unit: field === 'share' ? '%' : field === 'stops_count' ? 'count' : 'm', source: 'OpenStreetMap', dataset_import_id: 12,
                observed_at: null, source_updated_at: null, calculated_at: '2026-10-20T00:00:00Z', quality: { method: 'DERIVED', availability: 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Ограничения источника.' } }
        }
        result.blocks[key] = { status: 'READY', data: { metrics, coverage: { status: 'COVERED', reason: 'Радиус обеспечен данными.' }, nearest: null, nearest_stop: null }, message: null }
    }
    return result
}

test('only a verified label of the same object survives reload, radius changes and retries; all old analysis is cleared', async () => {
    const { state, pending, dispose } = setup()
    try {
        const loaded = state.load()
        pending[0].resolve({ ...profile('osm:way:1'), address: { id: 'osm:way:1', label: 'Публичный адрес А' }, map: { old: true } })
        pending[1].resolve(profile('osm:node:2'))
        await loaded
        state.setRadius(300)
        assert.deepEqual(state.sides.left.knownAddress, { id: 'osm:way:1', label: 'Публичный адрес А' })
        assert.equal(state.sides.left.profile, null)
        assert.equal(state.sides.right.profile, null)
        pending[2].reject(new Error('offline')); pending[3].resolve(profile('osm:node:2', 300))
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(state.sides.left.status, 'error')
        assert.equal(state.sides.left.knownAddress.label, 'Публичный адрес А')
        const retry = state.loadSide('left')
        assert.equal(state.sides.left.profile, null)
        assert.equal(state.sides.left.knownAddress.label, 'Публичный адрес А')
        state.choose('left', 'osm:way:99')
        assert.equal(state.sides.left.knownAddress, null)
        pending[4].resolve({ ...profile('osm:way:1', 300), address: { id: 'osm:way:1', label: 'Поздний старый адрес' } })
        await retry
        assert.equal(state.sides.left.knownAddress, null)
        pending[5].resolve({ ...profile('osm:way:99', 300), address: { id: 'osm:way:99', label: 'Публичный адрес В' } })
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(state.sides.left.knownAddress.label, 'Публичный адрес В')
        state.choose('left', null)
        assert.equal(state.sides.left.knownAddress, null)
    } finally { dispose() }
})
