import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadModule } from './support/vue-component.mjs'
import { personalUtils, stateModule } from './support/comparison-trips-dependencies.mjs'

const comparison = loadModule(new URL('../../resources/js/utils/comparison.ts', import.meta.url))
const point = { lon: 92.9, lat: 56.02 }
const link = () => ({ version: 1, places: [{ id: 'goal', label: 'Synthetic', point: { ...point } }], roads: {} })
const fragment = value => personalUtils.comparisonTripsFragment(value)
const query = '?left=osm%3Away%3A1&right=osm%3Away%3A2&radius_m=500'
function harness(hash = fragment(link()), ready = true) {
    const mounted = [], cleanup = [], writes = [], calls = [], effects = [], listeners = new Map(), profiles = []
    const scope = vue.effectScope()
    const hooks = { ...vue, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => cleanup.push(fn) }
    const win = {
        location: new URL('https://synthetic.invalid/compare' + query + hash),
        history: Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_state, _title, url) => {
            writes.push(method); win.location = new URL(url, win.location)
        }])),
        addEventListener(name, fn) { assert.equal(listeners.has(name), false); listeners.set(name, fn) },
        removeEventListener(name, fn) { assert.equal(listeners.get(name), fn); listeners.delete(name) },
    }
    const module = loadModule(new URL('../../resources/js/composables/useComparisonLink.ts', import.meta.url), {
        vue: hooks, '@/utils/comparison': comparison, '@/utils/comparisonTrips': personalUtils,
    }, { window: win })
    const useAddressComparison = loadModule(new URL('../../resources/js/composables/useAddressComparison.ts', import.meta.url), {
        vue: hooks, '@/api/profiles': { fetchAddressProfile: (id, radius) => new Promise(resolve => profiles.push({ id, radius, resolve })) },
    }).useAddressComparison
    let state, addresses, owner
    scope.run(() => {
        state = stateModule((selection, signal) => new Promise(resolve => calls.push({ selection, signal, resolve })), hooks).useComparisonTrips()
        addresses = useAddressComparison(comparison.parseComparison(win.location.search), value => owner.saveAddresses(value))
        if (ready) for (const side of ['left', 'right']) addresses.sides[side].profile = profile(addresses.sides[side].id)
        owner = module.useComparisonLink(addresses, state, {
            changed: () => effects.push('changed'), restored: personal => effects.push(personal ? 'personal' : 'empty'), addressesRestored: () => effects.push('addresses'),
        })
        mounted.forEach(fn => fn())
    })
    function profile(id, radius = 500) { return { address: { id }, point: { ...point }, radius_m: radius } }
    function navigate(search, hash, events = ['popstate', 'hashchange']) {
        win.location = new URL('/compare' + search + hash, win.location)
        events.forEach(name => listeners.get(name)?.())
    }
    function resolveProfiles() { profiles.splice(0).forEach(p => p.resolve(profile(p.id, p.radius))) }
    function dispose() {
        cleanup.forEach(fn => fn()); scope.stop()
        for (const call of calls) call.resolve({ results: [], source: null, limitation: '' })
    }
    return { state, addresses, owner, calls, writes, effects, win, listeners, navigate, resolveProfiles, dispose }
}
const tick = () => vue.nextTick()

test('direct link and reload restore stable IDs and roads, revalidate once per side and never write history', async () => {
    const value = link(); value.roads.left = { goal: { start: { ...point }, target: { ...point } } }
    for (let reload = 0; reload < 2; reload++) {
        const h = harness(fragment(value))
        try {
            await tick()
            assert.equal(h.calls.length, 2); assert.equal(h.writes.length, 0)
            assert.equal(h.state.places.value[0].id, 'goal')
            assert.equal(h.calls[0].selection.start.road.lon, point.lon)
            assert.equal(h.calls[0].selection.places[0].road.lat, point.lat)
            assert.equal(h.listeners.size, 2)
            assert.equal(new URL(h.owner.shareUrl.value).hash, '')
            assert.ok(new URL(h.owner.personalShareUrl.value).hash.startsWith('#places='))
        } finally { h.dispose() }
        assert.equal(h.listeners.size, 0)
    }
})

