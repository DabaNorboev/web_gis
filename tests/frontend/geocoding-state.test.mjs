import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadModule } from './support/vue-component.mjs'
import { candidate, selection, envelope } from './fixtures/geocoding.mjs'
const errors = loadModule(new URL('../../resources/js/api/errors.ts', import.meta.url))
const pause = ms => new Promise(r => setTimeout(r, ms))
function setup(enabled = vue.ref(true)) {
    const calls = [], selections = [], previews = []; let cleanup
    const hook = loadModule(new URL('../../resources/js/composables/useGeocoding.ts', import.meta.url), {
        vue: { ...vue, onBeforeUnmount: f => { cleanup = f } }, '@/api/errors': errors,
        '@/api/geocoding': { requestGeocoding: (operation, fields, signal, expected) => new Promise((resolve, reject) => calls.push({ operation, fields, signal, expected, resolve, reject })) },
    })
    const state = hook.useGeocoding(v => selections.push(v), p => previews.push(p), vue.ref(''), enabled)
    return { state, calls, selections, previews, cleanup: () => cleanup() }
}
test('A-B-A and a single replaceable pending input reject stale lookup/finally', async () => {
    const s = setup()
    try {
        s.state.query.value = 'Адрес А'; s.state.search(); await pause(0)
        s.state.query.value = 'Адрес Б'; s.state.search()
        s.state.query.value = 'Адрес А'; s.state.search()
        assert.equal(s.calls.length, 1); assert.equal(s.calls[0].signal.aborted, true)
        s.calls[0].resolve({ data: { status: 'OK', candidates: [candidate({ label: 'STALE' })] } }); await pause(0)
        assert.equal(s.calls.length, 2); assert.equal(s.state.lookup.value, null); assert.equal(s.state.phase.value, 'loading')
        s.calls[1].resolve({ data: { status: 'OK', candidates: [candidate()] } }); await pause(0)
        assert.equal(s.state.lookup.value.candidates[0].label, candidate().label)
    } finally { s.cleanup() }
})
test('preview never commits; editing and unmount invalidate late confirm', async () => {
    const s = setup()
    try {
        s.state.query.value = 'Адрес'; s.state.search()
        const c = candidate(); s.calls[0].resolve({ data: { status: 'OK', candidates: [c] } }); await pause(0)
        s.state.choose(c); assert.equal(s.selections.length, 0)
        const pending = s.state.confirm(); const confirm = s.calls[1]
        s.state.query.value = 'Другой адрес'
        confirm.resolve({ data: selection(c) }); await pending
        assert.equal(s.selections.length, 0); assert.equal(s.state.selection.value, null)
        s.cleanup()
    } finally { s.cleanup() }
})
test('reverse is explicit; reconfirm preserves selection and absolute expiry clears bearer', async () => {
    const s = setup()
    try {
        await pause(1); assert.equal(s.calls.length, 0)
        const point = { lon: .1, lat: .2 }; s.state.reverse(point)
        const c = candidate(); s.calls[0].resolve({ data: { status: 'OK', point, candidates: [c] } }); await pause(0)
        s.state.choose(c); const confirming = s.state.confirm()
        const selected = selection(c); s.calls[1].resolve({ data: selected }); await confirming
        const renewed = s.state.confirm(true)
        assert.equal(s.calls[2].operation, 'reconfirm'); assert.equal(s.calls[2].fields.selection_token, selected.selection_token)
        s.calls[2].resolve({ data: { ...selected, selection_token: 'renewed' } }); await renewed
        assert.deepEqual(s.state.selection.value.place, selected.place)
        const lateRenewal = s.state.confirm(true)
        const originalNow = Date.now
        try {
            Date.now = () => Date.parse(selected.snapshot_expires_at); await pause(1100)
            s.calls[3].resolve({ data: { ...selected, selection_token: 'late-renewed' } }); await lateRenewal
        }
        finally { Date.now = originalNow }
        await vue.nextTick()
        assert.equal(s.state.absoluteExpired.value, true); assert.equal(s.state.selection.value.selection_token, '')
        assert.equal(s.selections.length, 2)
        await s.state.confirm(true); assert.equal(s.calls.length, 4)
    } finally { s.cleanup() }
})
test('quota cooldown prevents a fresh edited query from starting another request', async () => {
    const s = setup()
    try {
        s.state.query.value = 'Адрес'; s.state.search()
        s.calls[0].reject(new errors.ApiRequestError('http', 429, 'PROVIDER_RATE_LIMITED', '60')); await pause(0)
        s.state.query.value = 'Другой'; s.state.search(); await pause(0)
        assert.equal(s.calls.length, 1); assert.ok(s.state.waitSeconds.value > 0)
    } finally { s.cleanup() }
})
test('UI timeout rejects late success and allows only one manual retry without overlapping fetches', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const s = setup()
    try {
        s.state.query.value = 'Адрес'; s.state.search()
        t.mock.timers.tick(10001)
        assert.equal(s.state.phase.value, 'error'); assert.equal(s.calls[0].signal.aborted, true)
        s.state.retry(); assert.equal(s.calls.length, 1)
        s.calls[0].resolve({ data: { status: 'OK', candidates: [candidate({ label: 'STALE' })] } })
        await new Promise(setImmediate)
        assert.equal(s.calls.length, 2); assert.equal(s.state.lookup.value, null)
        s.calls[1].reject(new errors.ApiRequestError('http', 503, 'GEOCODING_UNAVAILABLE'))
        await new Promise(setImmediate)
        assert.equal(s.state.canRetry.value, false)
        s.state.retry(); assert.equal(s.calls.length, 2)
    } finally { s.cleanup(); t.mock.timers.reset() }
})

for (const operation of ['search', 'reverse', 'confirm']) {
    test(`mode A-B-A invalidates unabortable ${operation} without losing query or confirmed selection`, async () => {
        const enabled = vue.ref(true), s = setup(enabled), c = candidate()
        try {
            s.state.query.value = 'Синтетический адрес'; s.state.search()
            s.calls[0].resolve({ data: { status: 'OK', candidates: [c] } }); await pause(0)
            s.state.choose(c)
            const confirmed = s.state.confirm(); s.calls[1].resolve({ data: selection(c) }); await confirmed
            const original = s.state.selection.value
            if (operation === 'search') s.state.search()
            if (operation === 'reverse') s.state.reverse({ lon: 0, lat: 0 })
            let pending
            if (operation === 'confirm') {
                s.state.search(); s.calls[2].resolve({ data: { status: 'OK', candidates: [c] } }); await pause(0)
                s.state.choose(c); pending = s.state.confirm()
            }
            const old = s.calls.at(-1), count = s.calls.length
            enabled.value = false; enabled.value = true
            assert.equal(old.signal.aborted, true)
            old.resolve({ data: operation === 'confirm' ? selection(c, { selection_token: 'STALE' }) : { status: 'OK', candidates: [c] } })
            await pending; await pause(400)
            assert.equal(s.calls.length, count); assert.equal(s.state.query.value, 'Синтетический адрес')
            assert.equal(s.state.selection.value, original); assert.equal(s.selections.length, 1)
            assert.equal(s.state.lookup.value, null); assert.equal(s.state.preview.value, null); assert.equal(s.state.phase.value, 'idle')
        } finally { s.cleanup() }
    })
}
