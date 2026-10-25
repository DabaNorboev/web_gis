import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'

const { groupStopsByName } = loadModule(new URL('../../resources/js/utils/stopGroups.ts', import.meta.url))

const stop = (id, name, distance_m) => ({ id, source_id: String(id), name, distance_m, lon: 92.8 + id / 1000, lat: 56 })

test('same-name points share a presentation card, retain distinct coordinates and sort by distance', () => {
    const stops = [stop(1, 'Поликлиника', 160), stop(2, 'Другая', 100), stop(3, ' поликлиника  ', 169)]
    const original = structuredClone(stops)
    const groups = groupStopsByName(stops)
    assert.equal(groups.length, 2)
    assert.equal(groups[0].name, 'Другая')
    assert.deepEqual(groups[1].stops.map(s => s.id), [1, 3])
    assert.notEqual(groups[1].stops[0].lon, groups[1].stops[1].lon)
    assert.deepEqual(stops, original)
    assert.equal(groups.reduce((n, g) => n + g.stops.length, 0), stops.length)
})

test('different qualifiers and unnamed points remain separate; nearby points are never merged', () => {
    const groups = groupStopsByName([stop(1, 'Площадь (пр. Мира)', 50), stop(2, 'Площадь (ул. Ленина)', 50), stop(3, null, 10), stop(4, '', 10)])
    assert.equal(groups.length, 4)
    assert.deepEqual(groups.map(g => g.stops[0].id), [3, 4, 1, 2])
    assert.deepEqual(groupStopsByName([]), [])
})
