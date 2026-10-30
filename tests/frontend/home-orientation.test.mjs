import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModule } from './support/vue-component.mjs'

const path = new URL('../../resources/js/utils/homeOrientation.ts', import.meta.url)
const orientation = loadModule(path)

test('orientation parser accepts empty input and positive decimal or exponent forms', () => {
    assert.deepEqual(orientation.parseOrientation('  '), { value: null, error: '' })
    assert.deepEqual(orientation.parseOrientation('1,25e2'), { value: 125, error: '' })
    assert.deepEqual(orientation.parseOrientation('+2'), { value: 2, error: '' })
    assert.deepEqual(orientation.parseOrientation('.5'), { value: 0.5, error: '' })
    assert.equal(orientation.parseOrientation('1e999').value, null)
    assert.match(orientation.parseOrientation('1e999').error, /конечным/)
    for (const input of ['0', '-1', '1,2,3', '1 minute', 'Infinity', 'NaN']) {
        assert.notEqual(orientation.parseOrientation(input).error, '')
    }
})

test('comparison preserves unknown and zero states and includes threshold equality', () => {
    assert.equal(orientation.compareOrientation(90, null, 'minutes').status, 'unset')
    const unavailable = orientation.compareOrientation(null, 5, 'minutes')
    assert.equal(unavailable.status, 'unavailable')
    assert.equal(unavailable.reason, 'Значение неизвестно.')
    assert.equal(orientation.compareOrientation(0, 5, 'minutes').status, 'within')
    assert.equal(orientation.compareOrientation(300, 5, 'minutes').status, 'within')
    assert.equal(orientation.compareOrientation(5, 5, 'meters').status, 'within')
    assert.equal(orientation.compareOrientation(0, 0, 'meters').status, 'unset')
})

test('over text reports truthful subunit and full excess', () => {
    assert.equal(orientation.compareOrientation(330, 5, 'minutes').text, '↑ менее 1 мин сверх')
    assert.equal(orientation.compareOrientation(375, 5, 'minutes').text, '↑ 1 мин 15 с сверх')
    assert.equal(orientation.compareOrientation(10.5, 10, 'meters').text, '↑ менее 1 м сверх')
    assert.equal(orientation.compareOrientation(12.5, 10, 'meters').text, '↑ 2,5 м сверх')
})

test('scale normalizes seconds and safely includes a very large threshold', () => {
    const results = [
        orientation.compareOrientation(120, 5, 'minutes'),
        orientation.compareOrientation(Number.MAX_VALUE, Number.MAX_VALUE, 'meters'),
    ]
    const time = orientation.orientationScale(results.slice(0, 1), 'minutes')
    assert.ok(time.maximum > 5)
    assert.ok(Math.abs(time.values[0] - 2 / time.maximum * 100) < 1e-10)
    assert.ok(time.thresholdPercent > 0)

    const huge = orientation.orientationScale(results.slice(1), 'meters')
    assert.ok(Number.isFinite(huge.maximum))
    assert.ok(huge.maximum >= Number.MAX_VALUE)
    assert.equal(huge.thresholdPercent, 100)
    assert.deepEqual(huge.values, [100])
    const empty = orientation.orientationScale([], 'meters')
    assert.ok(empty.maximum > 0)
    assert.equal(empty.thresholdPercent, null)
})

test('raw seconds around a fractional minute boundary determine status without rounding', () => {
    const limit = 1.01, seconds = limit * 60
    assert.equal(orientation.compareOrientation(seconds, limit, 'minutes').status, 'within')
    assert.equal(orientation.compareOrientation(seconds - 1e-8, limit, 'minutes').status, 'within')
    assert.equal(orientation.compareOrientation(seconds + 1e-8, limit, 'minutes').status, 'over')
    assert.equal(orientation.compareOrientation(Number.MAX_VALUE, Number.MAX_VALUE, 'minutes').status, 'within')
    for (const value of [null, NaN, Infinity, -1]) assert.equal(orientation.compareOrientation(value, 1, 'meters').status, 'unavailable')
})
