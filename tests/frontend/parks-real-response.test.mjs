import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadModule } from './support/vue-component.mjs'
const directory=process.env.A8_PARK_QA_DIR
test('real park API source geometries and three other categories pass actual TS runtime',{skip:!directory},async()=>{
    for(const radius of [200,1000]){
        const f=JSON.parse(readFileSync(`${directory}/test-api-${radius}.json`,'utf8'));assert.equal(f.environment,'web_gis_test_rolled_back')
        const errors=loadModule(new URL('../../resources/js/api/errors.ts',import.meta.url),{},{fetch:async()=>new Response(JSON.stringify(f.response))})
        const api=loadModule(new URL('../../resources/js/api/placeAnalysis.ts',import.meta.url),{'./errors':errors}),r=await api.fetchPlaceAnalysis(f.request)
        const parks=r.blocks.poi.data.items.filter(i=>i.category==='park');assert.ok(parks.length>0)
        assert.ok(parks.every(i=>i.source==='OpenStreetMap'&&i.id.startsWith('osm:')&&i.observed_at===null&&i.limitations))
        assert.equal(r.blocks.poi.availability_by_category.official_stop.status,'READY')
    }
})
