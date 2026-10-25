import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, loadComponent } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'
import { mapDependencies, cityMapDependencies } from './support/map-dependencies.mjs'

let resizeObserved
const display = loadModule(new URL('../../resources/js/utils/metricDisplay.ts', import.meta.url))
function compile(file, inlineTemplate, deps, vueApi = vue) {
    const dependencies = file === 'components/map/CityMap.vue' ? cityMapDependencies(deps) : { '@/utils/metricDisplay': deps }
    return loadComponent(new URL('../../resources/js/' + file, import.meta.url), { ...dependencies, vue: vueApi }, {
        inlineTemplate, globals: { window: { location: { href: 'http://localhost' } }, ResizeObserver: class { constructor(callback) { resizeObserved = callback } observe() {} disconnect() {} }, requestAnimationFrame: callback => setTimeout(callback, 0), MutationObserver: class { observe() {} disconnect() {} } },
    })
}
const legend = compile('components/map/StopLayerInfo.vue', true, display)
const block = (coverage = 'COVERED', stops = []) => ({ status: 'READY', message: null, data: {
    coverage: { status: coverage, reason: 'Причина покрытия.' }, stops_in_radius: stops,
    metrics: { stops_count: { source: '24bpd', dataset_import_id: 9, observed_at: null, source_updated_at: '2025-05-31T00:00:00Z' } },
} })
const renderLegend = props => ssr.renderToString(vue.createSSRApp(legend, props))

test('layer legend names the official source and separates publication from observation, including when off', async () => {
    const html = await renderLegend({ enabled: false, block: block() })
    for (const text of ['Официальные точки остановок','слой выключен','официальный набор 24bpd','31.05.2025','Наблюдение: неизвестна','не подтверждает актуальность']) assert.ok(html.includes(text),text)
    assert.doesNotMatch(html, /нет точек в наборе/)
    const unknown = block(); unknown.data.metrics.stops_count.source_updated_at = null
    assert.match(await renderLegend({ enabled: true, block: unknown }), /публикация: неизвестна/)
})

test('layer legend distinguishes genuine empty data, incomplete radius, unavailable source and loading', async () => {
    assert.match(await renderLegend({ enabled: true, block: block() }), /нет точек в наборе.*не доказывает/s)
    for (const status of ['PARTIAL','UNKNOWN','OUTSIDE_SERVICE_AREA']) {
        const html = await renderLegend({ enabled: true, block: block(status) })
        assert.doesNotMatch(html, /нет точек в наборе/)
        assert.match(html, status === 'PARTIAL' ? /радиус покрыт не полностью/ : /Слой недоступен/)
    }
    const missing = block(); missing.data.metrics.stops_count.dataset_import_id = null
    assert.match(await renderLegend({ enabled: true, block: missing }), /Слой недоступен/)
    assert.match(await renderLegend({ enabled: true, block: null, loading: true }), /Обновляем точки/)
    assert.match(await renderLegend({ enabled: true, block: { status: 'ERROR', data: null, message: 'Ошибка блока' } }), /Ошибка блока/)
})

