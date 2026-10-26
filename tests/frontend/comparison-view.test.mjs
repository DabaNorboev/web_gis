import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
import { ref, nextTick } from 'vue'

function setup() {
    const mounted = [], cleanups = [], listeners = new Map(), focus = [], scroll = []
    let toolbarHeight = 180, panelTop = 360, rowTop = 210, disconnected = false, observer, scheduled
    const heading = { focus: options => focus.push(['map', options]) }
    const rowHeading = { focus: options => focus.push(['row', options]) }
    const disclosure = { isConnected: true, getBoundingClientRect: () => ({ top: rowTop + 10, bottom: rowTop + 40 }), focus: options => focus.push(['disclosure', options]) }
    const row = { isConnected: true, getBoundingClientRect: () => ({ top: rowTop, bottom: rowTop + 150 }), querySelector: () => rowHeading }
    const win = { innerHeight: 740, innerWidth: 390, location: { hash: '' }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name), scrollBy: (x, y) => scroll.push([x, y]) }
    const chrome = { inert: false }
    const doc = { activeElement: disclosure, querySelectorAll: () => [chrome] }
    class Observer { constructor(cb) { observer = cb } observe() {} disconnect() { disconnected = true } }
    const state = loadModule(new URL('../../resources/js/composables/useComparisonView.ts', import.meta.url), { vue: { ref, nextTick, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => cleanups.push(fn) } }, { window: win, document: doc, ResizeObserver: Observer, requestAnimationFrame: fn => { scheduled = fn; return 1 }, cancelAnimationFrame: () => {} }).useComparisonView()
    state.toolbar.value = { getBoundingClientRect: () => ({ height: toolbarHeight, bottom: toolbarHeight }) }
    state.results.value = { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [row], contains: element => element === disclosure, scrollIntoView: () => scroll.push('results'), focus() {} }
    state.mapPanel.value = { getBoundingClientRect: () => ({ top: panelTop }), scrollIntoView: () => scroll.push('map'), querySelector: () => heading }
    mounted.forEach(fn => fn())
    return { state, focus, scroll, listeners, doc, disclosure, chrome, setGeometry(t, p, r) { toolbarHeight = t; panelTop = p; rowTop = r; observer(); scheduled() }, dispose() { cleanups.forEach(fn => fn()); assert.equal(disconnected, true); assert.equal(listeners.size, 0) } }
}

test('map transition restores the same reading row and disclosure focus after the compact toolbar changes height', async () => {
    const check = setup()
    try {
        await check.state.showMap()
        assert.equal(check.state.mapFocused.value, true)
        assert.equal(check.chrome.inert, true)
        assert.equal(check.scroll.at(-1), 'map')
        assert.deepEqual(check.focus.at(-1), ['map', { preventScroll: true }])
        check.setGeometry(92, 104, 600)
        // Re-entering map must not overwrite the indicators bookmark.
        await check.state.showMap()
        check.setGeometry(180, 360, 600)
        await check.state.showIndicators()
        assert.equal(check.state.mapFocused.value, false)
        assert.equal(check.chrome.inert, false)
        assert.deepEqual(check.scroll.at(-1), [0, 390]) // 600 - 180 - original 30 px offset
        assert.deepEqual(check.focus.at(-1), ['disclosure', { preventScroll: true }])
    } finally { check.dispose() }
})

test('return from map uses a focusable row heading when entry came from the toolbar', async () => {
    const check = setup()
    try {
        check.doc.activeElement = null
        await check.state.showMap()
        await check.state.showIndicators()
        assert.deepEqual(check.focus.at(-1), ['row', { preventScroll: true }])
    } finally { check.dispose() }
})

test('actual panel top and measured toolbar determine available height on scroll and resize', () => {
    const check = setup()
    try {
        assert.equal(check.state.mapTop.value, 360)
        check.setGeometry(220, 80, 210)
        assert.equal(check.state.toolbarHeight.value, 220)
        assert.equal(check.state.mapTop.value, 232)
        check.setGeometry(90, 160, 210)
        assert.equal(check.state.mapTop.value, 160)
        assert.ok(check.listeners.has('scroll')); assert.ok(check.listeners.has('resize'))
    } finally { check.dispose() }
})

test('returning to a partly scrolled row exposes its heading below the sticky toolbar', async () => {
    const check = setup()
    try {
        check.doc.activeElement = null
        check.setGeometry(180, 360, 140)
        await check.state.showMap()
        await check.state.showIndicators()
        assert.deepEqual(check.scroll.at(-1), [0, -52]) // heading becomes visible at 180 + 12
        assert.deepEqual(check.focus.at(-1), ['row', { preventScroll: true }])
    } finally { check.dispose() }
})
