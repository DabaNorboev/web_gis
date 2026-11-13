import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
const source = new URL('../../resources/js/composables/useInterfacePreference.ts', import.meta.url)
test('workspace is unconditional and never reads or writes legacy preference', () => {
    for (const initial of [null, 'unknown', 'classic', 'workspace']) {
        const module = loadModule(source, {}, { window: { localStorage: {
            getItem() { throw Error('must not read ' + initial) }, setItem() { throw Error('must not write') },
        } } })
        const state = module.useInterfacePreference()
        assert.equal(state.version.value, 'workspace')
        state.setVersion('classic')
        assert.equal(state.isWorkspace.value, true)
        assert.equal(module.useInterfacePreference().version.value, 'workspace')
    }
})
test('workspace renders without browser globals', () => {
    assert.equal(loadModule(source).useInterfacePreference().isWorkspace.value, true)
})
