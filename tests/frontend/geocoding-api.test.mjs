import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
import { candidate, selection, envelope, id } from './fixtures/geocoding.mjs'
import { responseFor } from './fixtures/place-analysis.mjs'
const errors = loadModule(new URL('../../resources/js/api/errors.ts', import.meta.url))
const geo = loadModule(new URL('../../resources/js/api/geocoding.ts', import.meta.url), { './errors': errors })
const api = loadModule(new URL('../../resources/js/api/placeAnalysis.ts', import.meta.url), { './errors': errors, './geocoding': geo })
const request = { request_id: id, q: 'Синтетическая улица 10', mode: 'search' }
const c = candidate(), selected = selection(c)
test('candidate and selection require matching request, original point, number, scope and attribution', () => {
    const result = envelope(request, { status: 'OK', reason: null, candidates: [c] })
    assert.equal(geo.validateGeocodingResponse(result, 'search', request).data.candidates[0].candidate_id, id)
    for (const mutate of [v => v.meta.request_id = 'other', v => v.data.candidates[0].point.lon = Infinity,
        v => v.data.candidates[0].precision.accuracy_m = 1, v => v.meta.attribution[0].url = 'javascript:alert(1)',
        v => v.data.candidates[0].number_match = 'MISMATCH']) {
        const bad = structuredClone(result); mutate(bad)
        assert.throws(() => geo.validateGeocodingResponse(bad, 'search', request), errors.ApiRequestError)
    }
    const confirmed = envelope(request, selected)
    assert.equal(geo.validateGeocodingResponse(confirmed, 'confirm', request, c).data.place.label, c.label)
    for (const mutate of [v => v.data.place.point.lon += .001, v => v.data.place.label = 'changed', v => v.data.place.address.components.number.raw = '100', v => v.data.place.address.scope_sha256 = 'b'.repeat(64)]) {
        const bad = structuredClone(confirmed); mutate(bad)
        assert.throws(() => geo.validateGeocodingResponse(bad, 'confirm', request, c))
    }
})
test('optional district survives confirmation and remains part of the snapshot', () => {
    const withDistrict = candidate({ components: { ...c.components, district: 'Условный район' } })
    const result = envelope(request, { status: 'OK', reason: null, candidates: [withDistrict] })
    assert.doesNotThrow(() => geo.validateGeocodingResponse(result, 'search', request))
    const confirmed = envelope(request, selection(withDistrict))
    assert.doesNotThrow(() => geo.validateGeocodingResponse(confirmed, 'confirm', request, withDistrict))
    const changed = structuredClone(confirmed)
    delete changed.data.place.address.components.district
    assert.throws(() => geo.validateGeocodingResponse(changed, 'confirm', request, withDistrict))
    const malformed = structuredClone(result)
    malformed.data.candidates[0].components.district = { text: 'Условный район' }
    assert.throws(() => geo.validateGeocodingResponse(malformed, 'search', request))
})
test('reverse must echo exact input and preserve house distance limit', () => {
    const r = { request_id: id, lon: .4, lat: .5 }
    const result = envelope(r, { status: 'OK', reason: null, point: { lon: .4, lat: .5 }, candidates: [{ ...c, number_match: 'NOT_REQUESTED', reference_distance_m: 12 }] })
    assert.doesNotThrow(() => geo.validateGeocodingResponse(result, 'reverse', r))
    result.data.point.lon += .0001
    assert.throws(() => geo.validateGeocodingResponse(result, 'reverse', r))
})
test('reconfirm cannot change the snapshot, identity or seven-day ceiling', () => {
    const renewed = { ...selected, selection_token: 'SYNTHETIC_RENEWED' }
    assert.doesNotThrow(() => geo.validateGeocodingResponse(envelope(request, renewed), 'reconfirm', request, selected))
    for (const mutate of [v => v.snapshot_expires_at = new Date(Date.parse(v.snapshot_expires_at) + 1000).toISOString(), v => v.place.address.source.received_at = new Date().toISOString(), v => v.selection_id = 'a2345678-1234-4234-8234-123456789012']) {
        const bad = structuredClone(renewed); mutate(bad)
        assert.throws(() => geo.validateGeocodingResponse(envelope(request, bad), 'reconfirm', request, selected))
    }
})
test('v2 echoes complete immutable place; wire contains token and version, not expected snapshot', async () => {
    const input = { analysis_version: 2, place: { kind: 'address', selection_token: selected.selection_token }, expected_place: selected.place, blocks: ['poi'] }
    const normalized = api.normalizeAnalysisInput(input)
    const base = responseFor({ place: { kind: 'point', ...c.point }, blocks: ['poi'] })
    const response = { ...base, analysis_version: 2, place: selected.place }
    assert.doesNotThrow(() => api.validateAnalysisResponse(response, normalized))
    for (const mutate of [v => v.analysis_version = 1, v => v.place.point.lon += .1, v => v.place.address.source.attribution.pop(), v => v.place.selection_id = 'other']) {
        const bad = structuredClone(response); mutate(bad)
        assert.throws(() => api.validateAnalysisResponse(bad, normalized))
    }
    let sent
    const original = globalThis.fetch
    globalThis.fetch = async (url, options) => { sent = { url, ...options }; return { ok: true, json: async () => response } }
    try { await api.fetchPlaceAnalysis(input) } finally { globalThis.fetch = original }
    const wire = JSON.parse(sent.body)
    assert.equal(wire.analysis_version, 2); assert.equal(wire.expected_place, undefined)
    assert.deepEqual(wire.place, input.place); assert.equal(sent.cache, 'no-store'); assert.equal(sent.referrerPolicy, 'no-referrer')
})
