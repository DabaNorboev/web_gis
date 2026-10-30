import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { registerTS } from '@vue/compiler-sfc'
import * as vue from 'vue'
import { loadComponent, loadModule } from './support/vue-component.mjs'
import { cityMapDependencies, mapDependencies } from './support/map-dependencies.mjs'

// Imported defineProps/defineEmits contracts resolve through the real tsconfig.
// Compilation/evaluation still belongs to the existing SFC loader.
registerTS(() => ts)
const path = name => fileURLToPath(new URL(`../../resources/js/${name}`, import.meta.url))
const clone = value => JSON.parse(JSON.stringify(value))
const a = { lon: 92.87, lat: 56.01 }, b = { lon: 92.91, lat: 56.03 }
const collection = features => ({ type: 'FeatureCollection', features })
const feature = (kind, p, extra = {}) => ({ type: 'Feature', properties: { kind, ...extra }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })
const tripRef = (side = 'left', placeId = 'stable-goal-7') => ({ scenario: 'addresses', side, placeId })
function trip(ref = tripRef(), sequence = 42, mode = 'walking') {
    return { trip: ref, mode, overlay: { sequence, data: collection([
        feature('original', a, { label: 'Старт' }), feature('original', b, { label: 'Цель' }),
        feature('candidate', { lon: a.lon + .001, lat: a.lat }, { key: 'S', id: `start-${sequence}` }),
        feature('candidate', { lon: b.lon + .001, lat: b.lat }, { key: '1', id: `target-${sequence}` }),
    ]) } }
}
const analysis = () => ({ analysis_area: { type: 'Polygon', coordinates: [[[92.86, 56], [92.92, 56], [92.92, 56.04], [92.86, 56]]] }, analysis_bounds: [92.86, 56, 92.92, 56.04], stops_in_radius: [{ id: 7, ...b }] })
function address(id = 'object-a') {
    return { id, label: 'Synthetic address', bounds: [a.lon, a.lat, a.lon, a.lat], objects: [{ id, ...a, geometry: feature('address', a).geometry }] }
}
function profile(id = 'object-a') {
    const group = address(id)
    return { address: { ...group, object: group.objects[0] }, point: a, map: { ...analysis(), area_layers: { parks: { status: 'READY', data: collection([]) } }, linear_layers: {} }, blocks: {} }
}

class BoundaryMap {
    constructor() { this.sources = {}; this.layers = {}; this.events = {}; this.fits = []; this.jumps = []; BoundaryMap.instances.push(this) }
    on(type, fn) { (this.events[type] ??= []).push(fn); return this }
    fire(type, event) { for (const fn of this.events[type] ?? []) fn(event) }
    addSource(id, spec) { assert.ok(!this.sources[id]); this.sources[id] = { data: clone(spec.data), setData(data) { this.data = clone(data) } } }
    getSource(id) { return this.sources[id] }
    addLayer(layer) { assert.ok(!this.layers[layer.id]); this.layers[layer.id] = clone(layer) }
    getLayer(id) { return this.layers[id] }
    removeLayer(id) { delete this.layers[id] }
    removeSource(id) { delete this.sources[id] }
    queryRenderedFeatures(_p, { layers }) { return this.hit && layers.includes('compare-road-candidates') ? [this.hit] : [] }
    addControl() {} resize() { this.resizes = (this.resizes ?? 0) + 1 }
    fitBounds(bounds, options) { this.fits.push({ bounds, options }) }
    jumpTo(value) { this.jumps.push(value) }
    getZoom() { return 14 } getBearing() { return 0 } getPitch() { return 0 }
    getContainer() { return { clientWidth: 400, clientHeight: 300 } }
    getCanvas() { return { focus() {} } }
    getCenter() { return { lng: a.lon, lat: a.lat } }
    getBounds() { return { contains: () => true } }
    setPaintProperty() {} setLayoutProperty() {} project() { return { x: 100, y: 100 } }
    remove() { this.removed = true }
}
BoundaryMap.instances = []
const click = { point: { x: 1, y: 2 }, lngLat: { lng: 92.88, lat: 56.02 } }

