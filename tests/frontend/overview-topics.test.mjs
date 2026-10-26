import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSSRApp, reactive } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { facts, topics, OverviewTopics, ComparisonFacts } from './support/overview-dependencies.mjs'
import { profile, places } from '../browser/fixtures.mjs'
const pair = () => Object.fromEntries(['left','right'].map((side,index) => {
    const p = profile(index ? places.b : places.a)
    for (const [topic,block] of Object.entries(p.blocks)) {
        for (const metric of Object.values(block.data.metrics)) metric.method_version = 'synthetic-method-v1'
        if(topic !== 'transport') block.data.metrics.nearest_distance.key = `${topic}_nearest_distance`
    }
    return [side, { id:p.address.id, profile:p, status:'ready', knownAddress:null }]
}))
const metric = (sides, side, topic='parks') => sides[side].profile.blocks[topic].data.metrics[topic === 'transport' ? 'nearest_stop_distance' : 'nearest_distance']
const fact = (sides, topic='parks') => facts.comparisonFacts(sides,500,[topic])[0].text

test('topic storage accepts only known identifiers, deduplicates in stable order and survives malformed and old payloads', () => {
    for(const value of [null,'bad','{}','{"version":0,"topics":["parks"]}','[1]']) assert.equal(topics.parseOverviewTopics(value),null)
    assert.deepEqual(topics.parseOverviewTopics('["roads","parks","parks","unknown"]'),['parks','roads'])
    assert.deepEqual(topics.parseOverviewTopics('[]'),[])
    assert.deepEqual(topics.parseOverviewTopics('["unknown"]'),[])
})
test('actual settings component defaults to original overview, uses native labelled checkboxes and explains local scope', async () => {
    const html=await renderToString(createSSRApp(OverviewTopics))
    assert.equal((html.match(/type="checkbox" checked/g)??[]).length,5)
    for(const text of ['Что важно мне','исходный обзор','Сбросить','Ссылка их не передаёт','Слои карты выбираются отдельно']) assert.ok(html.includes(text),text)
    assert.ok(!html.includes('Темы не выбраны'))
})
test('comparison facts prefer neither side, preserve real zero and compare display precision', () => {
    const sides=pair()
    metric(sides,'left').value=0;metric(sides,'right').value=30
    assert.match(fact(sides),/У адреса А парк ближе по прямой \(0 м против 30 м\)/)
    metric(sides,'left').value=40
    assert.match(fact(sides),/У адреса Б парк ближе/)
    for(const values of [[20,20],[20.1,20.4],[0.01,0.9]]) {
        metric(sides,'left').value=values[0];metric(sides,'right').value=values[1]
        assert.match(fact(sides),/одинаково при показанной точности/)
    }
    metric(sides,'left').value=0;metric(sides,'right').value=.1
    assert.match(fact(sides),/У адреса А/)
    assert.match(fact(sides),/Дата наблюдения неизвестна/)
})
test('summary blocks incompatible meaning, units, sources, snapshots, methods, versions, dates and limitations', () => {
    const changes = [m=>m.key='other',m=>m.unit='km',m=>m.source='different',m=>m.dataset_import_id=2,m=>m.dataset_import_id=null,m=>m.quality.method='PROXY',m=>delete m.method_version,m=>m.method_version='v2',m=>m.observed_at='2026-10-01',m=>m.source_updated_at='2026-10-01',m=>m.quality.freshness='STALE',m=>m.quality.reason='Иные ограничения']
    for(const change of changes) {
        const sides=pair();metric(sides,'left').value=100;change(metric(sides,'right'))
        assert.doesNotMatch(fact(sides),/У адреса/)
    }
})
test('null, unavailable, invalid values, partial or unknown coverage never imply a winning side', () => {
    for(const value of [null,NaN,Infinity,-1]) { const sides=pair();metric(sides,'right').value=value;assert.match(fact(sides),/недостаточно данных/) }
    for(const status of ['INSUFFICIENT_DATA','UNAVAILABLE']) {const sides=pair();metric(sides,'right').quality.availability=status;assert.match(fact(sides),/недостаточно данных/)}
    for(const change of [c=>c.status='UNKNOWN',c=>c.status='PARTIAL',c=>c.available_radius_m=null,c=>c.available_radius_m=100,c=>c.radius_m=300,c=>c.dataset_import_id=2,c=>c.data_boundary_sha256='different']) {
        const sides=pair();change(sides.right.profile.blocks.parks.data.coverage);assert.doesNotMatch(fact(sides),/У адреса|одинаково/)
    }
    const sides=pair();metric(sides,'right').value=1001;assert.match(fact(sides),/покрытия/)
})
test('current IDs, radius and status guard against stale, partial and failed profiles without hiding other topics', () => {
    for(const change of [s=>s.right.id=places.c.id,s=>s.right.profile.radius_m=300,s=>s.right.status='error',s=>s.right.profile.blocks.parks={status:'ERROR',data:null,message:'failed'}]) {const sides=pair();change(sides);assert.match(fact(sides),/сравнение неполное/)}
    const sides=reactive(pair());metric(sides,'left').value=100
    assert.match(fact(sides),/У адреса А/)
    sides.right.status='loading';assert.match(fact(sides),/предварительно/)
    sides.right.profile=null;assert.match(fact(sides),/ждём оба профиля/)
    sides.right.status='error';assert.match(fact(sides),/неполное/)
})
test('actual summary renders at most three stable links to rows, respects chosen and empty topics, marks unknown dates and stale data', async () => {
    const sides=pair()
    const html=await renderToString(createSSRApp(ComparisonFacts,{sides,radius:500,selected:null}))
    assert.equal((html.match(/<li(?:\s|>)/g)??[]).length,3)
    assert.ok(html.includes('#compare-metric-transport-nearest_stop_distance'))
    assert.ok(html.includes('Дата наблюдения неизвестна'))
    assert.ok(!html.includes('ближе'))
    const empty=await renderToString(createSSRApp(ComparisonFacts,{sides,radius:500,selected:[]}))
    assert.ok(!empty.includes('<a'))
    metric(sides,'left','railways').quality.freshness=metric(sides,'right','railways').quality.freshness='STALE'
    assert.match(fact(sides,'railways'),/Данные устарели/)
    assert.deepEqual(facts.comparisonFacts(sides,500,['railways','roads']).map(f=>f.topic),['roads','railways'])
})

