import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'

const { parsePointSelection, pointSelectionUrl } = loadModule(new URL('../../resources/js/utils/pointSelection.ts', import.meta.url))

test('point links round-trip full analysis precision and both radii, retaining unrelated query parameters', () => {
    for (const radius of [300, 500]) {
        const selection = { point: { lon: 92.90000012345678, lat: 56.00000012345678 }, radius }
        const url = pointSelectionUrl(selection, '?campaign=demo&lon=old&lat=old&radius_m=500')
        assert.deepEqual(parsePointSelection(url.split('?')[1]), { ...selection, invalid: false })
        assert.ok(url.includes('campaign=demo'))
    }
    assert.deepEqual(parsePointSelection('lon=0&lat=0&radius_m=300'), { point: { lon: 0, lat: 0 }, radius: 300, invalid: false })
    assert.equal(pointSelectionUrl({ point: null, radius: 500 }), '/')
    assert.equal(pointSelectionUrl({ point: null, radius: 300 }, '?lon=92&lat=56'), '/?radius_m=300')
    assert.deepEqual(parsePointSelection(''), { point: null, radius: 500, invalid: false })
})
test('incomplete, duplicate, out-of-range and malformed point links never fabricate an origin', () => {
    for (const query of ['lon=92', 'lat=56', 'lon=&lat=56', 'lon=92&lat=', 'lon=NaN&lat=56', 'lon=Infinity&lat=56', 'lon=181&lat=56', 'lon=92&lat=-91', 'lon=0x10&lat=56', 'lon=92&lon=93&lat=56', 'lon=92&lat=56&radius_m=1000', 'lon=92&lat=56&radius_m=300&radius_m=500']) {
        const parsed = parsePointSelection(query)
        assert.equal(parsed.invalid, true, query)
        assert.equal(parsed.point, null, query)
    }
})
