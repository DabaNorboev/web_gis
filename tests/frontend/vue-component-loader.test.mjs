import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateModule } from './support/vue-component.mjs'

test('loader preserves default, named and aliased imports and re-exports', () => {
    const dep = evaluateModule('export default 3; export const amount = 4')
    const loaded = evaluateModule(`import base, { amount as extra } from 'dep'; export { amount as renamed } from 'dep'; export const total = base + extra`, { dep })
    assert.equal(loaded.total, 7)
    assert.equal(loaded.renamed, 4)
})
test('loader erases TypeScript type-only dependencies', () => {
    assert.equal(evaluateModule(`import type { Absent } from 'types'; import { type Other, value } from 'dep'; export const result: Absent | Other = value`, { dep: { value: 9 } }).result, 9)
})
test('loader rejects unknown modules and missing named or default exports', () => {
    assert.throws(() => evaluateModule(`import { value } from 'unknown'; export const result = value`), /Unresolved test module: unknown/)
    assert.throws(() => evaluateModule(`import { value as alias } from 'dep'; export const result = alias`, { dep: {} }), /Missing test export "value" from: dep/)
    assert.throws(() => evaluateModule(`export { value as alias } from 'dep'`, { dep: {} }), /Missing test export "value" from: dep/)
    assert.throws(() => evaluateModule(`import value from 'dep'; export const result = value`, { dep: { __esModule: true } }), /Missing test export "default" from: dep/)
})
test('loader keeps separate evaluations and their mocks isolated', () => {
    const source = `import { value } from 'dep'; let count = 0; export const next = () => value + ++count`
    const first = evaluateModule(source, { dep: { value: 10 } })
    const second = evaluateModule(source, { dep: { value: 20 } })
    assert.equal(first.next(), 11)
    assert.equal(second.next(), 21)
    assert.equal(first.next(), 12)
})
