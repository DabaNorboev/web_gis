import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadModule, loadComponent } from './support/vue-component.mjs'
import { cityMapDependencies, mapDependencies } from './support/map-dependencies.mjs'

const candidates = loadModule(new URL('../../resources/js/utils/tripCandidates.ts', import.meta.url))
const trips = loadModule(new URL('../../resources/js/utils/tripMap.ts', import.meta.url), { '@/utils/tripCandidates': candidates })
const overlay = loadModule(new URL('../../resources/js/utils/tripOverlay.ts', import.meta.url), { '@/utils/tripMap': trips })
const collection = features => ({ type: 'FeatureCollection', features })
const point = (kind, coordinates, properties = {}) => ({ type: 'Feature', properties: { kind, ...properties }, geometry: { type: 'Point', coordinates } })
const display = (offset = 0) => collection([
    point('original', [92.87 + offset, 56.01], { label: 'Старт А' }),
    point('original', [92.91 + offset, 56.03], { label: 'Цель' }),
    { type: 'Feature', properties: { kind: 'route', color: '#bd7229' }, geometry: { type: 'LineString', coordinates: [[92.871 + offset, 56.01], [92.911 + offset, 56.03]] } },
    point('candidate', [92.911 + offset, 56.03], { key: '1', id: `candidate-${offset}`, label: 'А · Цель · Вариант 1' }),
])
class BoundaryMap {
    constructor() { this.sources = {}; this.layers = {}; this.events = {}; this.fits = []; this.removed = false; BoundaryMap.latest = this }
    on(type, fn) { (this.events[type] ??= []).push(fn); return this }
    fire(type, event) { for (const fn of this.events[type] ?? []) fn(event) }
    addSource(id, spec) { assert.ok(!this.sources[id], `duplicate source ${id}`); this.sources[id] = { data: JSON.parse(JSON.stringify(spec.data)), setData(data) { this.data = JSON.parse(JSON.stringify(data)) } } }
    getSource(id) { return this.sources[id] }
    addLayer(layer) { assert.ok(!this.layers[layer.id], `duplicate layer ${layer.id}`); this.layers[layer.id] = structuredClone(layer) }
    getLayer(id) { return this.layers[id] }
    removeLayer(id) { delete this.layers[id] }
    removeSource(id) { assert.ok(!Object.values(this.layers).some(layer => layer.source === id)); delete this.sources[id] }
    queryRenderedFeatures() { return this.hit ? [this.hit] : [] }
    addControl() {} resize() { this.resizes = (this.resizes ?? 0) + 1 }
    fitBounds(bounds, options) { this.fits.push({ bounds, options }) }
    jumpTo() {} getZoom() { return 14 } getBearing() { return 0 } getPitch() { return 0 }
    getContainer() { return { clientWidth: 400, clientHeight: 300 } }
    getCanvas() { return { focus() {} } }
    getCenter() { return { lng: 92.87, lat: 56.01 } }
    setPaintProperty() {} setLayoutProperty() {} project() { return { x: 100, y: 100 } }
    remove() { this.removed = true }
}
const click = { point: { x: 1, y: 2 }, lngLat: { lng: 92.88, lat: 56.02 } }
function controller() {
    const map = new BoundaryMap(), events = []
    let data = display(), picking = false
    const control = overlay.createTripOverlay(map, { data: () => data, picking: () => picking,
        select: p => events.push(['select', p]), candidate: (key, p) => events.push(['candidate', key, p]) })
    return { map, control, events, data: value => { data = value }, pick: value => { picking = value } }
}

test('overlay installs current prepared data after readiness, updates, clears and restores without duplicate resources or subscriptions', () => {
    const h = controller()
    h.control.update(); assert.deepEqual(h.map.sources, {})
    h.data(display(.1)); h.control.install()
    assert.deepEqual(h.map.sources.trips.data, display(.1))
    assert.equal(Object.keys(h.map.layers).length, 9)
    const source = h.map.sources.trips
    for (let i = 0; i < 3; i++) { h.control.install(); h.control.update() }
    assert.equal(h.map.sources.trips, source); assert.deepEqual(h.map.events, {})
    h.data(null); h.control.update(); assert.deepEqual(source.data, collection([]))
    h.data(display()); h.control.update(); assert.deepEqual(source.data, display())
    assert.equal(h.map.fits.length, 0)
    h.control.dispose()
})