class FakeMap {
    constructor() { this.sources = {}; this.layers = {}; this.events = {}; this.layoutChanges = []; FakeMap.latest = this }
    on(event, callback) { this.events[event] = callback }
    addSource(id) { this.sources[id] = { setData(data) { this.data = JSON.parse(JSON.stringify(data)) } } }
    getSource(id) { return this.sources[id] }
    addLayer(layer) { this.layers[layer.id] = structuredClone(layer) }
    getLayer(id) { return this.layers[id] }
    setLayoutProperty(id, key, value) { (this.layers[id].layout ??= {})[key] = value; this.layoutChanges.push([id,key,value]) }
    setPaintProperty(id, key, value) { (this.layers[id].paint ??= {})[key] = value }
    project() { return { x: 100, y: 100 } }
    getZoom() { return 14 }
    addControl() {} fitBounds(bounds, options) { this.lastOptions = options; this.lastBounds = bounds; this.fitCount = (this.fitCount ?? 0) + 1 } resize() { this.resizeCount = (this.resizeCount ?? 0) + 1 } remove() {}
}
function setupMap(showStops) {
    const mounted = [], cleanup = []
    const component = compile('components/map/CityMap.vue', false, {
        ...mapDependencies,
        Map: FakeMap, NavigationControl: class {}, ScaleControl: class {}, setWorkerUrl() {}, workerUrl: 'worker',
        basemap: { sprite: '/sprite', sources: {}, layers: [] }, addressFeatures: () => ({ type: 'FeatureCollection', features: [] }), addressBounds: groups => groups[0]?.bounds ?? null,
    }, { ...vue, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => cleanup.push(fn) })
    const props = vue.reactive({ point: { lon: 92.9, lat: 56 }, addressGroup: null, selectedAddressId: null,
        radius: 500, selectedStopId: null, selectable: false, showStops, analysis: {
            analysis_area: { type: 'Polygon', coordinates: [] }, analysis_bounds: [92.89,55.99,92.91,56.01],
            stops_in_radius: [{ id: 21, source_id: 'official-1', name: 'Остановка', lon: 92.901, lat: 56.001 }],
        } })
    const scope = vue.effectScope()
    const bindings = scope.run(() => component.setup(props, { expose() {}, emit() {} }))
    bindings.container.value = { parentElement: { querySelector: () => null }, closest: () => null, getBoundingClientRect: () => ({ left:0,top:0,right:400,bottom:400,width:400,height:400 }) }
    mounted.forEach(fn => fn())
    const map = FakeMap.latest
    map.events.load()
    return { map, props, bindings, dispose() { cleanup.forEach(fn => fn()); scope.stop() } }
}

test('switching the layer changes only the two official stop layers, without changing data, address or radius layers', async () => {
    const state = setupMap(false)
    try {
        const map = state.map
        const before = structuredClone(map.getSource('transport-selection').data)
        assert.equal(map.getLayer('nearby-stops').layout.visibility,'none')
        assert.equal(map.getLayer('selected-stop').layout.visibility,'none')
        const stops = before.features.filter(f => f.properties.kind==='stop')
        assert.deepEqual(stops.map(f => [f.properties.id,...f.geometry.coordinates]),[[21,92.901,56.001]])
        state.props.showStops = true
        await vue.nextTick()
        assert.equal(map.getLayer('nearby-stops').layout.visibility,'visible')
        assert.equal(map.getLayer('selected-stop').layout.visibility,'visible')
        assert.deepEqual(map.getSource('transport-selection').data,before)
        assert.ok(map.layoutChanges.every(([id]) => ['nearby-stops','selected-stop'].includes(id)))
        state.props.selectedStopId = 21
        await vue.nextTick()
        assert.equal(map.getSource('transport-selection').data.features.find(f => f.properties.id===21).properties.kind,'selected-stop')
        state.props.showStops = false
        await vue.nextTick()
        assert.equal(map.getLayer('selected-stop').layout.visibility,'none')
    } finally { state.dispose() }
})

test('clearing and replacing the profile removes old official points without resetting visibility or substituting OSM points', async () => {
    const state = setupMap(true)
    try {
        state.props.analysis = null
        await vue.nextTick()
        assert.equal(state.map.getSource('transport-selection').data.features.filter(f => ['stop','selected-stop'].includes(f.properties.kind)).length,0)
        state.props.analysis = { analysis_area: { type: 'Polygon', coordinates: [] }, analysis_bounds: [92,55,93,56],
            stops_in_radius: [{ id: 34, source_id: 'official-2', lon: 92.95, lat: 56.02 }] }
        await vue.nextTick()
        const stops = state.map.getSource('transport-selection').data.features.filter(f => f.properties.kind==='stop')
        assert.deepEqual(stops.map(f => f.properties.id),[34])
        assert.equal(state.map.getLayer('nearby-stops').layout.visibility,'visible')
    } finally { state.dispose() }
})

test('refreshing the address representation cannot zoom away from the analysis radius', async () => {
    const state = setupMap(true)
    try {
        state.props.addressGroup = { id: 'osm:way:1', bounds: [92.899,55.999,92.901,56.001], objects: [] }
        await vue.nextTick()
        assert.deepEqual(state.map.lastBounds,[[92.89,55.99],[92.91,56.01]])
    } finally { state.dispose() }
})

