import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'
import { evaluateModule, loadComponent } from './support/vue-component.mjs'
import { topics, OverviewTopics } from './support/overview-dependencies.mjs'
import { mapDependencies } from './support/map-dependencies.mjs'
import { profile as makeProfile, places } from '../browser/fixtures.mjs'
const utility = name => evaluateModule(readFileSync(new URL(`../../resources/js/utils/${name}.ts`, import.meta.url), 'utf8'))
const display = utility('metricDisplay'), presentation = utility('profilePresentation'), stops = utility('stopGroups')
const metric = loadComponent(new URL('../../resources/js/components/ProfileMetric.vue', import.meta.url), { '@/utils/metricDisplay': display })
const component = loadComponent(new URL('../../resources/js/components/ProfileSummary.vue', import.meta.url), {
    '@/composables/useOverviewTopics': topics, '@/components/OverviewTopics.vue': OverviewTopics,
    '@/components/ProfileMetric.vue': metric, '@/utils/metricDisplay': display,
    '@/utils/profilePresentation': presentation, '@/utils/stopGroups': stops, '@/utils/mapAnalysis': mapDependencies,
})
const render = (profile, view = 'overview') => ssr.renderToString(vue.createSSRApp(component, { profile, view, selectedStopId: null }))
const fixture = () => makeProfile(places.a)

test('overview prioritizes nearest stop, groups other points without losing IDs or assuming directions', async () => {
    const p = fixture(), t = p.blocks.transport.data
    t.stops_in_radius[1].name = t.stops_in_radius[2].name = 'Одинаковая остановка'
    const html = await render(p)
    for (const text of ['Транспорт', 'Парки и вода', 'Дороги и пути', 'Ближайшая остановка', 'не пеший путь', 'Одинаковое название не определяет направление', 'объектов: 2']) assert.ok(html.includes(text), text)
    assert.equal(html.split('class="profile-stop-button"').length - 1, places.a.stops - 1)
    assert.ok(html.indexOf('Ближайшая остановка') < html.indexOf('Другие остановки'))
    assert.match(html, /id="profile-sources"[^>]*hidden/)
    assert.doesNotMatch(html, /78\/100|победитель|м²/)
})

test('radius folds only known available distances beyond circle, retaining zero, boundary and uncertain coverage', async () => {
    const p = fixture(), water = p.blocks.water.data
    water.metrics.nearest_distance.value = 501
    let html = await render(p)
    assert.match(html, /Вода — за кругом 500 м/)
    water.coverage.status = 'UNKNOWN'; water.coverage.reason = 'Охват воды неизвестен'
    html = await render(p)
    assert.ok(!html.includes('Вода — за кругом'))
    assert.ok(html.includes('Охват воды неизвестен'))
    for (const value of [0, 500, null]) {
        water.metrics.nearest_distance.value = value
        water.coverage.status = 'COVERED'
        water.metrics.nearest_distance.quality.availability = value === null ? 'INSUFFICIENT_DATA' : 'AVAILABLE'
        html = await render(p)
        assert.ok(!html.includes('Вода — за кругом'))
        assert.ok(html.includes(value === null ? 'Недостаточно данных' : `${value} м`))
    }
    p.blocks.parks = {status:'ERROR',data:null,message:'Ошибка парка'}
    assert.ok((await render(p)).includes('Ошибка парка'))
})

test('distant stop remains a separate disclosure; missing counts never become zero', async () => {
    const p = fixture(), t = p.blocks.transport.data
    t.metrics.nearest_stop_distance.value = 700; t.stops_in_radius = []
    t.metrics.stops_count.value = null; t.metrics.stops_count.quality.availability = 'INSUFFICIENT_DATA'
    const html = await render(p)
    assert.match(html, /Ближайшая остановка — за кругом 500 м/)
    assert.ok(html.includes('700 м'))
    assert.ok(html.includes('Недостаточно данных'))
    assert.ok(!html.includes('Показать остановку на карте'))
})

test('data tab keeps unknown observation separate from snapshot date and exposes technical provenance on request', async () => {
    const p = fixture()
    p.blocks.water.data.metrics.nearest_distance.source_updated_at = '2026-10-18T00:00:00Z'
    const html = await render(p, 'data')
    assert.match(html, /id="profile-overview"[^>]*hidden/)
    assert.doesNotMatch(html, /id="profile-sources"[^>]*hidden/)
    for (const text of ['Дата наблюдения: неизвестна', '18.10.2026', 'не заменяет дату наблюдения или проверки объекта', 'Метод и технические сведения', 'ID снимка']) assert.ok(html.includes(text), text)
})

test('additional shares retain tiny positive values, missing results and access restrictions', async () => {
    const p = fixture()
    p.blocks.parks.data.metrics.share.value = 0.001
    p.blocks.parks.data.nearest.access = 'private'
    p.blocks.vegetation.data.metrics.share.value = null
    p.blocks.vegetation.data.metrics.share.quality.availability = 'UNAVAILABLE'
    const html = await render(p)
    for (const text of ['&lt;0,1 %', 'Данные недоступны', 'частный', 'Вход в парк и доступ к берегу не подтверждены']) assert.ok(html.includes(text), text)
    assert.ok(html.indexOf('&lt;0,1 %') > html.indexOf('Растительные территории и доли круга'))
})

test('source grouping requires matching snapshot, dates, reasons, availability, method and entire coverage', () => {
    const p = fixture()
    for (const kind of ['parks','vegetation','water','roads','railways']) {
        p.blocks[kind].data.metrics = { nearest_distance: structuredClone(p.blocks.parks.data.metrics.nearest_distance) }
    }
    const count = () => presentation.profileSources(p).rows.filter(row => row.metric.source === 'OpenStreetMap').length
    assert.equal(count(), 1)
    const m = p.blocks.water.data.metrics.nearest_distance, base = structuredClone(m)
    for (const change of [x=>x.dataset_import_id++, x=>x.observed_at='2026-10-17T00:00:00Z', x=>x.source_updated_at='2026-10-18T00:00:00Z', x=>x.calculated_at='2026-10-23T00:00:00Z', x=>x.method_version='v2', x=>x.quality.reason='Иная оговорка', x=>x.quality.method='PROXY', x=>x.quality.freshness='STALE', x=>x.quality.availability='UNAVAILABLE']) {
        Object.assign(m, structuredClone(base)); change(m); assert.equal(count(), 2)
    }
    Object.assign(m, structuredClone(base)); p.blocks.water.data.coverage.available_radius_m = 350
    assert.equal(count(), 2)
})

test('shared dates appear once while differing explanations remain separate and source exceptions split sections', async () => {
    const p = fixture(), water = p.blocks.water.data
    water.metrics.nearest_distance.quality.reason = 'Отдельное ограничение расстояния'
    water.metrics.share.quality.reason = 'Отдельное ограничение доли'
    water.metrics.nearest_distance.source_updated_at = water.metrics.share.source_updated_at = '2026-10-18T00:00:00Z'
    const sections = presentation.profileSources(p).sections.filter(s => s.metric.source_updated_at)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].rows.length, 2)
    const html = await render(p, 'data')
    assert.equal(html.split('18.10.2026').length - 1, 1)
    assert.ok(html.includes('Отдельное ограничение расстояния'))
    assert.ok(html.includes('Отдельное ограничение доли'))
    water.metrics.share.quality.freshness = 'STALE'
    assert.equal(presentation.profileSources(p).sections.filter(s => s.metric.source_updated_at).length, 2)
})
