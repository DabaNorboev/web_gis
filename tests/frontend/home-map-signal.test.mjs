import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModule } from './support/vue-component.mjs'

const { homeMapSignal } = loadModule(new URL('../../resources/js/utils/homeMapSignal.ts', import.meta.url))

const cell = (overrides = {}) => ({
    key: 'walk-left',
    side: 'left',
    label: 'Слева',
    displayValue: '4 мин',
    state: 'ready',
    reason: '',
    result: { status: 'within', value: 240, threshold: 5, text: '✓ В ориентире', reason: '' },
    percent: 80,
    ...overrides,
})

test('ready signals follow the provided comparison status and text', () => {
    const within = homeMapSignal(cell())
    assert.equal(within.short, '✓')
    assert.match(within.detail, /Слева: 4 мин/)
    assert.match(within.detail, /✓ В ориентире/)

    const over = homeMapSignal(cell({ result: { status: 'over', value: 360, threshold: 5, text: '↑ 1 мин сверх', reason: '' } }))
    assert.equal(over.short, '↑')
    assert.match(over.detail, /↑ 1 мин сверх/)

    const unset = homeMapSignal(cell({ result: { status: 'unset', value: 240, threshold: null, text: 'Ориентир не задан.', reason: '' } }))
    assert.equal(unset.short, '—')
    assert.match(unset.detail, /Ориентир не задан/)
    assert.doesNotMatch(unset.detail, /в ориентире/i)
})

test('non-ready signals preserve state labels and reasons', () => {
    for (const [state, short, meaning] of [
        ['loading', '…', 'идёт расчёт'],
        ['need', 'расчёт', 'нужен расчёт'],
        ['refinement', 'уточнить', 'нужно уточнить результат'],
    ]) {
        const signal = homeMapSignal(cell({ state }))
        assert.equal(signal.short, short)
        assert.match(signal.detail, new RegExp(meaning))
    }

    const error = homeMapSignal(cell({ state: 'error', reason: 'Сервис недоступен.' }))
    assert.equal(error.short, '!')
    assert.match(error.detail, /Сервис недоступен/)

    const unknown = homeMapSignal(cell({ state: 'unknown', reason: 'Нет исходных данных.' }))
    assert.equal(unknown.short, '?')
    assert.match(unknown.detail, /Нет исходных данных/)
})
