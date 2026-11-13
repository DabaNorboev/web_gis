import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadModule } from './support/vue-component.mjs'

const directory = process.env.A8_PHARMACY_QA_DIR
test('real independently imported retail responses pass TS runtime; bad category status is rejected', { skip: !directory }, async () => {
    for (const radius of [200,1000]) {
        const fixture = JSON.parse(readFileSync(`${directory}/test-api-${radius}.json`,'utf8'))
        assert.equal(fixture.environment,'web_gis_test_rolled_back')
        let response = fixture.response
        const errors = loadModule(new URL('../../resources/js/api/errors.ts',import.meta.url),{}, { fetch: async () => new Response(JSON.stringify(response)) })
        const api = loadModule(new URL('../../resources/js/api/placeAnalysis.ts',import.meta.url),{'./errors':errors})
        const result = await api.fetchPlaceAnalysis(fixture.request)
        assert.equal(result.blocks.poi.status,'READY')
        assert.ok(result.blocks.poi.data.items.some(p=>p.category==='pharmacy'&&p.source==='OpenStreetMap'))
        assert.equal(result.blocks.poi.availability_by_category.pharmacy.status,'READY')
        response = structuredClone(fixture.response)
        response.blocks.poi.availability_by_category.pharmacy.status='FAKE_READY'
        await assert.rejects(api.fetchPlaceAnalysis(fixture.request))
    }
})
