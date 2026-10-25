import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, loadComponent } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'

const presentation = loadModule(new URL('../../resources/js/utils/mapLayerPresentation.ts', import.meta.url))
const profile = () => ({ blocks: { transport: { data: { metrics: { stops_count: { dataset_import_id: 9 } }, coverage: { status: 'COVERED' }, stops_in_radius: [] } } }, map: { area_layers: { parks: { data: { features: [], coverage: { status: 'COVERED' }, quality: { availability: 'AVAILABLE' } } } } } })
const context = () => ({ key: 'left', label: 'Вариант А', loading: false, profile: profile() })

test('layer notices distinguish an empty snapshot, unknown coverage and independent side failures', () => {
    const a = context(), b = { ...context(), key: 'right', label: 'Вариант Б' }
    b.profile.map.area_layers.parks = { status: 'ERROR', data: null }
    assert.match(presentation.mapLayerNotice('parks', a), /В снимке не найдены/)
    assert.equal(presentation.mapLayerNotice('parks', b), 'Слой недоступен.')
    assert.match(presentation.mapLayerNotice('stops', a), /В снимке не найдены точки/)
    a.profile.blocks.transport.data.coverage.status = 'UNKNOWN'
    assert.equal(presentation.mapLayerNotice('stops', a), 'Слой недоступен.')
    a.profile.map.area_layers.parks.data.coverage.status = 'PARTIAL'
    assert.equal(presentation.mapLayerNotice('parks', a), 'Неполное покрытие радиуса.')
    a.profile.map.area_layers.parks.data.coverage.status = 'COVERED'
    a.profile.map.area_layers.parks.data.quality.availability = 'INSUFFICIENT_DATA'
    assert.equal(presentation.mapLayerNotice('parks', a), 'Недостаточно данных.')
    a.loading = true
    assert.equal(presentation.mapLayerNotice('parks', a), 'Загрузка данных…')
    assert.equal(presentation.mapLayerNotice('parks', { ...a, loading: false, profile: null }), 'Данные недоступны для этого варианта.')
})

test('one panel exposes six independent controls, selected symbols and side-local notices without opening source details', async () => {
    const component = loadComponent(new URL('../../resources/js/components/map/MapLayersPanel.vue', import.meta.url), {
        '@/utils/mapLayerPresentation': presentation, './MapLayerDetails.vue': { render: () => vue.h('p', 'SOURCE DETAILS') },
    })
    const a = context(), b = { ...context(), key: 'right', label: 'Вариант Б', profile: null }
    const html = await ssr.renderToString(vue.createSSRApp(component, { stops: false, areas: { parks: true, vegetation: false, water: false }, lines: { roads: false, railways: false }, contexts: [a, b], comparison: true }))
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 6)
    assert.equal((html.match(/type="checkbox" checked/g) ?? []).length, 1)
    assert.match(html.replace(/<[^>]+>/g, ''), /1 включено/)
    assert.match(html, /Вариант А: <\/span>В снимке не найдены/)
    assert.match(html, /Вариант Б: <\/span>Данные недоступны/)
    assert.doesNotMatch(html, /SOURCE DETAILS/)
    assert.match(html, /aria-expanded="false"/)
    assert.match(html, /О данных: Парки/)
    assert.match(html, /layer-symbol--area/)
})
