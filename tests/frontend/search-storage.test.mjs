import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
const types = loadModule(new URL('../../resources/js/search/types.ts', import.meta.url))
const document = loadModule(new URL('../../resources/js/search/document.ts', import.meta.url))
const { createSearchTask } = loadModule(new URL('../../resources/js/search/task.ts', import.meta.url), { './document': document, './types': types })
const { encodeStoredSearch, decodeStoredSearch } = loadModule(new URL('../../resources/js/search/storage.ts', import.meta.url), { './document': document })
function source() {
    let n = 0
    const task = createSearchTask({ nextId: () => `synthetic-${++n}`, now: () => 'synthetic-time' })
    task.addCandidate({ kind: 'address', addressId: 'osm:way:1', lon: .1, lat: .2, label: 'Синтетический объект', provenance: null })
    task.addPlace({ kind: 'point', lon: .2, lat: .3, label: 'Точка' }, 'Место', 'walking', 30)
    return JSON.parse(JSON.stringify(task.exportDocument()))
}
test('storage codec projects an explicit input allowlist and has an independent version/revision', () => {
    const input = source()
    input.runtime = { metrics: 24, calculatedAt: 'forbidden', geometry: { coordinates: [] } }
    input.candidates[0].results = { value: 123 }
    input.places[0].response = { private: true }
    const output = encodeStoredSearch(input, 3)
    assert.equal(output.schemaVersion, 1); assert.equal(output.storageRevision, 3)
    assert.deepEqual(decodeStoredSearch(output), output)
    for (const field of ['runtime', 'metrics', 'calculatedAt', 'geometry', 'results', 'response']) assert.equal(JSON.stringify(output).includes(`"${field}"`), false)
    input.places[0].label = 'mutated'
    assert.equal(output.places[0].label, 'Место')
})
test('unknown versions and corrupt inputs fail with safe explanations', () => {
    for (const schemaVersion of [undefined, 0, 2, '1']) assert.throws(() => decodeStoredSearch({ ...source(), schemaVersion, storageRevision: 1 }), e => e.code === 'version')
    for (const storageRevision of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => encodeStoredSearch(source(), storageRevision))
    const value = source(); value.pair.a = 'not-a-member'
    assert.throws(() => decodeStoredSearch({ ...value, schemaVersion: 1, storageRevision: 1 }), e => e.code === 'corrupt' && !e.message.includes('not-a-member'))
})
