import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'
import { evaluateModule, loadComponent } from './support/vue-component.mjs'

const groups = evaluateModule(readFileSync(new URL('../../resources/js/utils/stopGroups.ts', import.meta.url), 'utf8'))
const pointLabel = loadComponent(new URL('../../resources/js/components/PointAddressLabel.vue', import.meta.url), {
    '@/composables/usePointAddress': { usePointAddress: () => ({ result: vue.ref(null), status: vue.ref('loading'), selected: vue.ref(null), selectedId: vue.ref(null), choose() {}, retry() {} }) },
})
const component = loadComponent(new URL('../../resources/js/components/TransportResults.vue', import.meta.url), {
    '@/utils/stopGroups': groups,
    '@/components/PointAddressLabel.vue': pointLabel,
})

async function render(status, count, stops = []) {
    const metrics = Object.fromEntries(['nearest_stop_distance', 'stops_count', 'unique_routes_count', 'identified_routes_count'].map(key => [key, {
        key, value: key === 'nearest_stop_distance' ? null : count, observed_at: null, calculated_at: '2026-10-19T17:00:00Z', dataset_import_id: 1,
        quality: { availability: count === null ? 'INSUFFICIENT_DATA' : 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Ограничения источника.' },
    }]))
    const props = { radius: 500, selectedStopId: null, point: { lon: 92.9, lat: 56 }, status: 'ready',
        analysis: { metrics, coverage: { status, reason: 'Проверка территории.', buffer_m: 1000 }, nearest_stop: null, stops_in_radius: stops } }
    return ssr.renderToString(vue.createSSRApp(component, props))
}

test('outside coverage is rendered explicitly without pretending the local stop count is zero', async () => {
    const html = await render('OUTSIDE_SERVICE_AREA', null)
    assert.match(html, /Вне покрытия/)
    assert.doesNotMatch(html, /В выбранном радиусе нет остановок/)
    assert.doesNotMatch(html, /Точек остановок в радиусе/)
})

test('partial coverage labels found stops as partial and does not render a zero count', async () => {
    const html = await render('PARTIAL', null, [{ id: 1, name: 'Найденная остановка', lon: 92.9, lat: 56, distance_m: 100 }])
    assert.match(html, /Неполное покрытие радиуса/)
    assert.match(html, /полный подсчёт недоступен/)
    assert.match(html, /Найденная остановка/)
    assert.match(html, /Недостаточно данных/)
    assert.doesNotMatch(html, /В выбранном радиусе нет остановок/)
})

test('an empty covered radius remains distinct from missing coverage', async () => {
    const covered = await render('COVERED', 0)
    assert.match(covered, /В выбранном радиусе нет остановок/)
    assert.doesNotMatch(covered, /Покрытие не подтверждено/)
    const unknown = await render('UNKNOWN', null)
    assert.match(unknown, /Покрытие не подтверждено/)
    assert.doesNotMatch(unknown, /В выбранном радиусе нет остановок/)
})

test('point analysis labels radius and coordinates visibly before results, without claiming an address', async () => {
    for (const radius of [300, 500]) {
        const html = await ssr.renderToString(vue.createSSRApp(component, { radius, selectedStopId: null, point: { lon: 92.9, lat: 56 }, status: 'loading', analysis: null }))
        assert.match(html, new RegExp(`Остановки в радиусе ${radius} м от выбранной точки`))
        assert.match(html, /Выбранная точка: 56\.000000, 92\.900000/)
        assert.match(html, /Точка анализа/)
        assert.match(html, /Определяем адрес по локальным данным/)
        assert.doesNotMatch(html, /Рядом с /)
    }
})
