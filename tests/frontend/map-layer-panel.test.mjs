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