test('rename replaces, geometry pushes, fragment navigation retains query and paired events restore only once', async () => {
    const h = harness()
    try {
        await tick()
        h.state.places.value[0].label = 'Renamed'; await tick()
        assert.deepEqual(h.writes, ['replaceState']); assert.equal(h.calls.length, 2)
        const renamed = h.win.location.hash
        h.state.setPoint('goal', { lon: 92.91, lat: 56.02 }); await tick()
        assert.deepEqual(h.writes, ['replaceState', 'pushState'])
        h.navigate(query, renamed); await tick()
        assert.equal(h.calls.length, 4); assert.equal(h.writes.length, 2)
        assert.equal(h.state.places.value[0].point.lon, point.lon)
        assert.equal(h.win.location.search, query)
        h.navigate(query, fragment({ ...link(), places: [{ ...link().places[0], point: { lon: 92.91, lat: 56.02 } }] })); await tick()
        assert.equal(h.calls.length, 6); assert.equal(h.writes.length, 2)
    } finally { h.dispose() }
})

test('query edits preserve fragment, radius never routes, replacing only A invalidates only A and history rechecks only A', async () => {
    const h = harness()
    try {
        await tick()
        const hash = h.win.location.hash, right = h.state.cell('right', 'goal'), epoch = right.epoch
        h.addresses.setRadius(300); h.resolveProfiles(); await tick(); await tick()
        assert.equal(h.win.location.hash === hash, true); assert.equal(h.calls.length, 2)
        h.navigate(query, hash); h.resolveProfiles(); await tick(); await tick()
        assert.equal(h.calls.length, 2)
        h.addresses.choose('left', 'osm:way:3'); h.resolveProfiles(); await tick(); await tick()
        assert.equal(h.state.cell('right', 'goal'), right); assert.equal(right.epoch, epoch)
        assert.equal(h.calls.length, 2); assert.equal(h.win.location.hash === hash, true)
        h.navigate(query, hash); h.resolveProfiles(); await tick(); await tick()
        assert.equal(h.calls.length, 3); assert.equal(right.epoch, epoch)
    } finally { h.dispose() }
})

test('equivalent fragments and empty hints do not restore or route again', async () => {
    const h = harness()
    try {
        await tick()
        const equivalent = link(); equivalent.roads = { left: { goal: {} }, right: {} }
        const hash = '#' + new URLSearchParams({ places: JSON.stringify(equivalent) })
        h.navigate(query, hash); await tick()
        assert.equal(h.calls.length, 2); assert.equal(h.writes.length, 0)
        h.state.setRoad('left', 'goal', 'start', null); await tick()
        assert.equal(h.writes.length, 0); assert.equal(h.calls.length, 2)
    } finally { h.dispose() }
})

test('invalid, oversized and future fragments keep address selection, suppress requests and reset with one push', async () => {
    const invalidPoint = link(); invalidPoint.places[0].point.lon = 181
    const longLabel = link(); longLabel.places[0].label = 'x'.repeat(81)
    const duplicate = link(); duplicate.places.push({ ...duplicate.places[0] })
    for (const hash of [invalidPoint, longLabel, duplicate].map(value => '#places=' + encodeURIComponent(JSON.stringify(value))).concat(['#places=broken', '#places=' + 'x'.repeat(16001), '#places=' + encodeURIComponent(JSON.stringify({ ...link(), version: 99 }))])) {
        const h = harness(hash)
        try {
            await tick()
            assert.equal(h.owner.invalidPersonalLink.value, true)
            assert.equal(h.addresses.sides.left.id, 'osm:way:1'); assert.equal(h.addresses.radius.value, 500)
            assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0)
            h.owner.resetPersonal(); await tick()
            assert.deepEqual(h.writes, ['pushState']); assert.equal(h.win.location.hash, '')
        } finally { h.dispose() }
    }
})

test('delete and reset clear hints; back restores the road choice without writing and late results cannot revive removed goals', async () => {
    const h = harness()
    try {
        await tick()
        h.state.setRoad('left', 'goal', 'start', point); await tick()
        const roadHash = h.win.location.hash
        h.state.remove('goal'); await tick()
        assert.equal(h.state.places.value.length, 0)
        h.navigate(query, roadHash); await tick()
        assert.equal(h.state.cell('left', 'goal').hints.start.lon, point.lon)
        const writes = h.writes.length
        h.owner.resetPersonal(); await tick()
        assert.equal(h.writes.length, writes + 1); assert.equal(h.win.location.hash, '')
        for (const call of h.calls) call.resolve({ results: [], source: null, limitation: '' })
        await tick(); await tick()
        assert.equal(h.state.places.value.length, 0)
        assert.equal(Object.keys(h.state.cells.left).length, 0)
    } finally { h.dispose() }
})

