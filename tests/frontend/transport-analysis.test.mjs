import * as vue from 'vue'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
import { ref, shallowRef } from 'vue'

const build = (ref, shallowRef, onBeforeUnmount, fetchTransportAnalysis) => loadModule(new URL('../../resources/js/composables/useTransportAnalysis.ts', import.meta.url), {
    vue: { ...vue, ref, shallowRef, onBeforeUnmount }, '@/api/transport': { fetchTransportAnalysis },
}).useTransportAnalysis
const point = { lon: 92.9, lat: 56 }

test('changing the radius retains the input point and rejects the previous response', async () => {
    const pending = []
    const state = build(ref, shallowRef, () => {}, (point, radius, signal) => new Promise(resolve => pending.push({ point, radius, signal, resolve })))()
    try {
        const old = state.selectPoint(point)
        state.selectedStopId.value = 1
        state.setRadius(300)
        assert.equal(pending[0].signal.aborted, true)
        assert.deepEqual(pending[1].point, point)
        assert.equal(pending[1].radius, 300)
        assert.equal(state.selectedStopId.value, null)
        const recent = { point, radius_m: 300, stops_in_radius: [] }
        pending[1].resolve(recent)
        await Promise.resolve()
        pending[0].resolve({ point, radius_m: 500, stops_in_radius: [{ id: 1 }] })
        await old
        assert.deepEqual(state.analysis.value, recent)
        assert.deepEqual(state.point.value, point)
        state.setRadius(500)
        assert.equal(state.analysis.value, null)
        state.reset()
        pending[2].resolve(recent)
        await Promise.resolve()
        assert.equal(state.status.value, 'idle')
        assert.equal(state.point.value, null)
        assert.equal(state.analysis.value, null)
    } finally { state.reset() }
})

test('choosing another building clears old stops and allows retry after an error', async () => {
    let fail = false
    const state = build(ref, shallowRef, () => {}, async (point, radius) => {
        if (fail) throw new Error('offline')
        return { point, radius_m: radius, stops_in_radius: [{ id: 1 }] }
    })()
    try {
        await state.selectPoint(point)
        state.selectedStopId.value = 1
        const next = { lon: 92.91, lat: 56.01 }
        fail = true
        const request = state.selectPoint(next)
        assert.equal(state.analysis.value, null)
        assert.equal(state.selectedStopId.value, null)
        await request
        assert.equal(state.status.value, 'error')
        assert.deepEqual(state.point.value, next)
        fail = false
        await state.selectPoint(state.point.value)
        assert.equal(state.status.value, 'ready')
        assert.deepEqual(state.analysis.value.point, next)
    } finally { state.reset() }
})

test('URL restoration and unmount never write history; user point/radius/reset changes do', async () => {
    const changes = [], calls = []
    let dispose
    const state = build(ref, shallowRef, fn => { dispose = fn }, async (point, radius) => {
        calls.push({ point, radius })
        return { point, radius_m: radius, stops_in_radius: [] }
    })(selection => changes.push(selection))
    try {
        state.restore({ point, radius: 300 })
        await Promise.resolve()
        assert.deepEqual(state.analysis.value.point, point)
        assert.equal(state.analysis.value.radius_m, 300)
        assert.deepEqual(changes, [])
        state.restore({ point, radius: 300 })
        assert.equal(calls.length, 1)
        state.setRadius(500)
        await Promise.resolve()
        assert.deepEqual(changes, [{ point, radius: 500 }])
        assert.deepEqual(calls.at(-1), { point, radius: 500 })
        await state.selectPoint(point) // Retry is not a new selection.
        assert.equal(changes.length, 1)
        const next = { lon: 92.90000012345678, lat: 56.00000012345678 }
        await state.selectPoint(next)
        assert.deepEqual(changes.at(-1), { point: next, radius: 500 })
        state.restore({ point, radius: 300 }) // Back.
        await Promise.resolve()
        assert.equal(changes.length, 2)
        assert.deepEqual(state.point.value, point)
        assert.equal(state.radius.value, 300)
        state.reset()
        assert.deepEqual(changes.at(-1), { point: null, radius: 300 })
        state.restore({ point: next, radius: 500 }) // Forward.
        await Promise.resolve()
        dispose()
        assert.equal(changes.length, 3)
        assert.equal(state.point.value, null)
    } finally { state.reset(false) }
})
