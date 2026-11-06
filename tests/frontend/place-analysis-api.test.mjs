import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
import { input, keys, responseFor } from './fixtures/place-analysis.mjs'
const errorsUrl = new URL('../../resources/js/api/errors.ts', import.meta.url)
const apiUrl = new URL('../../resources/js/api/placeAnalysis.ts', import.meta.url)
function setup(fetch) {
    const errors = loadModule(errorsUrl, {}, { fetch })
    return { ...errors, ...loadModule(apiUrl, { './errors': errors }) }
}
test('POST defaults, exact point echo, separate block selection and privacy options', async () => {
    const calls = []
    const api = setup(async (url, options) => {
        calls.push({ url, options })
        return new Response(JSON.stringify(responseFor(JSON.parse(options.body))))
    })
    const result = await api.fetchPlaceAnalysis(input)
    assert.equal(calls[0].url, '/api/v1/place-analysis')
    const opts = calls[0].options
    assert.equal(opts.method, 'POST'); assert.equal(opts.cache, 'no-store'); assert.equal(opts.referrerPolicy, 'no-referrer')
    assert.equal(opts.headers['Content-Type'], 'application/json')
    assert.equal(result.date, null); assert.equal(result.radius_m, 500); assert.deepEqual(Object.keys(result.blocks), keys)
    for (const key of keys) assert.deepEqual(Object.keys((await api.fetchPlaceAnalysis({ ...input, blocks: [key] })).blocks), [key])
})
test('address echo uses resolver point, station IDs compare as sets, READY payloads validate', async () => {
    const request = { place: { kind: 'address', address_id: 'osm:way:1' }, stations: { selected_ids: ['a', 'b'] } }
    const api = setup(async () => {
        const response = responseFor(request, { poi: 'READY', satellite: 'READY', air: 'READY' })
        response.station_selection.selected_ids.reverse()
        return new Response(JSON.stringify(response))
    })
    const result = await api.fetchPlaceAnalysis(request)
    assert.equal(result.place.address.id, 'osm:way:1'); assert.equal(result.place.point.lon, .4)
    assert.equal(result.blocks.poi.data.count, 1)
})
test('foreign/incomplete echo, contour/bbox, block statuses and payloads are rejected', async () => {
    const changes = [r => delete r.analysis_area, r => delete r.analysis_bounds, r => r.analysis_version = 2,
        r => r.place.point.lon++, r => r.place.label = 'invented', r => r.place.address = {}, r => r.radius_m = 1000,
        r => r.date = '2024-01-01', r => r.station_selection.radius_m++, r => r.station_selection.selected_ids = ['x'],
        r => delete r.blocks.air, r => r.blocks.old_profile = {}, r => r.blocks.poi.data = {}, r => r.blocks.poi.status = 'PARTIAL',
        r => r.analysis_area.coordinates[0][0] = [181, 0], r => r.analysis_bounds[2] += .1,
        r => r.blocks.poi.data.items[0].identity_note = {}, r => r.blocks.poi.data.items[0].distance_m = null, r => r.blocks.poi.data.count = 2, r => delete r.blocks.poi.coverage.by_category.park,
        r => r.blocks.poi.coverage.by_category.park.status = 'PARTIAL', r => delete r.blocks.poi.method_version, r => r.calculated_at = 'unknown', r => r.blocks.poi.calculated_at = null]
    for (const change of changes) {
        const r = responseFor(input, { poi: 'READY' }); change(r)
        const api = setup(async () => new Response(JSON.stringify(r)))
        await assert.rejects(api.fetchPlaceAnalysis(input), e => e.kind === 'invalid_response')
    }
})
test('invalid inputs are rejected before fetch; normalized snapshot never mutates caller', async () => {
    let calls = 0
    const api = setup(async () => { calls++; return new Response('{}') })
    for (const extra of [{ radius_m: 199 }, { radius_m: 1001 }, { radius_m: '500' }, { radius_m: null }, { date: '2026-02-29' }, { date: 'bad' },
        { blocks: [] }, { blocks: ['poi', 'poi'] }, { stations: { selected_ids: ['x', 'x'] } }, { stations: { radius_m: 999 } }, { stations: null }, { stations: { radius_m: null } }, { stations: { selected_ids: null } }]) {
        await assert.rejects(api.fetchPlaceAnalysis({ ...input, ...extra }), e => e.status === 422)
    }
    assert.equal(calls, 0)
    const r = { ...input, stations: { selected_ids: ['x'] } }
    const normalized = api.normalizeAnalysisInput(r); normalized.stations.selected_ids.push('z')
    assert.deepEqual(r.stations.selected_ids, ['x'])
})
test('HTTP, network, invalid JSON, timeout and cancel are safe and distinct, without fallback', async () => {
    for (const status of [404, 413, 415, 422, 429, 503]) {
        const api = setup(async () => new Response(JSON.stringify({ message: 'PRIVATE_CANARY', code: status === 404 ? 'ADDRESS_NOT_FOUND' : 'SERVICE_UNAVAILABLE' }), { status, headers: { 'Retry-After': '60' } }))
        await assert.rejects(api.fetchPlaceAnalysis(input), e => e.kind === 'http' && e.status === status && !String(e).includes('PRIVATE_CANARY') && (status !== 429 || e.retryAfter === '60'))
    }
    await assert.rejects(setup(async () => { throw new Error('PRIVATE_CANARY') }).fetchPlaceAnalysis(input), e => e.kind === 'network' && !String(e).includes('PRIVATE_CANARY'))
    await assert.rejects(setup(async () => new Response('PRIVATE_CANARY')).fetchPlaceAnalysis(input), e => e.kind === 'invalid_response' && !String(e).includes('PRIVATE_CANARY'))
    for (const [name, kind] of [['AbortError', 'cancelled'], ['TimeoutError', 'timeout']]) {
        const controller = new AbortController(); controller.abort(new DOMException('PRIVATE_CANARY', name))
        await assert.rejects(setup(async () => { throw controller.signal.reason }).fetchPlaceAnalysis(input, controller.signal), e => e.kind === kind)
    }
})

