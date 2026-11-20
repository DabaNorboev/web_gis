export const attribution = [{ text: 'Powered by Geoapify', url: 'https://www.geoapify.com/' }, { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' }]
export const id = '12345678-1234-4234-8234-123456789012'
export const iso = offset => new Date(Date.now() + offset).toISOString()
export function candidate(overrides = {}) {
    return { candidate_id: id, provider_id: 'synthetic-address', label: 'Синтетическая улица, 10',
        components: { country_code: 'ru', locality: 'Синтетический город', street: 'Синтетическая улица', number: {
            raw: '10', key: '10', base: '10', fraction: null, letter: null, corpus: null, structure: null, parse_status: 'COMPLETE' } },
        point: { lon: .4, lat: .5 }, point_reason: null,
        precision: { level: 'house', reason: null, accuracy_m: null, accuracy_reason: 'NOT_VALIDATED' },
        number_match: 'EXACT', within_scope: true,
        source: { provider: 'geoapify', provider_result_type: 'building', observed_at: null, source_updated_at: null, received_at: iso(-1000), normalization_version: 1, attribution },
        can_confirm: true, restrictions: [], candidate_token: 'SYNTHETIC_CANDIDATE_NOT_A_REAL_TOKEN', expires_at: iso(900000), ...overrides }
}
export function selection(c = candidate(), overrides = {}) {
    return { selection_id: id, selection_token: 'SYNTHETIC_SELECTION_NOT_A_REAL_TOKEN', expires_at: iso(86400000), snapshot_expires_at: iso(7 * 86400000),
        place: { kind: 'address', selection_id: id, label: c.label, point: c.point, building: null,
            address: { provider_id: c.provider_id, components: c.components, precision: c.precision, number_match: c.number_match, source: c.source,
                scope_id: 'krasnoyarsk-2026-10-07', scope_sha256: 'a'.repeat(64) } }, ...overrides }
}
export function envelope(request, data, received = data.place?.address.source.received_at ?? data.candidates?.[0]?.source.received_at ?? null, cache = data.place ? 'NONE' : 'MISS') {
    return { data, meta: { contract_version: 1, request_id: request.request_id, provider: 'geoapify', scope_id: 'krasnoyarsk-2026-10-07', scope_sha256: 'a'.repeat(64), received_at: received, cache, attribution } }
}
