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
function setupMap(areaLayers, areaVisibility) {
    const mounted = [], cleanup = []
    const component = compile('components/map/CityMap.vue', false, {
        ...mapDependencies,
        Map: FakeMap, NavigationControl: class {}, ScaleControl: class {}, setWorkerUrl() {}, workerUrl: 'worker',
        basemap: { sprite: '/sprite', sources: {}, layers: [] }, addressFeatures: () => ({ type: 'FeatureCollection', features: [] }), addressBounds: groups => groups[0]?.bounds ?? null,
    }, { ...vue, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => cleanup.push(fn) })
    const props = vue.reactive({ point: { lon: 92.9, lat: 56 }, addressGroup: null, selectedAddressId: null,
        radius: 500, selectedStopId: null, selectable: false, showStops: false, areaLayers, areaVisibility, analysis: {
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


const kinds = ['parks', 'vegetation', 'water']
const visibility = () => ({ parks: false, vegetation: false, water: false })
const layer = (id, state = 'COVERED') => ({ status: 'READY', message: null, data: {
    type: 'FeatureCollection', features: id ? [{ type: 'Feature', id, properties: { id, name: null }, geometry: { type: 'Polygon', coordinates: [[[92,56],[93,56],[93,57],[92,56]]] } }] : [],
    coverage: { status: state, reason: 'Причина покрытия.' }, quality: { availability: ['UNKNOWN','OUTSIDE_SERVICE_AREA'].includes(state) ? 'UNAVAILABLE' : state === 'PARTIAL' ? 'INSUFFICIENT_DATA' : 'AVAILABLE' },
    source: 'OpenStreetMap', dataset_import_id: 12, source_updated_at: '2026-10-18T20:25:06Z', observed_at: null,
} })
const layers = () => ({ parks: layer('osm:relation:1'), vegetation: layer('osm:relation:1'), water: layer('osm:way:2') })
const legend = compile('components/map/AreaLayerInfo.vue', true, {})
const render = props => ssr.renderToString(vue.createSSRApp(legend, props))

test('area switches preserve independent shared IDs and affect only their own polygon layers for all eight combinations', async () => {
    const state = setupMap(layers(), visibility())
    try {
        const selection = structuredClone(state.map.getSource('transport-selection').data)
        for (let mask = 0; mask < 8; mask++) {
            state.props.areaVisibility = Object.fromEntries(kinds.map((kind, i) => [kind, !!(mask & (1 << i))]))
            await vue.nextTick()
            for (const kind of kinds) {
                for (const suffix of ['fill','outline']) assert.equal(state.map.getLayer(`area-${kind}-${suffix}`).layout.visibility, state.props.areaVisibility[kind] ? 'visible' : 'none')
                assert.deepEqual(state.map.getSource(`area-${kind}`).data, state.props.areaLayers[kind].data)
            }
            assert.deepEqual(state.map.getSource('transport-selection').data, selection)
            assert.equal(state.map.getLayer('nearby-stops').layout.visibility, 'none')
        }
        assert.equal(state.map.getSource('area-parks').data.features[0].id, state.map.getSource('area-vegetation').data.features[0].id)
        state.props.areaLayers = null
        await vue.nextTick()
        for (const kind of kinds) assert.equal(state.map.getSource(`area-${kind}`).data.features.length, 0)
        state.props.areaLayers = layers()
        state.props.areaLayers.water = { status: 'ERROR', data: null, message: 'Недоступно' }
        await vue.nextTick()
        assert.equal(state.map.getSource('area-water').data.features.length, 0)
        assert.equal(state.map.getSource('area-parks').data.features.length, 1)
    } finally { state.dispose() }
})

test('legend separates source version from unknown observation, empty results, partial coverage, missing geometry and loading', async () => {
    const enabled = { parks: true, vegetation: true, water: true }
    const data = layers()
    const normal = await render({ visibility: enabled, layers: data })
    for (const text of ['Парки','Растительные территории','Водные объекты','OpenStreetMap contributors','ODbL','18.10.2026','наблюдение: неизвестна','независимые признаки']) assert.ok(normal.includes(text), text)
    assert.doesNotMatch(normal, /не найдены контуры/)
    data.parks = layer(null)
    data.vegetation = layer(null, 'UNKNOWN')
    data.water = layer('osm:way:2', 'PARTIAL')
    const gaps = await render({ visibility: enabled, layers: data })
    assert.equal((gaps.match(/не найдены контуры/g) ?? []).length, 1)
    assert.match(gaps, /Геометрия недоступна/)
    assert.match(gaps, /Частичное покрытие/)
    assert.match(await render({ visibility: enabled, layers: null, loading: true }), /Загрузка геометрии/)
    assert.match(await render({ visibility: enabled, layers: null }), /Геометрия слоя недоступна/)
    assert.doesNotMatch(await render({ visibility: visibility(), layers: data }), /Легенда/)
})