test('overlay candidates and manual point selection dispatch exactly once with manual selection taking precedence', () => {
    const h = controller(); h.control.install(); h.map.hit = display().features[3]
    assert.equal(h.control.click(click), true)
    assert.deepEqual(h.events, [['candidate', '1', { lon: 92.911, lat: 56.03 }]])
    h.map.hit = structuredClone(h.map.hit); h.map.hit.geometry.coordinates[0] += .0000001
    h.control.click(click)
    assert.deepEqual(h.events[1], ['candidate', '1', { lon: 92.911, lat: 56.03 }], 'use original prepared coordinates, not rounded tile coordinates')
    h.events.pop()
    h.data(display(.1)); assert.equal(h.control.click(click), false)
    assert.equal(h.events.length, 1, 'a stale rendered candidate cannot select a new target')
    h.pick(true); h.control.click(click)
    assert.deepEqual(h.events[1], ['select', { lon: 92.88, lat: 56.02 }])
    h.pick(false); h.data(null); assert.equal(h.control.click(click), false)
    h.control.dispose(); h.pick(true); assert.equal(h.control.click(click), false)
    assert.equal(h.events.length, 2)
})

test('overlay cleanup only removes its resources, remains final for stale callbacks, and permits a fresh controller', () => {
    const h = controller(); h.control.install()
    h.map.addSource('stops', { data: collection([]) }); h.map.addLayer({ id: 'stops', source: 'stops' })
    h.control.dispose(); h.control.dispose(); h.control.install(); h.control.update()
    assert.deepEqual(Object.keys(h.map.sources), ['stops']); assert.deepEqual(Object.keys(h.map.layers), ['stops'])
    assert.equal(h.map.removed, false)
    const fresh = overlay.createTripOverlay(h.map, { data: () => display(), picking: () => false, select() {}, candidate() {} })
    fresh.install(); assert.deepEqual(h.map.sources.trips.data, display()); fresh.dispose()
})

test('independent controllers retain correct side data and restore latest geometry after a style reload', () => {
    const a = controller(), b = controller(); a.control.install(); b.data(display(.2)); b.control.install()
    a.data(null); a.control.update()
    assert.deepEqual(b.map.sources.trips.data, display(.2))
    b.map.sources = {}; b.map.layers = {}; b.data(display(.3)); b.control.install()
    assert.deepEqual(b.map.sources.trips.data, display(.3)); assert.equal(b.map.fits.length, 0)
    a.control.dispose(); b.control.dispose()
})

test('shared trip data retains original coordinates, separate connectors and null versus zero without inventing an unaccepted route', () => {
    const start = { lon: 92.87, lat: 56.01 }, target = { lon: 92.91, lat: 56.03 }
    const points = [{ key: 'S', point: start }, { key: '1', point: target }]
    const row = { index: 0, status: 'AVAILABLE', route: { geometry: { type: 'LineString', coordinates: [[92.871, 56.01], [92.911, 56.03]] }, distance_m: 0, duration_s: 0 }, snaps: { start: { matched: { lon: 92.871, lat: 56.01 } }, target: { matched: { lon: 92.911, lat: 56.03 } } } }
    const before = structuredClone({ points, row })
    const accepted = trips.tripMapData(points, { results: [row] })
    assert.deepEqual(accepted.features.filter(f => f.properties.kind === 'original').map(f => f.geometry.coordinates), [[start.lon, start.lat], [target.lon, target.lat]])
    assert.equal(accepted.features.filter(f => f.properties.kind === 'connector').length, 2)
    assert.equal(accepted.features.filter(f => f.properties.kind === 'route').length, 1)
    assert.deepEqual({ points, row }, before)
    for (const analysis of [null, { results: [{ ...row, route: null }] }, { results: [{ ...row, status: 'UNKNOWN', route: null }] }])
        assert.equal(trips.tripMapData(points, analysis).features.filter(f => f.properties.kind === 'route').length, 0)
    assert.equal(overlay.tripOverlayBounds(collection([])), null)
    assert.deepEqual(overlay.tripOverlayBounds(collection([point('original', [0, 0])])), [[0, 0], [0, 0]])
})