test('new edit before restore flush wins and unmount cancels queued persistence and pending profile rechecks', async () => {
    const h = harness('', false)
    h.navigate(query, fragment(link()))
    h.state.setPoint('goal', { lon: 92.92, lat: 56.02 })
    await tick()
    assert.equal(personalUtils.parseComparisonTrips(h.win.location.hash).selection.places[0].point.lon, 92.92)
    h.addresses.load(); h.resolveProfiles(); await tick(); await tick()
    assert.equal(h.calls.length, 0)
    h.state.places.value[0].label = 'Queued'
    const writes = h.writes.length
    h.dispose(); await tick()
    assert.equal(h.writes.length, writes); assert.equal(h.listeners.size, 0)
})

test('reset immediately after restoration clears the URL even before the queued watcher runs', async () => {
    const h = harness('')
    try {
        h.navigate(query, fragment(link()))
        h.owner.resetPersonal()
        await tick()
        assert.equal(h.win.location.hash, '')
        assert.deepEqual(h.writes, ['pushState'])
        assert.equal(h.state.places.value.length, 0)
    } finally { h.dispose() }
})

test('navigation from valid goals to invalid fragment retains its warning and query after queued restore', async () => {
    const h = harness()
    try {
        await tick()
        const invalid = '#places=' + encodeURIComponent(JSON.stringify({ version: 99 }))
        h.navigate(query, invalid); await tick()
        assert.equal(h.owner.invalidPersonalLink.value, true)
        assert.equal(h.win.location.hash === invalid, true)
        assert.equal(h.addresses.sides.left.id, 'osm:way:1')
        assert.equal(h.calls.length, 2); assert.equal(h.writes.length, 0)
        h.owner.resetPersonal(); await tick()
        assert.deepEqual(h.writes, ['pushState'])
        assert.equal(h.owner.invalidPersonalLink.value, false)
    } finally { h.dispose() }
})

test('query history with unchanged personal fragment clears only obsolete A hints without adding history or restoring twice', async () => {
    const value = link(); value.roads = { left: { goal: { start: point } }, right: { goal: { target: point } } }
    const h = harness(fragment(value))
    try {
        await tick()
        const hash = h.win.location.hash
        h.navigate(query.replace('3A1', '3A3'), hash)
        h.resolveProfiles(); await tick(); await tick()
        assert.equal(h.calls.length, 3)
        assert.equal(h.writes.length, 0)
        assert.equal(h.state.cell('left', 'goal').hints.start, undefined)
        assert.equal(h.state.cell('right', 'goal').hints.target.lon, point.lon)
        assert.equal(h.win.location.hash === hash, true)
        assert.equal(h.effects.filter(value => value === 'personal').length, 1)
    } finally { h.dispose() }
})

test('walking history restores its mode and streets once while late driving responses stay discarded', async () => {
    const legacy = link()
    const oldHash = '#places=' + encodeURIComponent(JSON.stringify(legacy))
    const h = harness(oldHash)
    try {
        await tick()
        assert.equal(h.state.mode.value, 'driving')
        assert.ok(h.calls.every(call => call.selection.mode === 'driving'))
        h.state.setMode('walking'); await tick()
        assert.equal(h.calls.length, 2)
        assert.ok(h.calls.every(call => call.signal.aborted))
        assert.equal(personalUtils.parseComparisonTrips(h.win.location.hash).selection.mode, 'walking')
        assert.equal(personalUtils.parseComparisonTrips(h.win.location.hash).selection.version, 2)
        const walking = { ...link(), version: 2, mode: 'walking', roads: { left: { goal: { start: { lon: 92.91, lat: 56.02 } } } } }
        h.navigate(query, fragment(walking)); await tick()
        assert.equal(h.calls.length, 4)
        assert.equal(h.calls[2].selection.mode, 'walking')
        assert.equal(h.calls[2].selection.start.road.lon, 92.91)
        h.navigate(query, oldHash); await tick()
        assert.equal(h.state.mode.value, 'driving'); assert.equal(h.calls.length, 6)
        assert.equal(h.state.cell('left', 'goal').hints.start, undefined)
        for (const call of h.calls.slice(0, 4)) call.resolve({ mode: call.selection.mode, results: [], source: null, limitation: '' })
        await tick(); await tick()
        assert.equal(h.state.cell('left', 'goal').status, 'loading')
        assert.equal(h.state.cell('left', 'goal').row, null)
        assert.equal(h.writes.length, 1)
    } finally { h.dispose() }
})

test('mode edit cancels profile-delayed restore rechecks and does not fetch after profiles arrive', async () => {
    const h = harness(fragment(link()), false)
    try {
        h.state.setMode('walking')
        h.addresses.load(); h.resolveProfiles()
        await tick(); await tick()
        assert.equal(h.calls.length, 0)
        assert.equal(h.state.mode.value, 'walking')
        assert.equal(h.state.places.value[0].id, 'goal')
    } finally { h.dispose() }
})
