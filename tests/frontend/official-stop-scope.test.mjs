import { test } from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import * as icons from '@lucide/vue'
import { loadComponent, loadModule } from './support/vue-component.mjs'
import { responseFor, input } from './fixtures/place-analysis.mjs'

function fixture(excluded) {
    const response = responseFor(input, { poi: 'READY' }), b = response.blocks.poi
    Object.assign(b.data.items[0], { id: 'official-stop:1', category: 'official_stop', source: 'official-stops' })
    b.availability_by_category = Object.fromEntries(['grocery', 'pharmacy', 'official_stop', 'park'].map(c => [c, { status: 'READY', code: null, message: 'Fixture' }]))
    b.data.official_stop_summary = { found_count: 7, source_without_coordinates: 2, ...(excluded === undefined ? {} : { excluded_outside_scope: excluded }) }
    b.completeness.by_category.official_stop.status = 'PARTIAL'
    b.data.count = null
    b.data.counts_by_category = { grocery: 0, pharmacy: 0, official_stop: null, park: 0 }
    return response
}

test('runtime accepts bounded scope exclusions and rejects inconsistent values', async () => {
    let response = fixture(2)
    const globals = { fetch: async () => new Response(JSON.stringify(response)) }
    const errors = loadModule(new URL('../../resources/js/api/errors.ts', import.meta.url), {}, globals)
    const api = loadModule(new URL('../../resources/js/api/placeAnalysis.ts', import.meta.url), { './errors': errors })
    assert.equal((await api.fetchPlaceAnalysis(input)).blocks.poi.data.official_stop_summary.excluded_outside_scope, 2)
    for (const value of [-1, 3, 1.5, '2', null]) {
        response = fixture(value)
        await assert.rejects(api.fetchPlaceAnalysis(input))
    }
    response = fixture(1); response.blocks.poi.data.official_stop_summary.source_without_coordinates = null
    await assert.rejects(api.fetchPlaceAnalysis(input))
    response = fixture(undefined)
    assert.equal((await api.fetchPlaceAnalysis(input)).blocks.poi.data.official_stop_summary.source_without_coordinates, 2)
})

test('UI hides only excluded records; unknown records still warn and found count is not list length', async () => {
    const satellite = loadModule(new URL('../../resources/js/utils/satellite.ts', import.meta.url))
    const component = loadComponent(new URL('../../resources/js/components/place-analysis/PlaceAnalysisResults.vue', import.meta.url), { '@lucide/vue': icons, '@/utils/satellite': satellite })
    async function render(excluded) {
        const response = fixture(excluded)
        const blocks = Object.fromEntries(['poi', 'satellite', 'air'].map(key => [key, { phase: key === 'poi' ? 'ready' : 'unavailable', response, error: null }]))
        return renderToString(h(component, { canLoad: true, tab: 'objects', blocks, selectedPoi: null, category: 'official_stop', date: '', satelliteMode: 'ndvi', satelliteCatalog: null, stationRadius: 5000, selectedIds: [] }))
    }
    const excluded = await render(2)
    assert.ok(excluded.includes('Найдено 7 остановочных точек'))
    assert.ok(!excluded.includes('pa-stop-unlocated'))
    assert.ok((await render(undefined)).includes('2 записи без координат'))
    assert.ok((await render(1)).includes('1 запись без координат'))
})
