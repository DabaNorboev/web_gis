import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadModule } from './support/vue-component.mjs'
const directory=process.env.A8_OFFICIAL_STOPS_QA_DIR
test('actual official CSV API responses pass runtime with names/source/version and no false zero; bad metadata rejected',{skip:!directory},async()=>{
    for(const radius of [200,1000]){
        const f=JSON.parse(readFileSync(`${directory}/test-api-${radius}.json`,'utf8'));assert.equal(f.environment,'web_gis_test_rolled_back')
        let response=f.response
        const errors=loadModule(new URL('../../resources/js/api/errors.ts',import.meta.url),{},{fetch:async()=>new Response(JSON.stringify(response))})
        const api=loadModule(new URL('../../resources/js/api/placeAnalysis.ts',import.meta.url),{'./errors':errors})
        const r=await api.fetchPlaceAnalysis(f.request),b=r.blocks.poi,stops=b.data.items.filter(i=>i.category==='official_stop')
        assert.ok(stops.length>=2);assert.ok(stops.some(i=>i.id==='official-stop:3965'));assert.ok(stops.some(i=>i.id==='official-stop:3966'))
        assert.equal(b.data.counts_by_category.official_stop,null);assert.equal(b.completeness.by_category.official_stop.status,'PARTIAL')
        assert.ok(stops.every(i=>i.source==='official-stops'&&i.source_version==='20250531T1612'&&i.observed_at===null))
        for(const metadata of [{source_version:123},{source_url:'javascript:alert(1)'},{limitations:42}]){
            response=structuredClone(f.response);Object.assign(response.blocks.poi.data.items.find(i=>i.category==='official_stop'),metadata)
            await assert.rejects(api.fetchPlaceAnalysis(f.request))
        }
    }
})

test('found count is independent of list length; malformed or error counts are rejected',async()=>{
    const { responseFor,input }=await import('./fixtures/place-analysis.mjs')
    const fixture=responseFor(input,{poi:'READY'}),b=fixture.blocks.poi
    Object.assign(b.data.items[0],{id:'official-stop:1',category:'official_stop',source:'official-stops'})
    b.data.count=null;b.data.counts_by_category={grocery:0,pharmacy:0,official_stop:null,park:0}
    b.completeness.by_category.official_stop.status='PARTIAL'
    b.availability_by_category=Object.fromEntries(['grocery','pharmacy','official_stop','park'].map(c=>[c,{status:'READY',code:null,message:'Fixture'}]))
    b.data.official_stop_summary={found_count:7,source_without_coordinates:2}
    let response=fixture
    const errors=loadModule(new URL('../../resources/js/api/errors.ts',import.meta.url),{},{fetch:async()=>new Response(JSON.stringify(response))})
    const api=loadModule(new URL('../../resources/js/api/placeAnalysis.ts',import.meta.url),{'./errors':errors})
    const result=await api.fetchPlaceAnalysis(input)
    assert.equal(result.blocks.poi.data.official_stop_summary.found_count,7)
    assert.equal(result.blocks.poi.data.items.length,1)
    for(const summary of [{found_count:-1,source_without_coordinates:2},{found_count:0,source_without_coordinates:2},{found_count:1.5,source_without_coordinates:2},{found_count:7,source_without_coordinates:-2},{found_count:7}]){
        response=structuredClone(fixture);response.blocks.poi.data.official_stop_summary=summary
        await assert.rejects(api.fetchPlaceAnalysis(input))
    }
    response=structuredClone(fixture);response.blocks.poi.availability_by_category.official_stop={status:'ERROR',code:'CATEGORY_CALCULATION_FAILED',message:'Fixture failure'}
    await assert.rejects(api.fetchPlaceAnalysis(input))
})
