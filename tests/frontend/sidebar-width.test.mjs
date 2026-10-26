import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
import { computed, ref } from 'vue'

function setup(initial, stored = null, brokenStorage = false) {
    let size = initial
    const mounted = [], cleanups = [], writes = []
    const win = { matchMedia: () => ({ matches: size >= 768 }), addEventListener() {}, removeEventListener() {}, localStorage: {
        getItem() { if (brokenStorage) throw Error(); return stored }, setItem(key, value) { if (brokenStorage) throw Error(); writes.push([key, value]) }, removeItem(key) { if (brokenStorage) throw Error(); writes.push([key, null]) },
    } }
    class Observer { constructor(cb) { this.cb = cb; Observer.latest = this } observe() {} disconnect() {} }
    const factory = loadModule(new URL('../../resources/js/composables/useSidebarWidth.ts', import.meta.url), { vue: { computed, ref, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => cleanups.push(fn) } }, { window: win, ResizeObserver: Observer }).useSidebarWidth
    const state = factory(ref({ getBoundingClientRect: () => ({ width: size }) }), 'profile')
    mounted.forEach(fn => fn())
    return { state, writes, resize(value) { size = value; Observer.latest.cb() }, dispose() { cleanups.forEach(fn => fn()) } }
}
const key = (state, value) => state.keydown({ key: value, preventDefault() {} })

test('saved wide sidebar clamps on smaller desktops, disappears on mobile and recovers without losing preference', () => {
    const check = setup(1440, '630')
    try {
        assert.equal(check.state.width.value, 630)
        check.resize(768)
        assert.equal(check.state.width.value, 372)
        assert.ok(768 - check.state.width.value - 12 >= 384)
        check.resize(390)
        assert.equal(check.state.enabled.value, false)
        assert.deepEqual(check.state.style.value, {})
        check.resize(1440)
        assert.equal(check.state.width.value, 630)
        assert.deepEqual(check.writes, [])
    } finally { check.dispose() }
})

test('keyboard and pointer controls respect bounds, persist only user actions and reset to the current default', () => {
    const check = setup(1280)
    try {
        assert.equal(check.state.width.value, 480)
        key(check.state, 'ArrowRight'); assert.equal(check.state.width.value, 496)
        key(check.state, 'End'); assert.equal(check.state.width.value, 640)
        key(check.state, 'Home'); assert.equal(check.state.width.value, 320)
        const target = { focus() {}, setPointerCapture() {} }
        check.state.pointerDown({ button: 0, isPrimary: true, pointerId: 1, clientX: 320, currentTarget: target, preventDefault() {} })
        check.state.pointerMove({ pointerId: 1, clientX: 900 })
        assert.equal(check.state.width.value, 640)
        assert.equal(check.state.dragging.value, true)
        const count = check.writes.length
        check.state.pointerEnd({ pointerId: 1 })
        assert.equal(check.writes.length, count + 1)
        assert.equal(check.state.dragging.value, false)
        check.state.reset(); assert.equal(check.state.width.value, 480)
        assert.equal(check.writes.at(-1)[1], null)
    } finally { check.dispose() }
})

test('invalid or inaccessible local storage never prevents use of the separator', () => {
    for (const [value, broken] of [['NaN', false], ['-20', false], ['9999999', false], [null, true]]) {
        const check = setup(1024, value, broken)
        try { assert.equal(check.state.width.value, 480); key(check.state, 'ArrowLeft'); assert.equal(check.state.width.value, 464); check.state.reset() }
        finally { check.dispose() }
    }
})
