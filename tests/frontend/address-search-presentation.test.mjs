import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
import { candidate } from './fixtures/geocoding.mjs'

const { localAddressLabel, geocodingAddressLabel, distinguishAddressLabels } = loadModule(
    new URL('../../resources/js/utils/addressLabels.ts', import.meta.url),
)

test('local display preserves complete numbers and leaves an older label intact', () => {
    const original = 'Город, Набережная, 10/2А к3 стр4'
    assert.equal(localAddressLabel(original, { address_line: 'Набережная', house_number: '10/2А к3 стр4', district: null }),
        'Набережная, 10/2А к3 стр4')
    assert.equal(localAddressLabel(original, { house_number: '10/2А к3 стр4' }), '10/2А к3 стр4')
    assert.equal(localAddressLabel(original, {}), 'Адрес')
    assert.equal(localAddressLabel(original), original)
})

test('Geoapify uses the full raw number, explicit district and safe partial labels', () => {
    const { components } = candidate()
    const house = { ...components, street: 'Набережная', district: 'Условный район', number: { ...components.number, raw: '10/2А к3 стр4' } }
    assert.equal(geocodingAddressLabel(house, 'house'), 'Набережная, 10/2А к3 стр4, Условный район')
    assert.equal(geocodingAddressLabel(components, 'house'), 'Синтетическая улица, 10')
    assert.equal(geocodingAddressLabel(house, 'street'), 'Набережная, Условный район')
    const incomplete = { ...components, street: null, number: { ...components.number, raw: null } }
    assert.equal(geocodingAddressLabel(incomplete, 'street'), 'Улица')
    assert.equal(geocodingAddressLabel(incomplete, 'locality'), 'Местность')
    assert.equal(geocodingAddressLabel(incomplete, null), 'Адрес')
})

test('only colliding labels receive ordinals and address variants remain intact', () => {
    assert.deepEqual(distinguishAddressLabels(['Мира, 10/2А', 'Мира, 10/2Б', 'мира, 10/2а'], 'Вариант'),
        ['Мира, 10/2А · Вариант 1', 'Мира, 10/2Б', 'мира, 10/2а · Вариант 2'])
})
