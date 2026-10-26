import { loadModule } from './support/vue-component.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as vue from 'vue'
import { themeUtils, labelUtils } from './support/map-dependencies.mjs'

const base = JSON.parse(readFileSync(new URL('../../resources/js/maps/basemap.json', import.meta.url)))

test('nearest-object action is available only for the exact source ID present in the supplied geometry', () => {
    const { mappedNearestId } = loadModule(new URL('../../resources/js/utils/mapAnalysis.ts', import.meta.url))
    const profile = { blocks: { parks: { data: { nearest: { id:'osm:way:1' } } } }, map: { area_layers: { parks: { data: { features:[{properties:{id:'osm:way:2'}}] } } } } }
    assert.equal(mappedNearestId(profile, 'parks'), undefined)
    profile.map.area_layers.parks.data.features.push({properties:{id:'osm:way:1'}})
    assert.equal(mappedNearestId(profile, 'parks'), 'osm:way:1')
    profile.map.area_layers.parks.data = null
    assert.equal(mappedNearestId(profile, 'parks'), undefined)
    assert.equal(mappedNearestId(null, 'parks'), undefined)
})

test('all three real vector themes retain sources, labels, bus exclusions and licenses without mutating the base', () => {
    const original = structuredClone(base)
    const colors = []
    for (const key of ['light', 'streets', 'dark']) {
        const style = themeUtils.themedBasemap(base, key)
        assert.deepEqual(style.sources, base.sources)
        assert.equal(style.sprite, base.sprite)
        assert.equal(style.glyphs, base.glyphs)
        assert.deepEqual(style.layers.map(layer => [layer.id, layer.layout, layer.filter]), base.layers.map(layer => [layer.id, layer.layout, layer.filter]))
        for (const id of ['poi_bus', 'poi_busstop']) assert.equal(style.layers.find(layer => layer.id === id).layout.visibility, 'none')
        colors.push(style.layers.find(layer => layer.id === 'background').paint['background-color'])
    }
    assert.equal(new Set(colors).size, 3)
    assert.deepEqual(base, original)
})

test('theme round trips restore paint exactly and never touch analytical sources, geometry, camera or layer visibility', () => {
    const rendered = new Map(base.layers.map(layer => [layer.id, structuredClone(layer)]))
    const state = { zoom: 15, center: [92.87, 56.01], selectedStop: 17, selectedAddress: 'osm:way:1', radius: 300, visible: ['parks', 'stops'], source: { type: 'FeatureCollection', features: [] } }
    const before = structuredClone(state), source = state.source
    const map = {
        getLayer: id => rendered.get(id),
        setPaintProperty(id, property, value) {
            const layer = rendered.get(id)
            layer.paint ??= {}
            if (value == null) delete layer.paint[property]
            else layer.paint[property] = value
        },
    }
    for (const theme of ['dark', 'light', 'streets']) themeUtils.applyBasemapTheme(map, base, theme)
    for (const layer of base.layers) assert.deepEqual(rendered.get(layer.id).paint, layer.paint)
    assert.deepEqual(state, before)
    assert.equal(state.source, source)
})

test('local theme is shared, validates storage, survives reload and remains usable when storage is blocked', () => {
    const mounted = [], cleanup = [], listeners = new Map(), values = new Map([[themeUtils.mapThemeStorageKey, 'dark']])
    const window = { localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, addEventListener: (name, fn) => listeners.set(fn, name), removeEventListener: (_, fn) => listeners.delete(fn) }
    const deps = { ...themeUtils, ref: vue.ref, readonly: vue.readonly, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => cleanup.push(fn), window }
    const { useMapTheme } = loadModule(new URL('../../resources/js/composables/useMapTheme.ts', import.meta.url), { vue: { ...vue, onMounted: deps.onMounted, onBeforeUnmount: deps.onBeforeUnmount }, '@/utils/mapTheme': themeUtils }, { window })
    const first = useMapTheme(), second = useMapTheme()
    mounted.forEach(fn => fn())
    assert.equal(first.theme.value, 'dark')
    first.setTheme('streets')
    assert.equal(second.theme.value, 'streets')
    assert.equal(values.get(themeUtils.mapThemeStorageKey), 'streets')
    values.set(themeUtils.mapThemeStorageKey, 'invalid')
    for (const [listener] of listeners) listener({ key: themeUtils.mapThemeStorageKey })
    assert.equal(first.theme.value, 'light')
    window.localStorage.setItem = () => { throw Error('blocked') }
    assert.doesNotThrow(() => first.setTheme('dark'))
    assert.equal(second.theme.value, 'dark')
    const third = useMapTheme()
    mounted.at(-1)()
    assert.equal(third.theme.value, 'dark')
    window.localStorage.getItem = () => { throw Error('blocked') }
    for (const [listener] of listeners) assert.doesNotThrow(() => listener({ key: themeUtils.mapThemeStorageKey }))
    cleanup.forEach(fn => fn())
    assert.equal(listeners.size, 0)
})