test('shared actual composable persists only IDs, shares changes between consumers and handles read/write/remove failures', async () => {
    const {readFileSync}=await import('node:fs')
    const vue=await import('vue')
    const {evaluateModule}=await import('./support/vue-component.mjs')
    const mounted=[],writes=[],values=new Map(),listeners={}
    let denied=false
    const previous=globalThis.window
    globalThis.window={localStorage:{getItem(key){if(denied)throw Error('denied');return values.get(key)??null},setItem(key,value){if(denied)throw Error('denied');writes.push([key,value]);values.set(key,value)},removeItem(key){if(denied)throw Error('denied');values.delete(key)}},addEventListener(name,fn){listeners[name]=fn}}
    try {
        const code=readFileSync(new URL('../../resources/js/composables/useOverviewTopics.ts',import.meta.url),'utf8')
        const module=evaluateModule(code,{vue:{...vue,onMounted:fn=>mounted.push(fn)}})
        const a=module.useOverviewTopics(),b=module.useOverviewTopics()
        mounted.forEach(fn=>fn())
        assert.equal(a.configured.value,false)
        a.toggle('parks');assert.equal(b.includes('parks'),false)
        assert.deepEqual(JSON.parse(writes.at(-1)[1]),['transport','water','roads','railways'])
        denied=true;a.toggle('water')
        assert.equal(b.storageFailed.value,true);assert.equal(b.includes('water'),false)
        b.reset();assert.equal(a.selection.value,null);assert.equal(a.storageFailed.value,true)
        denied=false;values.set(module.overviewStorageKey,'["parks","unknown"]');listeners.storage({key:module.overviewStorageKey})
        assert.deepEqual([...a.selection.value],['parks'])
        a.reset();assert.equal(values.has(module.overviewStorageKey),false);assert.equal(a.storageFailed.value,false)
        const failing=evaluateModule(code,{vue:{...vue,onMounted:fn=>mounted.push(fn)}})
        denied=true;const c=failing.useOverviewTopics();mounted.at(-1)()
        assert.equal(c.selection.value,null);assert.equal(c.storageFailed.value,true)
    } finally {globalThis.window=previous}
})
