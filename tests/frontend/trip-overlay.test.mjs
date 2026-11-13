import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadModule, loadComponent } from './support/vue-component.mjs'
import { mapDependencies } from './support/map-dependencies.mjs'

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
    assert.equal(Object.keys(h.map.layers).length, 11)
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

test('overview route dispatch keeps its cell token; stale tiles and manual selection never switch a goal', () => {
    const map = new BoundaryMap(), events = []
    let data = display(), picking = false
    data.features[2].properties.entity = 'right:stable-goal:walking:epoch42'
    const control = overlay.createTripOverlay(map, { data: () => data, picking: () => picking, interactive: () => true,
        select: point => events.push(['pick', point]), candidate() { throw Error('route cannot become candidate') }, entity: id => events.push(['entity', id]) })
    control.install(); map.hit = structuredClone(data.features[2])
    assert.equal(control.click(click), true)
    assert.deepEqual(events, [['entity', 'right:stable-goal:walking:epoch42']])
    data = structuredClone(data); data.features[2].properties.entity = 'left:new-goal:driving:epoch43'
    assert.equal(control.click(click), false); assert.equal(events.length, 1)
    picking = true; assert.equal(control.click(click), true)
    assert.equal(events.length, 2); assert.equal(events[1][0], 'pick')
    assert.equal(map.fits.length, 0); control.dispose()
})


test('coincident alternatives cycle by stable goal/side identity despite tile order and selection updates', () => {
    const map = new BoundaryMap(), events = []
    const data = collection(['g2:right', 'g1:right', 'g1:left'].map(key => ({ ...display().features[2], properties: { kind: 'route', entity: key, routeKey: key } })))
    map.queryRenderedFeatures = (_point, { layers }) => layers.includes('compare-road-candidates') ? [] : [...data.features].reverse()
    const control = overlay.createTripOverlay(map, { data: () => data, picking: () => false, interactive: () => true, select() {}, candidate() {}, entity: id => events.push(id) })
    control.install()
    for (let i = 0; i < 4; i++) { control.click(click); data.features.reverse(); control.update() }
    assert.deepEqual(events, ['g1:left', 'g1:right', 'g2:right', 'g1:left'])
    assert.equal(map.fits.length, 0)
    control.dispose()
})
