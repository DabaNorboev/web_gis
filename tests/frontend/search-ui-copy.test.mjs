import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sourceFiles, assertUiText, forbiddenUiWords } from './support/search-ui-policy.mjs'
test('forbidden words are case insensitive and do not ban unrelated words', () => {
    for (const word of forbiddenUiWords) assert.throws(() => assertUiText(`Ошибка: ${word.toUpperCase()}.`))
    assert.doesNotThrow(() => assertUiText('PlaceLens: капитальный ремонт, Условия, Адреса'))
})
