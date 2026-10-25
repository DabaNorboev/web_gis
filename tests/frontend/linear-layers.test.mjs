import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, loadComponent } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'
import { mapDependencies, cityMapDependencies } from './support/map-dependencies.mjs'

const display = loadModule(new URL('../../resources/js/utils/metricDisplay.ts', import.meta.url))
function compile(file, inlineTemplate, deps, vueApi = vue) {
    const dependencies = file === 'components/map/CityMap.vue' ? cityMapDependencies(deps) : { '@/utils/metricDisplay': deps }
    return loadComponent(new URL('../../resources/js/' + file, import.meta.url), { ...dependencies, vue: vueApi }, {
        inlineTemplate, globals: { window: { location: { href: 'http://localhost' } }, ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} } },
    })
}
class FakeMap {
    constructor() { this.sources = {}; this.layers = {}; this.events = {}; this.layoutChanges = []; FakeMap.latest = this }
    on(event, callback) { this.events[event] = callback }
    addSource(id) { this.sources[id] = { setData(data) { this.data = JSON.parse(JSON.stringify(data)) } } }
    getSource(id) { return this.sources[id] }
    addLayer(layer) { this.layers[layer.id] = structuredClone(layer) }
    getLayer(id) { return this.layers[id] }
    setLayoutProperty(id, key, value) { (this.layers[id].layout ??= {})[key] = value; this.layoutChanges.push([id,key,value]) }
    setPaintProperty(id, key, value) { (this.layers[id].paint ??= {})[key] = value }
    addControl() {} fitBounds(bounds) { this.lastBounds = bounds } resize() {} remove() {}
}
function setupMap(linearLayers, linearVisibility) {
    const mounted = [], cleanup = []
    const component = compile('components/map/CityMap.vue', false, {
        ...mapDependencies,
        Map: FakeMap, NavigationControl: class {}, ScaleControl: class {}, setWorkerUrl() {}, workerUrl: 'worker',
        basemap: { sprite: '/sprite', sources: {}, layers: [] }, addressFeatures: () => ({ type: 'FeatureCollection', features: [] }), addressBounds: groups => groups[0]?.bounds ?? null,
    }, { ...vue, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => cleanup.push(fn) })
    const props = vue.reactive({ point: { lon: 92.9, lat: 56 }, addressGroup: null, selectedAddressId: null,
        radius: 500, selectedStopId: null, selectable: false, showStops: false, linearLayers, linearVisibility, areaLayers: { parks: layer('osm:way:20'), vegetation: layer('osm:way:20'), water: layer('osm:way:21') }, areaVisibility: { parks: false, vegetation: false, water: false }, analysis: {
            analysis_area: { type: 'Polygon', coordinates: [] }, analysis_bounds: [92.89,55.99,92.91,56.01],
            stops_in_radius: [{ id: 21, source_id: 'official-1', name: 'Остановка', lon: 92.901, lat: 56.001 }],
        } })
    const scope = vue.effectScope()
    const bindings = scope.run(() => component.setup(props, { expose() {}, emit() {} }))
    bindings.container.value = { parentElement: { querySelector: () => null }, closest: () => null }
    mounted.forEach(fn => fn())
    const map = FakeMap.latest
    map.events.load()
    return { map, props, dispose() { cleanup.forEach(fn => fn()); scope.stop() } }
}



const kinds = ['roads','railways']
const visibility = () => ({ roads: false, railways: false })
const layer = (id, status = 'COVERED') => ({ status: 'READY', message: null, data: {
    type: 'FeatureCollection', features: id ? [{ type: 'Feature', id, properties: { id, name: null, feature_type: 'rail' }, geometry: { type: 'MultiLineString', coordinates: [[[92.9,56],[92.91,56]],[[92.9,56.001],[92.91,56.001]]] } }] : [],
    coverage: { status, reason: 'Причина покрытия.' }, quality: { availability: ['UNKNOWN','OUTSIDE_SERVICE_AREA'].includes(status) ? 'UNAVAILABLE' : status === 'PARTIAL' ? 'INSUFFICIENT_DATA' : 'AVAILABLE' },
    source: 'OpenStreetMap', dataset_import_id: 10, source_updated_at: '2026-10-18T20:25:06Z', observed_at: null,
} })
const layers = () => ({ roads: layer('osm:way:1'), railways: layer('osm:way:2') })
const legend = compile('components/map/LinearLayerInfo.vue', true, {})
const render = props => ssr.renderToString(vue.createSSRApp(legend, props))

