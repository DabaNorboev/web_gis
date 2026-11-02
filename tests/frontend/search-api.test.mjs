import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadModule } from './support/vue-component.mjs'

const { reasonRegistry, explainReason, explainRequestFailure } = loadModule(new URL('../../resources/js/search/reasons.ts', import.meta.url))
const catalogue = JSON.parse(readFileSync(new URL('../../resources/contracts/reason-codes.json', import.meta.url), 'utf8'))
const caps = { resolver_version: 1, selected_profile_version: 1 }
const clone = value => JSON.parse(JSON.stringify(value))
const address = () => ({ id: 'osm:node:1', label: 'Synthetic address', object: { id: 'osm:node:1', lon: .12, lat: .23,
    geometry: { type: 'Point', coordinates: [.12, .23] }, point_method: 'osm_node', object_type: 'address_point', levels: null },
    bounds: [.12, .23, .12, .23], source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: null, reason: 'Synthetic' })
const metric = () => ({ value: null, calculated_at: '2026-11-01T00:00:00Z', observed_at: null,
    quality: { availability: 'UNAVAILABLE', method: null } })
function selected(keys = ['parks']) {
    const data = { scope: 'selected', profile_version: 1, selected_blocks: [...keys], address: address(), point: { lon: .12, lat: .23 },
        radius_m: 300, calculated_at: '2026-11-01T00:00:00Z', blocks: {},
        map: { analysis_area: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, analysis_bounds: [0, 0, 1, 1] } }
    for (const key of keys) {
        data.blocks[key] = { status: 'READY', message: null, data: { metrics: { distance: metric() } } }
        if (key === 'transport') {
            Object.assign(data.blocks[key].data, { point: data.point, radius_m: 300, stops_in_radius: [] })
            data.map.stops_in_radius = []
        } else {
            const group = ['roads', 'railways'].includes(key) ? 'linear_layers' : 'area_layers'
            data.map[group] ??= {}
            data.map[group][key] = { status: 'READY', message: null, data: { type: 'FeatureCollection', features: [], radius_m: 300 } }
        }
    }
    return data
}
function client(fetch) {
    const errors = loadModule(new URL('../../resources/js/api/errors.ts', import.meta.url), {}, { fetch })
    return { ...errors, ...loadModule(new URL('../../resources/js/api/searchProfiles.ts', import.meta.url), { './errors': errors }),
        ...loadModule(new URL('../../resources/js/api/profiles.ts', import.meta.url), { './errors': errors }),
        ...loadModule(new URL('../../resources/js/api/trips.ts', import.meta.url), { './errors': errors }) }
}
const ok = value => ({ ok: true, json: async () => value })
const signal = () => new AbortController().signal

test('every authoritative backend code has an explicit explanation and action, independent of fallback', () => {
    const keys = Object.entries(catalogue).filter(([key]) => key !== 'version').flatMap(([namespace, codes]) => codes.map(code => `${namespace}.${code}`)).sort()
    assert.deepEqual(Object.keys(reasonRegistry).sort(), keys)
    for (const key of keys) {
        const value = reasonRegistry[key]
        assert.equal(typeof value.explanation, 'string', key)
        assert.ok(value.explanation.trim(), key)
        assert.ok(['none', 'retry', 'refine', 'inspect'].includes(value.action), key)
        assert.equal(value.action === 'none' ? value.actionLabel === null : typeof value.actionLabel === 'string', true, key)
    }
    // A runtime fallback must not make a newly added known backend code pass coverage.
    assert.equal(Object.hasOwn(reasonRegistry, 'routing.NEW_BACKEND_CODE'), false)
    assert.equal(explainReason('routing', 'NEW_BACKEND_CODE').action, 'inspect')
})

test('UNKNOWN, unknown location, and CHOOSE remain distinct without guessing an endpoint', () => {
    assert.equal(explainReason('road_choice_status', 'UNKNOWN', 'target').action, 'inspect')
    assert.equal(explainReason('road_choice_status', 'CHOOSE', 'target').action, 'refine')
    assert.equal(explainReason('road_choice_status', 'CHOOSE', 'unknown').action, 'inspect')
    assert.equal(explainReason('routing', 'SNAP_THROUGH_BUILDING', 'route').action, 'inspect')
    assert.equal(explainReason('routing', 'OUTSIDE_CONFIRMED_COVERAGE', 'target').action, 'none')
    assert.equal(explainReason('routing', 'ROUTER_UNAVAILABLE').action, 'retry')
})

test('resolver validates exact identity and exposes capabilities without asking for a profile', async () => {
    let seen
    const api = client(async (url, options) => { seen = { url, options }; return ok({ address: address(), capabilities: caps }) })
    const result = await api.resolveAddress('osm:node:1', signal())
    assert.deepEqual(result.capabilities, caps)
    assert.equal(seen.url, '/api/v1/addresses/osm%3Anode%3A1')
    assert.equal(seen.options.cache, 'no-store'); assert.equal(seen.options.referrerPolicy, 'no-referrer')
    await assert.rejects(api.resolveAddress('address:group', signal()), e => e.kind === 'http' && e.status === 422)
    for (const mutate of [v => { v.address.id = 'osm:node:2' }, v => { v.address.object.lon = NaN },
        v => { v.address.object.geometry = { type: 'Polygon', coordinates: [] } }, v => { v.capabilities.selected_profile_version = 2 }]) {
        const value = { address: address(), capabilities: { ...caps } }; mutate(value)
        await assert.rejects(client(async () => ok(value)).resolveAddress('osm:node:1', signal()), e => e.kind === 'invalid_response')
    }
})

