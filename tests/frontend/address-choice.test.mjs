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

// Exercise the real component's event handlers with Vue's in-memory host renderer.
// Browser tests additionally cover native Enter activation and MapLibre hit testing.
test('picker commits list and map clicks immediately while focus and incoming results only preview', async () => {
    const stub = (_, { attrs }) => vue.h('search-stub', attrs)
    const component = loadComponent(new URL('../../resources/js/components/AddressPicker.vue', import.meta.url), {
        '@/composables/useAddressChoice': { useAddressChoice }, '@/components/AddressSearch.vue': stub, '@/components/map/CityMap.vue': stub,
    }, { ssr: false })
    const node = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null })
    const renderer = vue.createRenderer({
        createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
        setText: (el, text) => { el.text = text }, setElementText: (el, text) => { el.text = text; el.children = [] },
        patchProp: (el, key, _, value) => { el.props[key] = value },
        insert(el, parent, anchor = null) {
            if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
            const index = anchor ? parent.children.indexOf(anchor) : -1
            parent.children.splice(index < 0 ? parent.children.length : index, 0, el); el.parent = parent
        },
        remove(el) { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null },
        parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
    })
    const root = node('root'), instance = vue.ref(), selections = [], previews = []
    const app = renderer.createApp({ render: () => vue.h(component, { ref: instance, selectedId: 'osm:node:old', externalMap: true, onSelect: id => selections.push(id), onMapState: state => previews.push(state) }) })
    const all = el => [el, ...el.children.flatMap(all)]
    const search = () => all(root).find(el => el.tag === 'search-stub')
    const button = id => all(root).find(el => el.tag === 'button' && el.props.id?.endsWith(id))
    app.mount(root)
    try {
        search().props.onResults([group]); await vue.nextTick()
        assert.deepEqual(selections, [])
        search().props.onSelect(group); await vue.nextTick()
        assert.equal(previews.at(-1).selectedId, null)
        button(b.id).props.onFocus(); await vue.nextTick()
        assert.equal(previews.at(-1).highlightedId, b.id)
        assert.deepEqual(selections, [])
        instance.value.highlightObjectById(a.id); await vue.nextTick()
        assert.equal(previews.at(-1).highlightedId, a.id)
        assert.deepEqual(selections, [])
        instance.value.highlightObjectById(null); await vue.nextTick()
        assert.equal(previews.at(-1).highlightedId, null)
        button(b.id).props.onClick(); await vue.nextTick()
        assert.deepEqual(selections, [b.id])
        assert.equal(button(b.id).props['aria-pressed'], true)
        instance.value.selectObjectById(a.id); await vue.nextTick()
        assert.deepEqual(selections, [b.id, a.id])
        instance.value.selectObjectById('missing'); await vue.nextTick()
        assert.deepEqual(selections, [b.id, a.id])
        assert.ok(all(root).every(el => !el.text.includes('Подтвердить выбранный адрес')))
        const single = { ...group, objects: [a], object_count: 1 }
        search().props.onEdit(); search().props.onResults([single]); await vue.nextTick()
        assert.deepEqual(selections, [b.id, a.id])
        search().props.onSelect(single); await vue.nextTick()
        assert.deepEqual(selections, [b.id, a.id, a.id])
    } finally { app.unmount() }
})
