import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadModule } from './support/vue-component.mjs'

const directory = process.env.A8_GROCERY_QA_DIR
// Opt-in artefacts from the protected DB test, never the working API or private points.
test('real prepared grocery API responses pass the actual TS runtime contract', { skip: !directory }, async () => {
    for (const radius of [200, 1000]) {
        const fixture = JSON.parse(readFileSync(`${directory}/test-api-${radius}.json`, 'utf8'))
        assert.equal(fixture.environment, 'web_gis_test_rolled_back')
        const errors = loadModule(new URL('../../resources/js/api/errors.ts', import.meta.url), {}, {
            fetch: async () => new Response(JSON.stringify(fixture.response)),
        })
        const api = loadModule(new URL('../../resources/js/api/placeAnalysis.ts', import.meta.url), { './errors': errors })
        const result = await api.fetchPlaceAnalysis(fixture.request)
        assert.equal(result.blocks.poi.status, 'READY')
        assert.ok(result.blocks.poi.data.items.length > 0)
        assert.equal(result.blocks.poi.data.items[0].source, 'OpenStreetMap')
        assert.equal(result.blocks.poi.data.items[0].observed_at, null)
        assert.equal(result.blocks.poi.data.counts_by_category.pharmacy, null)
    }
})