test('selected request declares exact blocks/version/radius and does not fall back to full profile', async () => {
    const seen = [], value = selected(['parks', 'roads'])
    const api = client(async (url, options) => { seen.push({ url, options }); return ok(value) })
    assert.deepEqual(await api.fetchSelectedAddressProfile('osm:node:1', 300, ['parks', 'roads'], caps, signal()), value)
    const query = new URL(seen[0].url, 'https://synthetic.invalid').searchParams
    assert.deepEqual(query.getAll('blocks[]'), ['parks', 'roads'])
    assert.equal(query.get('profile_version'), '1'); assert.equal(query.get('scope'), 'selected')
    assert.equal(query.get('radius_m'), '300')
    assert.equal(seen[0].options.referrerPolicy, 'no-referrer')
    for (const [blocks, capabilities] of [[[], caps], [['parks', 'parks'], caps], [['bogus'], caps], [['parks'], {}]]) {
        await assert.rejects(api.fetchSelectedAddressProfile('osm:node:1', 300, blocks, capabilities, signal()), e => e.kind === 'http')
    }
    assert.equal(seen.length, 1)
})

test('selected response cannot masquerade as another scope, identity, radius or block set', async () => {
    const mutations = [v => { delete v.scope }, v => { v.profile_version = 2 }, v => { v.radius_m = 500 },
        v => { v.address.id = 'osm:node:2' }, v => { v.point.lon += .01 },
        v => { v.selected_blocks = ['water'] }, v => { v.blocks.water = v.blocks.parks },
        v => { delete v.blocks.parks }, v => { v.blocks.parks.data.metrics.distance.value = NaN },
        v => { delete v.blocks.parks.data.metrics.distance.calculated_at },
        v => { v.map.area_layers.water = v.map.area_layers.parks }, v => { v.map.area_layers.parks.data.radius_m = 500 },
        v => { v.map.stops_in_radius = [] }]
    for (const mutate of mutations) {
        const value = selected(); mutate(value)
        await assert.rejects(client(async () => ok(value)).fetchSelectedAddressProfile('osm:node:1', 300, ['parks'], caps, signal()), e => e.kind === 'invalid_response')
    }
})

test('partial error carries its own code and does not erase ready blocks or rewrite their timestamps', async () => {
    const value = selected(['parks', 'water'])
    const error = { status: 'ERROR', code: 'BLOCK_CALCULATION_FAILED', data: null, message: 'Synthetic failure' }
    value.blocks.water = error; value.map.area_layers.water = clone(error)
    const result = await client(async () => ok(value)).fetchSelectedAddressProfile('osm:node:1', 300, ['parks', 'water'], caps, signal())
    assert.equal(result.blocks.parks.status, 'READY')
    assert.equal(result.blocks.parks.data.metrics.distance.calculated_at, '2026-11-01T00:00:00Z')
    assert.equal(result.blocks.water.code, 'BLOCK_CALCULATION_FAILED')
    const transport = selected(['transport'])
    await client(async () => ok(transport)).fetchSelectedAddressProfile('osm:node:1', 300, ['transport'], caps, signal())
    transport.blocks.transport.data.radius_m = 500
    await assert.rejects(client(async () => ok(transport)).fetchSelectedAddressProfile('osm:node:1', 300, ['transport'], caps, signal()), e => e.kind === 'invalid_response')
})

test('HTTP errors retain status/code/Retry-After without raw response text and preserve legacy profile error', async () => {
    for (const [status, code] of [[404, 'ADDRESS_NOT_FOUND'], [422, 'INVALID_REQUEST'], [429, 'RATE_LIMITED'], [503, 'ADDRESS_SOURCE_UNAVAILABLE']]) {
        const api = client(async () => ({ ok: false, status, headers: { get: () => '12' }, json: async () => ({ code, message: 'Synthetic private body' }) }))
        await assert.rejects(api.resolveAddress('osm:node:1', signal()), e => e.kind === 'http' && e.status === status && e.code === code && e.retryAfter === '12' && !e.message.includes('private'))
        await assert.rejects(api.fetchAddressProfile('osm:node:1', 300, signal()), e => e instanceof api.ProfileRequestError && e.status === status)
        await assert.rejects(api.fetchTrips({ mode: 'driving', start: { lon: .12, lat: .23 }, places: [] }, signal()), e => e.kind === 'http' && e.status === status && e.retryAfter === '12')
    }
})

test('network, timeout, cancellation and malformed JSON remain separate failures', async () => {
    for (const [error, kind] of [[new Error('Synthetic personal URL'), 'network'], [{ name: 'TimeoutError' }, 'timeout'], [{ name: 'AbortError' }, 'cancelled']]) {
        await assert.rejects(client(async () => { throw error }).resolveAddress('osm:node:1', signal()), e => e.kind === kind && !e.message.includes('personal'))
    }
    await assert.rejects(client(async () => ({ ok: true, json: async () => { throw new Error('Synthetic raw JSON') } })).resolveAddress('osm:node:1', signal()), e => e.kind === 'invalid_response' && !e.message.includes('raw'))
})


test('request explanation uses status/code and transport kind, never a guessed message', () => {
    const failure = { kind: 'http', status: 429, code: null }
    assert.equal(explainRequestFailure('routing', failure), reasonRegistry['http.RATE_LIMITED'])
    assert.equal(explainRequestFailure('resolver', { ...failure, status: 404, code: 'ADDRESS_NOT_FOUND' }).action, 'refine')
    assert.equal(explainRequestFailure('routing', { ...failure, code: 'FUTURE_UNKNOWN_CODE' }).action, 'inspect')
    assert.equal(explainRequestFailure('routing', { kind: 'cancelled', status: null, code: null }).action, 'none')
    assert.notEqual(explainRequestFailure('routing', { kind: 'network', status: null, code: null }).explanation,
        explainRequestFailure('routing', { kind: 'timeout', status: null, code: null }).explanation)
})