test('two linear switches are independent across all combinations with area layers and retain exact fragments without touching other sources', async () => {
    const state = setupMap(layers(), visibility())
    try {
        const selection = structuredClone(state.map.getSource('transport-selection').data)
        const original = Object.fromEntries(kinds.map(k => [k,state.map.getSource(`linear-${k}`).data]))
        for (let areaMask=0;areaMask<8;areaMask++) for (let mask=0;mask<4;mask++) {
            state.props.areaVisibility = Object.fromEntries(['parks','vegetation','water'].map((k,i)=>[k,!!(areaMask&(1<<i))]))
            state.props.linearVisibility = { roads: !!(mask&1), railways: !!(mask&2) }
            await vue.nextTick()
            for (const kind of kinds) {
                for (const suffix of ['casing','line']) assert.equal(state.map.getLayer(`linear-${kind}-${suffix}`).layout.visibility,state.props.linearVisibility[kind]?'visible':'none')
                assert.deepEqual(state.map.getSource(`linear-${kind}`).data,state.props.linearLayers[kind].data)
                assert.equal(state.map.getSource(`linear-${kind}`).data, original[kind]) // No geometry reset on visibility-only change.
            }
            for (const kind of ['parks','vegetation','water']) {
                assert.deepEqual(state.map.getSource(`area-${kind}`).data,state.props.areaLayers[kind].data)
                assert.equal(state.map.getLayer(`area-${kind}-fill`).layout.visibility,state.props.areaVisibility[kind]?'visible':'none')
            }
            assert.deepEqual(state.map.getSource('transport-selection').data,selection)
            assert.equal(state.map.getLayer('nearby-stops').layout.visibility,'none')
        }
        state.props.linearLayers=null
        await vue.nextTick()
        for(const kind of kinds)assert.equal(state.map.getSource(`linear-${kind}`).data.features.length,0)
        state.props.linearLayers=layers()
        state.props.linearLayers.roads={status:'ERROR',data:null,message:'Ошибка'}
        await vue.nextTick()
        assert.equal(state.map.getSource('linear-roads').data.features.length,0)
        assert.equal(state.map.getSource('linear-railways').data.features.length,1)
    } finally {state.dispose()}
})

test('linear legend distinguishes missing, empty, partial and loading, keeps source dates and never presents lengths or a rating',async()=>{
    const enabled={roads:true,railways:true}, data=layers()
    const normal=await render({visibility:enabled,layers:data})
    for(const text of ['Крупные дороги','Железнодорожные линии','OpenStreetMap contributors','ODbL','18.10.2026','наблюдение: неизвестна','без трамвая'])assert.ok(normal.includes(text),text)
    assert.doesNotMatch(normal,/длина|рейтинг|балл|length/i)
    data.roads=layer(null)
    data.railways=layer('osm:way:2','PARTIAL')
    const gaps=await render({visibility:enabled,layers:data})
    assert.equal((gaps.match(/не найдены линии/g)??[]).length,1)
    assert.match(gaps,/Частичное покрытие/)
    data.roads=layer(null,'UNKNOWN');data.railways={status:'ERROR',data:null,message:'Ошибка'}
    const missing=await render({visibility:enabled,layers:data})
    assert.match(missing,/Линии недоступны/)
    assert.match(missing,/Линии слоя недоступны/)
    assert.doesNotMatch(missing,/не найдены линии/)
    assert.match(await render({visibility:enabled,layers:null,loading:true}),/Загрузка линий/)
    assert.doesNotMatch(await render({visibility:visibility(),layers:data}),/Легенда/)
})
