import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadModule } from './support/vue-component.mjs'

const path = name => new URL(`../../resources/js/${name}.ts`, import.meta.url)
const comparison = loadModule(path('utils/comparison'))
const points = loadModule(path('utils/pointSelection'))
const links = loadModule(path('utils/homeSelection'), { '@/utils/comparison': comparison, '@/utils/pointSelection': points })
function setup() {
    const cleanups = [], requests = [], pointRequests = [], changes = []
    const hooks = { ...vue, onBeforeUnmount: fn => cleanups.push(fn) }
    const addresses = loadModule(path('composables/useAddressComparison'), {
        vue: hooks, '@/api/profiles': { fetchAddressProfile: (id, radius, signal) => new Promise((resolve, reject) => requests.push({ id, radius, signal, resolve, reject })) },
    })
    const transport = loadModule(path('composables/useTransportAnalysis'), {
        vue: hooks, '@/api/transport': { fetchTransportAnalysis: (point, radius, signal) => new Promise((resolve, reject) => pointRequests.push({ point, radius, signal, resolve, reject })) },
    })
    const { useHomeWorkspace } = loadModule(path('composables/useHomeWorkspace'), { vue: hooks, '@/composables/useAddressComparison': addresses, '@/composables/useTransportAnalysis': transport })
    const home = useHomeWorkspace(value => changes.push(value))
    const settle = async (request, error) => { if (error) request.reject(error); else request.resolve({ address: { id: request.id, label: request.id }, radius_m: request.radius }); await Promise.resolve() }
    return { home, requests, pointRequests, changes, settle, dispose() { cleanups.forEach(fn => fn()); for (const p of [...requests, ...pointRequests]) p.resolve(null) } }
}

test('root selection round-trips exact slots, shared radius, point and active context; preserves unrelated query', () => {
    const selection = { left: 'osm:way:1', right: 'osm:node:2', radius: 300, point: { lon: 92.8765432109, lat: 56.01 }, activeSide: 'right', context: 'point' }
    const url = links.homeSelectionUrl(selection, '?other=keep')
    assert.deepEqual(links.parseHomeSelection(url.split('?')[1]), { ...selection, invalid: false })
    assert.match(url, /other=keep/)
    assert.equal(links.parseHomeSelection('?lon=92&lat=56').context, 'point')
    assert.equal(links.parseHomeSelection('?lon=oops&lat=56').invalid, true)
    assert.equal(links.homeSelectionUrl({ ...selection, left: null, right: null, point: null, radius: 500 }), '/')
})

test('one profile becomes a pair without reloading A, replacement/removal and errors stay independent', async () => {
    const t = setup(), { home, requests, settle } = t
    try {
        home.chooseAddress('a'); await settle(requests[0])
        const a = home.sides.left.profile
        home.editSide('right'); home.chooseAddress('b')
        assert.equal(requests.length, 2); assert.equal(home.sides.left.profile, a)
        await settle(requests[1], Object.assign(Error(), { status: 503 }))
        assert.equal(home.sides.right.status, 'unavailable'); assert.equal(home.sides.left.profile, a)
        home.editSide('right'); home.chooseAddress('c')
        home.chooseAddress('d'); assert.equal(requests[2].signal.aborted, true)
        await settle(requests[3]); await settle(requests[2])
        assert.equal(home.sides.right.profile.address.id, 'd')
        home.removeSide('left')
        assert.deepEqual(home.selectedSides.value, ['right']); assert.equal(home.activeSide.value, 'right')
        assert.equal(home.sides.right.profile.address.id, 'd')
        assert.equal(requests.length, 4)
    } finally { t.dispose() }
})

test('shared radius invalidates both sides and retained point once; late old responses cannot return', async () => {
    const t = setup(), { home, requests, pointRequests, settle } = t
    try {
        home.chooseAddress('a'); home.editSide('right'); home.chooseAddress('b')
        void home.selectPoint({ lon: 92, lat: 56 })
        home.setRadius(300)
        assert.equal(requests.length, 4); assert.equal(pointRequests.length, 2)
        assert.equal(pointRequests[0].signal.aborted, true)
        assert.equal(home.radius.value, 300); assert.equal(pointRequests[1].radius, 300)
        for (const request of requests.slice(2)) await settle(request)
        for (const request of requests.slice(0, 2)) await settle(request)
        pointRequests[1].resolve({ radius_m: 300 }); await Promise.resolve()
        pointRequests[0].resolve({ radius_m: 500 }); await Promise.resolve()
        assert.equal(home.sides.left.profile.radius_m, 300); assert.equal(home.sides.right.profile.radius_m, 300)
        assert.equal(home.transport.analysis.value.radius_m, 300)
        home.setRadius(1000); assert.equal(requests.length, 4)
    } finally { t.dispose() }
})

test('context changes never calculate; restore has one history owner and loads only changed selection', async () => {
    const t = setup(), { home, requests, pointRequests, changes, settle } = t
    try {
        home.chooseAddress('a'); await settle(requests[0])
        home.showSide('left'); home.editSide('right')
        const pick = { kind: 'pick-street', trip: { scenario: 'addresses', side: 'left', placeId: 'p1' }, end: 'target' }
        home.activate(pick)
        assert.equal(home.context.value, pick); assert.equal(home.activeSide.value, 'left')
        assert.equal(requests.length, 1); assert.equal(pointRequests.length, 0)
        const history = changes.length
        home.restore(links.parseHomeSelection('?left=a&right=b&side=right&radius_m=500'))
        assert.equal(changes.length, history); assert.equal(requests.length, 2)
        home.restore(links.parseHomeSelection('?left=a&radius_m=500'))
        assert.equal(requests[1].signal.aborted, true)
        await settle(requests[1])
        assert.equal(home.sides.right.profile, null); assert.equal(home.sides.left.profile.address.id, 'a')
        assert.equal(changes.length, history)
    } finally { t.dispose() }
})