function harness(initial = {}) {
    const frames = [], resizes = [], emitted = [], theme = vue.ref('light'), handles = vue.ref(null)
    let city, cityBindings
    const addressUtils = loadModule(path('utils/addressMap.ts'))
    const realCity = loadComponent(path('components/map/CityMap.vue'), cityMapDependencies({
        ...mapDependencies, ...addressUtils, useMapTheme: () => ({ theme }), Map: BoundaryMap,
        NavigationControl: class {}, ScaleControl: class {}, setWorkerUrl() {}, workerUrl: 'worker', basemap: { sources: {}, layers: [] },
    }), { inlineTemplate: false, globals: {
        window: { location: { href: 'http://localhost' } }, requestAnimationFrame: fn => frames.push(fn),
        ResizeObserver: class { constructor(fn) { resizes.push(fn) } observe() {} disconnect() {} },
        MutationObserver: class { observe() {} disconnect() {} },
    } })
    // Run the real CityMap setup, lifecycle, watchers and overlay. Only its DOM
    // surface/MapLibre are controlled here; the adapter renders its real template.
    const City = { ...realCity, setup(props, ctx) {
        city = vue.getCurrentInstance()
        cityBindings = realCity.setup(props, ctx)
        cityBindings.container.value = { closest: () => null, clientWidth: 400, clientHeight: 300, getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300 }) }
        return () => vue.h('div')
    } }
    const Adapter = loadComponent(path('components/home/HomeWorkspaceMap.vue'), { '@/components/map/CityMap.vue': City }, { ssr: false })
    const props = vue.reactive({ context: { kind: 'profile', side: 'left' }, activeSide: 'left', radius: 500,
        point: null, profile: null, analysis: null, address: null,
        choice: { groups: [], selectedId: null, highlightedId: null, highlightedGroupId: null }, selectedStopId: null, selectedObject: null,
        showStops: false, areas: { parks: false, vegetation: false, water: false }, lines: { roads: false, railways: false }, focus: null, trip: null, ...initial })
    const events = Object.fromEntries(['point', 'address', 'highlightAddress', 'stop', 'object', 'street'].map(name => [`on${name[0].toUpperCase()}${name.slice(1)}`, (...args) => emitted.push([name, ...clone(args)])]))
    const node = type => ({ type, children: [] })
    const renderer = vue.createRenderer({
        createElement: node, createText: node, createComment: node,
        insert(child, parent) { parent.children.push(child); child.parent = parent },
        remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child) },
        setText() {}, setElementText() {}, patchProp() {}, parentNode: node => node.parent, nextSibling: () => null,
    })
    const count = BoundaryMap.instances.length
    const app = renderer.createApp({ setup: () => () => vue.h(Adapter, { ...props, ...events, ref: handles }) })
    app.mount(node('root'))
    const map = BoundaryMap.instances.at(-1)
    assert.equal(BoundaryMap.instances.length, count + 1)
    return { props, map, theme, resizes, emitted, handles, cityBindings,
        listeners: () => ({ ...city.vnode.props }), cityProps: () => city.props,
        async flush() {
            await vue.nextTick(); await vue.nextTick()
            while (frames.length) { frames.shift()(); await Promise.resolve() }
            await vue.nextTick()
            assert.equal(BoundaryMap.instances.length, count + 1, 'all contexts must reuse one map instance')
        },
        async load() { map.fire('load'); await this.flush() },
        dispose() { app.unmount() },
    }
}

test('one CityMap switches profile A/B, search, point and trips; address events keep explicit object identity and side', async () => {
    const h = harness({ profile: profile(), address: address() })
    try {
        await h.load()
        assert.equal(h.cityProps().profile.address.id, 'object-a')
        assert.deepEqual(h.cityProps().analysis, h.props.profile.map)
        assert.equal(h.cityProps().placeLabel, 'А')
        const stale = h.listeners()
        h.props.context = { kind: 'profile', side: 'right' }; h.props.activeSide = 'right'
        h.props.profile = profile('object-b'); h.props.address = address('object-b')
        await h.flush()
        stale.onSelectAddressObject('object-a'); assert.deepEqual(h.emitted.filter(e => e[0] === 'address'), [])
        assert.equal(h.cityProps().placeLabel, 'Б')
        h.props.choice.groups = [address('search-object')]; await h.flush()
        assert.equal(h.cityProps().profile, null)
        h.listeners().onSelectAddressObject('group-id'); h.listeners().onSelectAddressObject('search-object')
        h.listeners().onHighlightAddressObject('search-object'); h.listeners().onHighlightAddressObject(null)
        assert.deepEqual(h.emitted.filter(e => ['address', 'highlightAddress'].includes(e[0])), [
            ['address', 'right', 'search-object'], ['highlightAddress', 'right', 'search-object'], ['highlightAddress', 'right', null],
        ])
        h.props.context = { kind: 'point' }; h.props.choice.groups = []; h.props.point = b; h.props.analysis = analysis(); await h.flush()
        assert.deepEqual(h.cityProps().point, b); assert.equal(h.cityProps().profile, null)
        h.listeners().onSelect(a); h.listeners().onSelectStop(7); h.listeners().onClearStop()
        h.listeners().onSelectObject({ layer: 'parks', id: 'park-1' })
        assert.deepEqual(h.emitted.slice(-4), [['point', { kind: 'point' }, a], ['stop', 7], ['stop', null], ['object', { layer: 'parks', id: 'park-1' }]])
        h.props.trip = trip(); h.props.context = { kind: 'trip', trip: tripRef() }; await h.flush()
        assert.equal(h.cityProps().point, null); assert.equal(h.cityProps().analysis, null)
        assert.deepEqual(h.map.sources.trips.data, clone(h.props.trip.overlay.data))
        assert.equal(h.map.events.click.length, 1)
        h.props.context = { kind: 'point' }; await h.flush()
        assert.deepEqual(h.map.sources.trips.data, collection([]))
    } finally { h.dispose() }
    assert.equal(h.map.removed, true)
})

