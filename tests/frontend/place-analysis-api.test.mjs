import { geocodingModule } from './support/geocoding.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadModule } from './support/vue-component.mjs'
import { airSnapshot, input, keys, markSelectedSatelliteUnusable, responseFor } from './fixtures/place-analysis.mjs'
const errorsUrl = new URL('../../resources/js/api/errors.ts', import.meta.url)
const apiUrl = new URL('../../resources/js/api/placeAnalysis.ts', import.meta.url)
function setup(fetch) {
    const errors = loadModule(errorsUrl, {}, { fetch })
    return { ...errors, ...loadModule(apiUrl, { './errors': errors, './geocoding': geocodingModule(errors) }) }
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

test('only the satellite block accepts SATELLITE_READ_FAILED and leaves READY POI available', async () => {
    const response = responseFor(input, { satellite: 'ERROR', poi: 'READY' })
    response.blocks.satellite.code = 'SATELLITE_READ_FAILED'
    const api = setup(async () => new Response(JSON.stringify(response)))
    const result = await api.fetchPlaceAnalysis(input)
    assert.equal(result.blocks.satellite.status, 'ERROR')
    assert.equal(result.blocks.poi.data.count, 1)

    response.blocks.satellite.code = 'UNKNOWN_FAILURE'
    await assert.rejects(api.fetchPlaceAnalysis(input), e => e.kind === 'invalid_response')
    for (const key of ['poi', 'air']) {
        const invalid = responseFor(input, { [key]: 'ERROR' })
        invalid.blocks[key].code = 'SATELLITE_READ_FAILED'
        await assert.rejects(setup(async () => new Response(JSON.stringify(invalid))).fetchPlaceAnalysis(input), e => e.kind === 'invalid_response')
    }
})

test('a selected date without usable NDVI can carry valid imagery independently', async () => {
    const request = { ...input, date: '2024-05-07', blocks: ['satellite'] }
    const response = responseFor(request, { satellite: 'READY' })
    const data = response.blocks.satellite.data
    markSelectedSatelliteUnusable(data)
    const api = setup(async () => new Response(JSON.stringify(response)))
    const selected = (await api.fetchPlaceAnalysis(request)).blocks.satellite.data.selected
    assert.equal(selected.mean_ndvi, null)
    assert.equal(selected.mean_ndvi_reason, 'NO_USABLE_NDVI')
    assert.ok(selected.layers['true-color'])

    for (const corrupt of [
        d => d.selected.mean_ndvi = 0,
        d => d.selected.mean_ndvi_reason = null,
        d => d.selected.manifest_sha256 = 'f'.repeat(64),
        d => d.selected.layers.ndvi.tiles[0] = d.selected.layers.ndvi.tiles[0].replace('2024-05-07', '2024-08-15'),
        d => d.selected.layers.ndvi.tiles[0] = d.selected.layers.ndvi.tiles[0].replace('/ndvi/', '/true-color/'),
        d => d.selected.layers.ndvi.tileSize = 512,
        d => d.delivery_status = 'UNAVAILABLE',
        d => d.selected.coverage = d.releases[0].coverage = { ...d.selected.coverage, prepared_pixels: 0 },
    ]) {
        const invalid = structuredClone(response)
        corrupt(invalid.blocks.satellite.data)
        await assert.rejects(setup(async () => new Response(JSON.stringify(invalid))).fetchPlaceAnalysis(request), e => e.kind === 'invalid_response')
    }
    data.delivery_status = 'UNAVAILABLE'
    data.selected.layers = null
    assert.equal((await api.fetchPlaceAnalysis(request)).blocks.satellite.data.selected.layers, null)
})

const satelliteApiFixturesFile = process.env.SATELLITE_API_FIXTURES_FILE
test('PHP satellite API responses pass through the production TS validator', { skip: !satelliteApiFixturesFile }, async () => {
    const bodies = JSON.parse(readFileSync(satelliteApiFixturesFile, 'utf8'))
    const request = { place: { kind: 'point', lon: 92.9, lat: 56 }, radius_m: 1000, date: '2024-05-07' }
    const fetchResponse = (body, input = request) => setup(async () => new Response(body)).fetchPlaceAnalysis(input)
    const unusable = (await fetchResponse(bodies.unusable)).blocks.satellite.data.selected
    assert.equal(unusable.mean_ndvi, null)
    assert.equal(unusable.mean_ndvi_reason, 'NO_USABLE_NDVI')
    assert.ok(unusable.layers['true-color'])

    const withoutDelivery = (await fetchResponse(bodies.withoutDelivery)).blocks.satellite.data
    assert.equal(withoutDelivery.delivery_status, 'UNAVAILABLE')
    assert.equal(withoutDelivery.selected.layers, null)
    const ready = (await fetchResponse(bodies.ready, { ...request, date: '2026-06-06' })).blocks.satellite.data.selected
    assert.equal(ready.mean_ndvi, 0)
    assert.ok(ready.layers.ndvi)
    assert.equal((await fetchResponse(bodies.readError)).blocks.satellite.code, 'SATELLITE_READ_FAILED')

    const corrupt = JSON.parse(bodies.unusable)
    corrupt.blocks.satellite.data.selected.layers.ndvi.tiles[0] += '?unexpected=1'
    await assert.rejects(fetchResponse(JSON.stringify(corrupt)), e => e.kind === 'invalid_response')
})

test('air history validates hourly gaps, literal source time, zero and unknown QC', async () => {
    const request = { snapshot_version: airSnapshot.snapshot_version, station_id: '1001' }
    const date = '2026-08-09'
    const row = { observed_at_utc: null, qc: 'UNKNOWN' }
    const data = {
        ...airSnapshot, ...request, source: 'air.krasn.ru/project/9', last_observed_at_raw: `${date} 02:00:00`,
        rows: [
            { ...row, observed_at_raw: `${date} 00:00:00`, row_present: true, value: 0, missing_reason: null, qc_reason: 'SOURCE_QC_NOT_PROVIDED' },
            { ...row, observed_at_raw: `${date} 01:00:00`, row_present: false, value: null, missing_reason: 'SOURCE_ROW_MISSING', qc_reason: 'SOURCE_ROW_MISSING' },
            { ...row, observed_at_raw: `${date} 02:00:00`, row_present: true, value: null, missing_reason: 'SOURCE_VALUE_NULL_OR_ABSENT', qc_reason: 'SOURCE_QC_NOT_PROVIDED' },
        ],
    }
    let calls = 0
    const { fetchAirStationHistory, validateAirStationHistory } = setup(async (path, options) => {
        calls++
        assert.equal(path, `/api/v1/air/snapshots/${request.snapshot_version}/stations/1001/history`)
        assert.equal(options.cache, 'no-store')
        assert.equal(options.mode, 'same-origin')
        return Response.json(data)
    })
    assert.deepEqual(await fetchAirStationHistory(request), data)
    await assert.rejects(fetchAirStationHistory({ ...request, station_id: '1001/../../evil' }), { code: 'INVALID_REQUEST' })
    assert.equal(calls, 1)
    for (const change of [
        v => v.snapshot_version = 'f'.repeat(64), v => v.station_id = '1002', v => v.timezone = 'UTC',
        v => v.freshness = 'CURRENT', v => v.rows[0].qc = 'VALID', v => v.rows[0].value = '0',
        v => v.rows[1].value = 0, v => v.rows[1].observed_at_utc = '2026-08-09T01:00:00Z',
        v => v.rows[2].missing_reason = 'SOURCE_ROW_MISSING', v => v.rows.pop(),
        v => v.rows[1].observed_at_raw = v.rows[0].observed_at_raw,
    ]) {
        const invalid = structuredClone(data)
        change(invalid)
        assert.throws(() => validateAirStationHistory(invalid, request), { kind: 'invalid_response' })
    }
})

test('station distances accept zero with verified coordinates and reject invented distances', () => {
    const request = { ...input, blocks: ['air'] }
    const response = responseFor(request, { air: 'READY' })
    const data = response.blocks.air.data
    const located = {
        id: '1001', name: 'Synthetic station', source: 'air.krasn.ru/project/9', selected: false, group: 'unlocated', status: 'UNKNOWN',
        lon: 1, lat: 2, crs: 'EPSG:4326', coordinate_reason: 'A11_OPERATOR_MAP_INTERPRETATION',
        coordinate_provenance: { raw_file: 'raw/air-project9-api.json', source_id: '1001' }, distance_m: 0,
        latest: null, history: { status: 'UNAVAILABLE', reason: 'SOURCE_ROW_MISSING', first_observed_at_raw: null,
            last_observed_at_raw: null, row_count: 0, null_values: 0, missing_hour_bins: 3 },
    }
    data.stations = [located]
    data.counts.unlocated = 1
    const api = setup(() => assert.fail('No HTTP needed'))
    const check = () => api.validateAnalysisResponse(response, api.normalizeAnalysisInput(request)).blocks.air.data.stations[0]
    assert.equal(check().distance_m, 0)
    located.distance_m = null
    assert.equal(check().distance_m, null)
    for (const value of [-1, '0', Infinity]) {
        located.distance_m = value
        assert.throws(check, { kind: 'invalid_response' })
    }
    Object.assign(located, { lon: null, lat: null, crs: null, coordinate_reason: 'SOURCE_DATUM_CRS_UNCONFIRMED', distance_m: 0 })
    delete located.coordinate_provenance
    assert.throws(check, { kind: 'invalid_response' })
})

const airExchange = process.env.AIR_API_TEST_EXCHANGE
test('actual PHP summaries and histories pass the TypeScript validators', { skip: !airExchange }, () => {
    const api = setup(() => assert.fail('The exchange uses captured responses only'))
    for (const name of ['a11', 'synthetic', 'unavailable']) {
        const { request, summary, histories } = JSON.parse(readFileSync(`${airExchange}/${name}.json`, 'utf8'))
        const block = api.validateAnalysisResponse(summary, api.normalizeAnalysisInput(request)).blocks.air
        if (block.status === 'UNAVAILABLE') {
            assert.equal(name, 'unavailable')
            assert.equal(block.code, 'AIR_SOURCE_UNAVAILABLE')
            continue
        }
        assert.equal(block.status, 'READY')
        for (const history of histories) {
            const checked = api.validateAirStationHistory(history, {
                snapshot_version: block.data.snapshot_version, station_id: history.station_id,
            })
            assert.equal(checked.freshness, 'UNKNOWN')
            assert.equal(checked.timezone, null)
            if (name === 'synthetic') assert.deepEqual(checked.rows.map(row => [row.value, row.row_present]), [
                [0, true], [null, true], [null, false], [null, true],
            ])
        }
        const legacy = structuredClone(summary)
        for (const station of legacy.blocks.air.data.stations) {
            for (const key of ['lon', 'lat', 'crs', 'coordinate_reason', 'coordinate_provenance']) delete station[key]
        }
        const normalized = api.normalizeAnalysisInput(request)
        assert.equal(api.validateAnalysisResponse(legacy, normalized).blocks.air.status, 'READY')
        for (const [key, value] of [['lon', 181], ['lat', -91], ['distance_m', -1], ['distance_m', '0'], ['crs', 'EPSG:3857'],
            ['coordinate_reason', null], ['coordinate_provenance', { raw_file: 'raw/air-project9-api.json', source_id: '9999' }]]) {
            const invalid = structuredClone(summary)
            invalid.blocks.air.data.stations[0][key] = value
            assert.throws(() => api.validateAnalysisResponse(invalid, normalized), { kind: 'invalid_response' })
        }
    }
})