function city() {
    const mounted = [], cleanup = [], frames = [], emitted = [], theme = vue.ref('light')
    const component = loadComponent(new URL('../../resources/js/components/map/CityMap.vue', import.meta.url), {
        ...cityMapDependencies({ ...mapDependencies, useMapTheme: () => ({ theme }), Map: BoundaryMap, NavigationControl: class {}, ScaleControl: class {}, setWorkerUrl() {}, workerUrl: 'worker', basemap: { sprite: '/sprite', sources: {}, layers: [] }, addressFeatures: () => collection([]), addressBounds: () => null }),
        vue: { ...vue, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => cleanup.push(fn) },
    }, { inlineTemplate: false, globals: {
        window: { location: { href: 'http://localhost' } }, requestAnimationFrame: fn => frames.push(fn),
        ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
    } })
    const props = vue.reactive({ point: null, addressGroup: null, selectedAddressId: null, analysis: null, radius: 500, selectedStopId: null, showStops: false, selectable: false, tripOverlay: { data: display(), sequence: 1 } })
    const scope = vue.effectScope(); let exposed
    const bindings = scope.run(() => component.setup(props, { expose: value => { exposed = value }, emit: (...args) => emitted.push(args) }))
    bindings.container.value = { closest: () => null, clientWidth: 400, clientHeight: 300 }
    mounted.forEach(fn => fn()); const map = BoundaryMap.latest
    return { map, props, bindings, exposed, emitted, theme, frames, async flush() { await vue.nextTick(); await vue.nextTick(); while (frames.length) frames.shift()(); await Promise.resolve() }, dispose() { cleanup.forEach(fn => fn()); scope.stop() } }
}

test('real CityMap connects the real overlay once, keeps click priority and preserves camera on data, theme and resize updates', async () => {
    const h = city()
    try {
        h.map.fire('style.load'); assert.equal(h.map.getSource('trips'), undefined)
        h.map.fire('load'); await h.flush()
        assert.deepEqual(h.map.sources.trips.data, display()); assert.equal(h.map.fits.length, 1)
        assert.equal(h.map.events.click.length, 1)
        h.map.hit = display().features[3]; h.map.fire('click', click)
        assert.deepEqual(h.emitted.at(-1), ['roadCandidate', '1', { lon: 92.911, lat: 56.03 }])
        h.props.tripPicking = true; await vue.nextTick(); h.map.fire('click', click)
        assert.deepEqual(h.emitted.at(-1), ['select', { lon: 92.88, lat: 56.02 }])
        h.props.tripPicking = false; h.props.tripOverlay = { data: display(.1), sequence: 1 }
        await h.flush(); h.theme.value = 'dark'; await h.flush(); h.map.fire('resize'); h.map.fire('style.load'); await h.flush()
        assert.equal(h.map.fits.length, 1); assert.deepEqual(h.map.sources.trips.data, display(.1))
        h.props.tripOverlay = null; await h.flush(); assert.deepEqual(h.map.sources.trips.data, collection([]))
        h.props.tripOverlay = { data: display(.2), sequence: 2 }; await h.flush()
        assert.equal(h.map.fits.length, 2); assert.deepEqual(h.map.sources.trips.data, display(.2))
        assert.equal(h.map.events.click.length, 1)
        assert.equal(h.map.fits.at(-1).options.maxZoom, 17)
    } finally { h.dispose() }
    assert.equal(h.map.removed, true); assert.equal(h.map.getSource('trips'), undefined)
})

test('real CityMap cancels deferred route fitting on hide, reset and unmount', async () => {
    const h = city()
    try {
        h.map.fire('load'); await vue.nextTick()
        h.props.tripOverlay = null; await h.flush(); assert.equal(h.map.fits.length, 0)
        h.props.tripOverlay = { data: display(), sequence: 2 }; await vue.nextTick()
        h.exposed.resetView(); await h.flush(); assert.equal(h.map.fits.length, 0)
        h.props.tripOverlay = { data: display(.2), sequence: 3 }; await vue.nextTick()
        h.dispose(); await h.flush(); assert.equal(h.map.fits.length, 0)
    } finally { if (!h.map.removed) h.dispose() }
})