test('overlay sequence, initial loading, theme, layers, resize and context changes never fit a trip; focusTrip is explicit', async () => {
    const initial = trip(), before = clone(initial)
    const h = harness({ context: { kind: 'trip', trip: tripRef() }, trip: initial })
    try {
        assert.deepEqual(h.handles.value.centerPoint(), a)
        await h.load(); assert.equal(h.map.fits.length, 0, 'CityMap load fit must be cancelled')
        assert.deepEqual(h.map.sources.trips.data, initial.overlay.data)
        h.props.trip = trip(tripRef(), 99); await h.flush()
        h.theme.value = 'dark'; h.props.areas.parks = true; h.props.lines.roads = true; h.props.showStops = true
        h.resizes.forEach(fn => fn()); h.map.fire('style.load'); await h.flush()
        assert.equal(h.map.fits.length, 0); assert.equal(h.map.jumps.length, 0)
        const focus = h.handles.value.focusTrip(); await h.flush(); await focus
        assert.equal(h.map.fits.length, 1)
        h.props.trip = null; await h.flush(); h.props.trip = trip(tripRef(), 100); await h.flush()
        assert.equal(h.map.fits.length, 1)
        const pending = h.handles.value.focusTrip(); await vue.nextTick()
        h.props.trip = trip(tripRef(), 101); await h.flush(); await pending
        assert.equal(h.map.fits.length, 1, 'updated overlay cancels deferred explicit focus')
        const superseded = h.handles.value.focusTrip()
        h.props.context = { kind: 'trip', trip: tripRef('right') }; h.props.trip = trip(tripRef('right'), 102)
        await h.flush(); await superseded
        assert.equal(h.map.fits.length, 1, 'a queued command must not focus a different trip')
        h.handles.value.resetView(); await h.flush(); assert.equal(h.map.fits.length, 1)
        assert.deepEqual(initial, before, 'camera/display token must not overwrite the owner sequence')
    } finally { h.dispose() }
})

test('candidate events preserve stable goal, side, sequence, endpoint and original coordinate; stale rendered candidates are ignored', async () => {
    const ref = tripRef('right', 'stable-not-response-index'), h = harness({ context: { kind: 'trip', trip: ref }, activeSide: 'left', trip: trip(ref) })
    try {
        await h.load()
        const candidates = h.props.trip.overlay.data.features.filter(f => f.properties.kind === 'candidate')
        for (const [index, candidate] of candidates.entries()) {
            h.map.hit = clone(candidate); h.map.hit.geometry.coordinates[0] += .0000001
            h.map.fire('click', click)
            assert.deepEqual(h.emitted.at(-1), ['street', { context: { kind: 'trip', trip: ref }, sequence: 42,
                end: index === 0 ? 'start' : 'target', point: { lon: candidate.geometry.coordinates[0], lat: candidate.geometry.coordinates[1] } }])
        }
        const stale = h.listeners()
        h.props.trip = trip(ref, 43)
        // Until Vue delivers new props the event still carries the OLD token;
        // useHomeTrips.selectMap rejects it against the owner's current sequence.
        stale.onRoadCandidate('1', { lon: b.lon + .001, lat: b.lat })
        assert.equal(h.emitted.at(-1)[1].sequence, 42)
        h.emitted.pop()
        await h.flush(); stale.onRoadCandidate('1', { lon: b.lon + .001, lat: b.lat }); h.map.fire('click', click)
        assert.equal(h.emitted.filter(e => e[0] === 'street').length, 2, 'old tile ID cannot select the replacement overlay')
        h.props.context = { kind: 'trip', trip: tripRef('left') }; await h.flush()
        assert.deepEqual(h.map.sources.trips.data, collection([]))
        h.listeners().onRoadCandidate('1', b); assert.equal(h.emitted.filter(e => e[0] === 'street').length, 2)
    } finally { h.dispose() }
})

