import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'

const source = new URL('../../resources/js/composables/useInterfacePreference.ts', import.meta.url)
function load(storage) { return loadModule(source, {}, { window: { localStorage: storage } }) }

test('interface defaults safely, recognizes only the version key and persists no page data', () => {
    for (const initial of [null, 'unknown', 'classic', 'workspace']) {
        const writes = [], reads = []
        const module = load({ getItem(key) { reads.push(key); return initial }, setItem(...entry) { writes.push(entry) } })
        const first = module.useInterfacePreference(), second = module.useInterfacePreference()
        assert.equal(first.version.value, initial === 'workspace' ? 'workspace' : 'classic')
        assert.deepEqual(reads, [module.interfaceStorageKey])
        assert.deepEqual(writes, [])
        first.setVersion('workspace')
        assert.equal(second.version.value, 'workspace')
        assert.equal(second.isWorkspace.value, true)
        first.setVersion('classic')
        assert.equal(second.isWorkspace.value, false)
        assert.deepEqual(writes, [[module.interfaceStorageKey, 'workspace'], [module.interfaceStorageKey, 'classic']])
        first.setVersion('invalid')
        assert.equal(first.version.value, 'classic')
        assert.equal(writes.length, 2)
    }
})

test('blocked storage retains explicit in-memory choice across consumers', () => {
    const module = load({ getItem() { throw Error('Blocked') }, setItem() { throw Error('Blocked') } })
    const state = module.useInterfacePreference()
    assert.equal(state.version.value, 'classic')
    state.setVersion('workspace')
    assert.equal(module.useInterfacePreference().version.value, 'workspace')
    state.setVersion('classic')
    assert.equal(state.version.value, 'classic')
})

test('interface preference can be rendered without browser globals', () => {
    const module = loadModule(source)
    assert.equal(module.useInterfacePreference().version.value, 'classic')
})
