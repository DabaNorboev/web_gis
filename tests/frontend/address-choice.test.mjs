import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, loadComponent } from './support/vue-component.mjs'
import { ref } from 'vue'
import * as vue from 'vue'

const { useAddressChoice } = loadModule(new URL('../../resources/js/composables/useAddressChoice.ts', import.meta.url))
const { addressFeatures, addressBounds } = loadModule(new URL('../../resources/js/utils/addressMap.ts', import.meta.url))
const object = (id, lon = 92.9) => ({ id, lon, lat: 56, geometry: { type: 'Point', coordinates: [lon, 56] }, point_method: 'osm_node', object_type: 'address_point', levels: null })
const a = object('osm:node:1'), b = object('osm:node:2', 92.91)
const group = { id: 'address:group', label: 'Тестовая, 10', bounds: [92.9, 56, 92.91, 56], object_count: 2, objects: [a, b] }

test('search previews all returned objects without selecting a first object or group', () => {
    const state = useAddressChoice()
    state.matches.value = [group]
    assert.deepEqual(state.mapState.value.groups, [group])
    assert.equal(state.selected.value, null)
    state.chooseGroup(group)
    assert.equal(state.selected.value, null)
    assert.deepEqual(state.groups.value[0].objects, [a, b])
})
test('map and list choose the exact same ID; hover and focus never overwrite a persistent selection', () => {
    const state = useAddressChoice()
    state.matches.value = [group]
    assert.equal(state.chooseObject(b.id), true)
    assert.equal(state.pending.value, group)
    assert.equal(state.selected.value.id, b.id)
    state.highlightedId.value = a.id
    const features = addressFeatures(state.mapState.value).features
    assert.equal(features.find(f => f.properties.id === b.id).properties.selected, true)
    assert.equal(features.find(f => f.properties.id === a.id).properties.highlighted, true)
    state.highlightedId.value = null
    assert.equal(state.selected.value.id, b.id)
    assert.equal(state.chooseObject('osm:node:missing'), false)
    assert.equal(state.selected.value.id, b.id)
    state.chooseObject(a.id)
    assert.equal(state.selected.value.id, a.id)
})
test('editing or cancelling clears candidates, highlight and pending selection, but never calls analysis', () => {
    const state = useAddressChoice()
    state.chooseGroup(group); state.chooseObject(a.id); state.highlightedId.value = b.id
    state.clear()
    assert.deepEqual(state.mapState.value, { groups: [], selectedId: null, highlightedId: null, highlightedGroupId: null })
    assert.equal(state.pending.value, null)
    assert.equal(state.selected.value, null)
})
test('switching groups forgets the old choice; a single result is only committed after explicit group selection', () => {
    const state = useAddressChoice()
    state.chooseGroup(group); state.chooseObject(b.id)
    const single = { ...group, id: 'address:single', object_count: 1, objects: [a] }
    state.chooseGroup(single)
    assert.equal(state.selected.value.id, a.id)
    state.chooseGroup(group)
    assert.equal(state.selected.value, null)
})
test('map features preserve source geometry, stable IDs and distinct contours, deduplicating only identical IDs', () => {
    const polygon = { ...a, geometry: { type: 'Polygon', coordinates: [[[92.9,56],[92.91,56],[92.91,56.01],[92.9,56]]] } }
    const first = { ...group, objects: [polygon, b] }
    const features = addressFeatures({ groups: [first, { ...first, id: 'alias' }], selectedId: null, highlightedId: null, highlightedGroupId: 'alias' }).features
    assert.equal(features.length, 2)
    assert.equal(features[0].geometry, polygon.geometry)
    assert.equal(features[0].properties.highlighted, true)
    assert.equal(features[1].properties.selected, false)
    assert.deepEqual(features.map(feature => feature.properties.number), [1, 2])
    assert.deepEqual(addressBounds([group, { ...group, bounds: [92.8, 55.9, 92.905, 56.02] }]), [92.8, 55.9, 92.91, 56.02])
    assert.equal(addressBounds([]), null)
})