test('manual start, goal and street picks capture their context; late events cannot switch endpoint or scenario', async () => {
    const h = harness()
    try {
        await h.load()
        const contexts = [
            { kind: 'pick-start', scenario: 'standalone' },
            { kind: 'pick-goal', scenario: 'addresses', placeId: 'stable-goal-7' },
            { kind: 'pick-goal', scenario: 'standalone', placeId: 'standalone-8' },
            { kind: 'pick-street', trip: tripRef(), end: 'start' },
            { kind: 'pick-street', trip: tripRef(), end: 'target' },
        ]
        for (const context of contexts) {
            const stale = h.listeners(), before = h.emitted.filter(e => e[0] === 'street').length
            h.props.context = context
            await h.flush(); stale.onSelect(a)
            assert.equal(h.emitted.filter(e => e[0] === 'street').length, before)
            assert.equal(h.cityProps().tripPicking, true)
            h.map.fire('click', click)
            assert.deepEqual(h.emitted.at(-1), ['street', { context, point: { lon: click.lngLat.lng, lat: click.lngLat.lat } }])
        }
        const stale = h.listeners(), before = h.emitted.length
        h.props.context = { kind: 'point' }; await h.flush(); stale.onSelect(b)
        assert.equal(h.emitted.length, before)
        h.dispose(); stale.onSelect(b); assert.equal(h.emitted.length, before)
    } finally { if (!h.map.removed) h.dispose() }
})

test('standalone identity and endpoint come from context/key even with coincident candidates; mode changes reject old handlers', async () => {
    const ref = { scenario: 'standalone', placeId: 'standalone-stable-9' }, input = trip(ref)
    input.overlay.data.features[3].geometry.coordinates = [...input.overlay.data.features[2].geometry.coordinates]
    const h = harness({ context: { kind: 'trip', trip: ref }, trip: input })
    try {
        await h.load()
        const point = { lon: a.lon + .001, lat: a.lat }, old = h.listeners()
        old.onRoadCandidate('S', point); old.onRoadCandidate('1', point)
        assert.deepEqual(h.emitted.filter(e => e[0] === 'street').map(e => [e[1].context.trip, e[1].end]), [[ref, 'start'], [ref, 'target']])
        h.props.trip.mode = 'driving'; await h.flush()
        const count = h.emitted.length
        old.onRoadCandidate('1', point); assert.equal(h.emitted.length, count)
        h.listeners().onRoadCandidate('1', point); assert.equal(h.emitted.length, count + 1)
        const returning = h.listeners()
        h.props.context = { kind: 'point' }; await h.flush()
        h.props.context = { kind: 'trip', trip: ref }; await h.flush()
        returning.onRoadCandidate('1', point); assert.equal(h.emitted.length, count + 1, 'returning to the same goal cannot revive an old handler')
        assert.equal(h.map.fits.length, 0)
    } finally { h.dispose() }
})

test('empty initial map gains overlays and profile layers without remount; explicit focus and reset remain available', async () => {
    const h = harness()
    try {
        await h.load(); const source = h.map.sources.trips
        assert.ok(h.map.getLayer('area-parks-fill')); assert.ok(h.map.getLayer('linear-roads-line'))
        h.props.trip = trip(); h.props.context = { kind: 'trip', trip: tripRef() }; await h.flush()
        assert.equal(h.map.sources.trips, source); assert.equal(h.map.fits.length, 0)
        h.props.profile = profile(); h.props.address = address(); h.props.context = { kind: 'profile', side: 'left' }; await h.flush()
        assert.deepEqual(h.cityProps().areaLayers, h.props.profile.map.area_layers)
        const count = h.map.fits.length; h.handles.value.resetView(); await h.flush()
        assert.equal(h.map.fits.length, count + 1)
        h.cityBindings.selectedFeature.value = { layer: 'parks', id: 'park-1', name: 'Synthetic park' }; await h.flush()
        h.props.selectedObject = { layer: 'parks', id: 'park-1' }; await h.flush()
        h.props.selectedObject = null; await h.flush(); assert.equal(h.cityBindings.selectedFeature.value, null)
        assert.equal(h.map.events.click.length, 1)
    } finally { h.dispose() }
})