test('the home point-selection mode retains its existing address-preview camera behavior', async () => {
    const state = setupMap(true)
    try {
        state.props.selectable = true
        state.props.addressGroup = { id: 'osm:way:1', bounds: [92.899,55.999,92.901,56.001], objects: [] }
        await vue.nextTick()
        assert.deepEqual(state.map.lastBounds,[[92.899,55.999],[92.901,56.001]])
    } finally { state.dispose() }
})

test('resizing or revealing the mounted map preserves user zoom and selection; new analysis still fits its radius', async () => {
    const state = setupMap(true)
    try {
        state.props.selectedStopId = 21
        await vue.nextTick()
        state.map.userZoom = 17
        const fits = state.map.fitCount
        const data = structuredClone(state.map.getSource('transport-selection').data)
        resizeObserved(); resizeObserved()
        await vue.nextTick()
        assert.equal(state.map.resizeCount, 2)
        assert.equal(state.map.fitCount, fits)
        assert.equal(state.map.userZoom, 17)
        assert.equal(state.props.selectedStopId, 21)
        assert.deepEqual(state.map.getSource('transport-selection').data, data)
        state.props.radius = 300
        state.props.analysis = { ...state.props.analysis, analysis_bounds: [92.895,55.995,92.905,56.005] }
        await vue.nextTick()
        assert.equal(state.map.fitCount, fits + 1)
        assert.deepEqual(state.map.lastBounds, [[92.895,55.995],[92.905,56.005]])
    } finally { state.dispose() }
})

test('Goal 8 real CityMap selects the exact ID among equal names and fits its geometry with the original point', async () => {
    const state = setupMap(true)
    try {
        const geometry = { type: 'Polygon', coordinates: [[[92.902,56.002],[92.903,56.002],[92.903,56.003],[92.902,56.002]]] }
        state.props.areaLayers = { parks: { data: { features: [
            { type:'Feature', properties:{ id:'osm:way:one', name:'Одинаковое имя' }, geometry:{type:'Polygon',coordinates:[[[93,57],[93.1,57],[93,57.1],[93,57]]]} },
            { type:'Feature', properties:{ id:'osm:way:two', name:'Одинаковое имя' }, geometry },
        ] } } }
        state.props.areaVisibility = { parks:true, vegetation:false, water:false }
        await vue.nextTick()
        state.bindings.selectFeature('parks','osm:way:two')
        await new Promise(resolve=>setTimeout(resolve,20))
        assert.equal(state.bindings.selectedFeature.value.id,'osm:way:two')
        assert.deepEqual(state.map.getSource('analysis-object-selection').data.features.map(f=>f.properties.id),['osm:way:two'])
        assert.deepEqual(state.map.lastBounds,[[92.9,56],[92.903,56.003]])
        assert.equal(state.map.lastOptions.maxZoom,16)
        assert.deepEqual(state.props.point,{lon:92.9,lat:56})
        state.props.selectionZoomLimit=12
        state.bindings.selectFeature('parks','osm:way:two')
        await new Promise(resolve=>setTimeout(resolve,20))
        assert.equal(state.map.lastOptions.maxZoom,12,'a sibling selection can constrain the common scale')
        const count=state.map.fitCount
        state.bindings.clearObjectSelection()
        await vue.nextTick()
        assert.equal(state.map.fitCount,count,'closing does not move camera')
        assert.deepEqual(state.map.getSource('analysis-object-selection').data.features,[])
        state.bindings.selectFeature('parks','missing')
        await vue.nextTick()
        assert.equal(state.bindings.selectedFeature.value,null,'missing ID never borrows another geometry')
    } finally { state.dispose() }
})

test('Goal 8 pending selection camera is invalidated by point reset and new analysis before animation frames', async () => {
    const state=setupMap(true)
    try {
        state.props.selectedStopId=21
        await vue.nextTick()
        state.props.point=null
        state.props.analysis=null
        await vue.nextTick()
        const count=state.map.fitCount
        await new Promise(resolve=>setTimeout(resolve,20))
        assert.equal(state.map.fitCount,count)
        assert.equal(state.bindings.selectedFeature.value,null)
        assert.deepEqual(state.map.getSource('transport-selection').data.features.filter(f=>f.properties.kind==='selected-stop'),[])
    } finally { state.dispose() }
})
