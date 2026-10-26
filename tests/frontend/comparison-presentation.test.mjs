import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
const presentation = loadModule(new URL('../../resources/js/utils/profilePresentation.ts', import.meta.url))
const { bothBeyondRadius } = loadModule(new URL('../../resources/js/utils/comparisonPresentation.ts', import.meta.url), { './profilePresentation': presentation })
const distance = value => ({ value, quality: { availability: 'AVAILABLE' } })
const covered = { status: 'COVERED' }

test('comparison folds a distant pair only with two available results and confirmed coverage on both sides', () => {
    assert.equal(bothBeyondRadius(distance(501), distance(900), covered, covered, 500), true)
    for (const value of [0, 499, 500, null]) assert.equal(bothBeyondRadius(distance(value), distance(900), covered, covered, 500), false)
    for (const status of ['UNKNOWN', 'PARTIAL', 'OUTSIDE_SERVICE_AREA']) {
        assert.equal(bothBeyondRadius(distance(501), distance(900), { status }, covered, 500), false)
        assert.equal(bothBeyondRadius(distance(501), distance(900), covered, { status }, 500), false)
    }
    assert.equal(bothBeyondRadius(undefined, distance(900), covered, covered, 500), false)
    for (const availability of ['INSUFFICIENT_DATA', 'UNAVAILABLE']) assert.equal(bothBeyondRadius({ value: 900, quality: { availability } }, distance(900), covered, covered, 500), false)
})

import { profile, places } from '../browser/fixtures.mjs'
const { profileSources } = presentation
test('comparison provenance includes displayed areas without merging different methods or changing profile defaults', () => {
    const data = profile(places.a)
    data.blocks.parks.data.metrics.area.quality = { method: 'PROXY', availability: 'AVAILABLE', freshness: 'STALE', reason: 'Особый метод площади.' }
    data.blocks.parks.data.metrics.area.observed_at = '2025-01-01T00:00:00Z'
    const defaults = profileSources(data)
    assert.equal(defaults.rows.flatMap(row => row.labels).some(label => label.endsWith('площадь')), false)
    const compared = profileSources(data, { includeAreas: true })
    const area = compared.sections.find(section => section.metric.quality.method === 'PROXY')
    assert.ok(area)
    assert.equal(area.metric.observed_at, '2025-01-01T00:00:00Z')
    assert.equal(area.metric.quality.freshness, 'STALE')
    assert.deepEqual(area.rows.flatMap(row => row.labels), ['Ближайший парк · площадь'])
    assert.equal(defaults.rows.flatMap(row => row.labels).length + 3, compared.rows.flatMap(row => row.labels).length)
})
