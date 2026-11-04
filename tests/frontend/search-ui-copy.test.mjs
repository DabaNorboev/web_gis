import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sourceFiles, checkUiCopy, assertUiText, forbiddenUiWords } from './support/search-ui-policy.mjs'

test('new UI copy contains no technical vocabulary', () => {
    for (const file of sourceFiles(fileURLToPath(new URL('../../resources/js/search-ui', import.meta.url)))) checkUiCopy(file, readFileSync(file, 'utf8'))
})
test('forbidden words are case insensitive and do not ban unrelated words', () => {
    for (const word of forbiddenUiWords) assert.throws(() => assertUiText(`Ошибка: ${word.toUpperCase()}.`))
    assert.doesNotThrow(() => assertUiText('PlaceLens: капитальный ремонт, Условия, Адреса'))
})
test('guard covers visible template text, attributes and bound literal strings', () => {
    for (const template of ['<p>Ошибка backend</p>', '<button aria-label="API" />', '<input placeholder="payload" />', '<p>{{ "runtime" }}</p>', '<p :title="`UNKNOWN`" />']) {
        assert.throws(() => checkUiCopy('/Search.vue', `<template>${template}</template>`), /Technical word/)
    }
    assert.throws(() => checkUiCopy('/copy.ts', "export const copy = { message: 'owner' }"))
    assert.doesNotThrow(() => checkUiCopy('/Search.vue', '<script setup>const candidateId = 1</script><template><p class="owner">Адрес</p></template>'))
})