test('grocery-only READY keeps unknown categories distinct from covered zero and partial results', async () => {
    for (const partial of [false, true]) {
        const r = responseFor(input, { poi: 'READY' })
        const b = r.blocks.poi
        b.coverage.status = partial ? 'PARTIAL' : 'UNKNOWN'
        b.coverage.by_category.grocery.status = partial ? 'PARTIAL' : 'COVERED'
        for (const key of ['pharmacy', 'official_stop', 'park']) b.coverage.by_category[key].status = 'UNKNOWN'
        b.data = { items: [], count: null, counts_by_category: { grocery: partial ? null : 0, pharmacy: null, official_stop: null, park: null } }
        const api = setup(async () => new Response(JSON.stringify(r)))
        const response = await api.fetchPlaceAnalysis(input)
        assert.equal(response.blocks.poi.data.counts_by_category.grocery, partial ? null : 0)
        assert.equal(response.blocks.poi.data.counts_by_category.pharmacy, null)
    }
})

test('satellite catalog, selected observation, raster descriptors and legend validate without POI or air', async () => {
    const catalogRequest = { ...input, blocks: ['satellite'] }
    let api = setup(async () => new Response(JSON.stringify(responseFor(catalogRequest, { satellite: 'READY' }))))
    let result = await api.fetchPlaceAnalysis(catalogRequest)
    assert.equal(result.blocks.satellite.data.selected.reason, 'DATE_NOT_SELECTED')
    assert.equal(result.blocks.satellite.data.available_dates.length, 2)
    assert.equal(result.blocks.satellite.data.available_dates[0].warnings[0].code, 'EARLY_SPRING_SNOW')

    const selectedRequest = { ...input, date: '2024-05-07', blocks: ['satellite'] }
    api = setup(async () => new Response(JSON.stringify(responseFor(selectedRequest, { satellite: 'READY' }))))
    result = await api.fetchPlaceAnalysis(selectedRequest)
    const data = result.blocks.satellite.data
    assert.equal(data.selected.status, 'READY'); assert.equal(data.selected.date, '2024-05-07')
    assert.equal(data.selected.layers.ndvi.maxzoom, 13); assert.equal(data.selected.layers['true-color'].tileSize, 256)
    assert.equal(data.selected.warnings[0].code, 'EARLY_SPRING_SNOW')
    assert.match(data.selected.layers.ndvi.tiles[0], /^\/api\/v1\/satellite\/[a-f0-9]{64}\/2024-05-07\/ndvi/)
    assert.equal(data.legend.version, 'ndvi-fixed-v2'); assert.equal(data.legend.unknown.label, 'Неизвестно / исключено маской')

    const missingRequest = { ...input, date: '2024-02-29', blocks: ['satellite'] }
    api = setup(async () => new Response(JSON.stringify(responseFor(missingRequest, { satellite: 'READY' }))))
    result = await api.fetchPlaceAnalysis(missingRequest)
    assert.equal(result.blocks.satellite.data.selected.reason, 'DATE_NOT_IN_CATALOG')
    assert.equal(result.blocks.satellite.data.selected.layers, null)
})

test('malformed satellite descriptors, legend, selected release and coverage fractions are rejected', async () => {
    const request = { ...input, date: '2024-05-07', blocks: ['satellite'] }
    const changes = [
        r => delete r.blocks.satellite.data.legend,
        r => r.blocks.satellite.data.legend.classes[0].min = -2,
        r => r.blocks.satellite.data.legend.classes[1].min = 0.1,
        r => r.blocks.satellite.data.legend_version = 'other-legend',
        r => r.blocks.satellite.data.selected.layers.ndvi.maxzoom = 14,
        r => r.blocks.satellite.data.selected.layers.ndvi.tileSize = 512,
        r => r.blocks.satellite.data.selected.layers.ndvi.tiles[0] = '/api/v1/satellite/short/2024-05-07/ndvi/{z}/{x}/{y}.png',
        r => r.blocks.satellite.data.selected.coverage.usable_fraction = 1.2,
        r => r.blocks.satellite.data.selected.coverage.prepared_pixels = 99999,
        r => r.blocks.satellite.data.selected.mean_ndvi = 2,
        r => r.blocks.satellite.data.selected.date = '2024-08-15',
        r => r.blocks.satellite.data.selected.status = 'ERROR',
        r => r.blocks.satellite.data.selected.warnings[0].code = 'not-a-code',
        r => r.blocks.satellite.data.available_dates[0].manifest_sha256 = 'short',
        r => r.blocks.satellite.data.releases[0].coverage = null,
        r => r.blocks.satellite.data.delivery_status = 'MAYBE',
    ]
    for (const change of changes) {
        const response = responseFor(request, { satellite: 'READY' }); change(response)
        const api = setup(async () => new Response(JSON.stringify(response)))
        await assert.rejects(api.fetchPlaceAnalysis(request), e => e.kind === 'invalid_response')
    }
})