test('ten coincident address labels remain distinct on a narrow short canvas without moving their anchors', () => {
    const anchors = Array.from({ length: 10 }, (_, i) => ({ id: `osm:way:${i}`, number: i + 1, x: 140 + i * .01, y: 100 }))
    const before = structuredClone(anchors)
    const labels = labelUtils.placeMapLabels(anchors, 288, 210)
    assert.equal(labels.length, 10)
    assert.deepEqual(anchors, before)
    for (const [index, label] of labels.entries()) {
        assert.equal(label.anchorX, anchors[index].x)
        assert.equal(label.anchorY, anchors[index].y)
        assert.ok(label.x >= 16 && label.x <= 272 && label.y >= 16 && label.y <= 194)
        for (const other of labels.slice(index + 1)) assert.ok(Math.abs(label.x - other.x) >= 36 || Math.abs(label.y - other.y) >= 36)
    }
    assert.deepEqual(labelUtils.placeMapLabels(anchors, 288, 210), labels)
})

test('address labels leave official stop markers clickable when those lie next to the selected house', () => {
    const stops = [{ x: 156, y: 92 }, { x: 158, y: 94 }]
    const [label] = labelUtils.placeMapLabels([{ id:'house', number:1, x:140, y:116 }], 288, 260, stops)
    for (const stop of stops) assert.ok(Math.abs(label.x - stop.x) >= 28 || Math.abs(label.y - stop.y) >= 28)
    assert.equal(label.anchorX, 140)
    assert.equal(label.anchorY, 116)
})

test('selected-address caption keeps its full width inside the map and leaves stops clickable', () => {
    const anchors = [{ id:'address', number:1, x:275, y:116 }], stops = [{x:220,y:92}]
    const [label] = labelUtils.placeMapLabels(anchors,288,260,stops,116)
    assert.ok(label.x >= 64 && label.x <= 224)
    assert.ok(Math.abs(label.x-stops[0].x) >= 70 || Math.abs(label.y-stops[0].y) >= 28)
    assert.equal(label.anchorX,275)
    assert.equal(label.anchorY,116)
})

test('Goal 8 existing caption placement avoids the real legend rectangle without relocating its source point', () => {
    const blocked=[{left:10,top:58,right:132,bottom:92}]
    const [label]=labelUtils.placeMapLabels([{id:'address',number:1,x:72,y:108}],320,310,[],116,blocked)
    assert.equal(label.anchorX,72)
    assert.equal(label.anchorY,108)
    assert.ok(label.x+58+6<=10 || label.x-58-6>=132 || label.y+22<=58 || label.y-22>=92)
    const controls=[{left:6,top:14,right:314,bottom:50},{left:10,top:58,right:130,bottom:92},{left:214,top:185,right:310,bottom:205},{left:254,top:169,right:294,bottom:250}]
    const [crowded]=labelUtils.placeMapLabels([{id:'address',number:1,x:146,y:175}],320,297,[{x:155,y:165},{x:157,y:163}],116,controls)
    for(const rect of controls) assert.ok(crowded.x+64<=rect.left || crowded.x-64>=rect.right || crowded.y+22<=rect.top || crowded.y-22>=rect.bottom)
    assert.ok(Math.abs(crowded.x-146)>=70 || Math.abs(crowded.y-175)>=28)
})
