import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadComponent } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'

async function render(data = [], unknownLocalityAllowed = false) {
    const state = { query: vue.ref('Красноярск Мира 10'), results: vue.ref(data), meta: vue.ref({ unknown_locality_allowed: unknownLocalityAllowed, quality: { availability: 'AVAILABLE' } }), status: vue.ref('ready'), open: vue.ref(true), activeIndex: vue.ref(-1), search() {}, choose() {}, clear() {}, close() {} }
    const stub = { render: () => null }
    const component = loadComponent(new URL('../../resources/js/components/AddressSearch.vue', import.meta.url), {
        '@lucide/vue': { Search: stub, X: stub, ArrowRight: stub }, '@/composables/useAddressSearch': { useAddressSearch: () => state },
    })
    return ssr.renderToString(vue.createSSRApp(component, { resetKey: 0 }))
}

test('empty search offers refinement available on home, profile and comparison, without a map action', async () => {
    const html = await render()
    assert.match(html, /Адрес не найден в наборе\. Уточните улицу и номер дома\./)
    assert.doesNotMatch(html, /выберите точку|на карте/)
})

test('city context warns about unknown locality without modifying the result label', async () => {
    const results = [{ id: 'address:unknown', label: 'Тестовая улица, 10', object_count: 1, match_type: 'exact' }]
    const html = await render(results, true)
    assert.match(html, /В выдаче возможны объекты без указанного населённого пункта/)
    assert.match(html, /Их принадлежность Красноярску не подтверждена/)
    assert.match(html, />Тестовая улица, 10</)
    assert.doesNotMatch(html, />Красноярск, Тестовая улица, 10</)
    assert.doesNotMatch(await render(results, false), /принадлежность Красноярску/)
})
