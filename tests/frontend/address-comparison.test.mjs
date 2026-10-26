import { personalState, personalUtils, ComparisonTrips, ComparisonShare, ComparisonTripData } from './support/comparison-trips-dependencies.mjs'
import { topics, facts, OverviewTopics, ComparisonFacts } from './support/overview-dependencies.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, loadComponent, loadSetup } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'
import { mapDependencies } from './support/map-dependencies.mjs'

const build = (ref, shallowReactive, onBeforeUnmount, fetchAddressProfile) => loadModule(new URL('../../resources/js/composables/useAddressComparison.ts', import.meta.url), {
    vue: { ...vue, ref, shallowReactive, onBeforeUnmount }, '@/api/profiles': { fetchAddressProfile },
}).useAddressComparison
const profile = (id, radius = 500) => ({ address: { id }, radius_m: radius })
function setup(initial = { left: 'osm:way:1', right: 'osm:node:2', radius: 500 }) {
    let cleanup
    const pending = [], changes = []
    const factory = build(vue.ref, vue.shallowReactive, fn => { cleanup = fn }, (id, radius, signal) => new Promise((resolve, reject) => pending.push({ id, radius, signal, resolve, reject })))
    const state = factory(initial, selection => changes.push(selection))
    return { state, pending, changes, dispose() { cleanup(); for (const p of pending) p.resolve(profile(p.id, p.radius)) } }
}

test('two profiles load independently; replacing and clearing one side preserves the other and rejects stale responses', async () => {
    const { state, pending, changes, dispose } = setup()
    try {
        const loaded = state.load()
        assert.equal(pending.length, 2)
        pending[0].resolve(profile('osm:way:1')); pending[1].resolve(profile('osm:node:2')); await loaded
        const right = state.sides.right.profile
        state.choose('left', 'osm:way:3')
        assert.equal(state.sides.left.profile, null)
        assert.equal(state.sides.right.profile, right)
        assert.equal(pending.length, 3)
        state.choose('left', 'osm:way:4')
        assert.equal(pending[2].signal.aborted, true)
        pending[3].resolve(profile('osm:way:4')); await Promise.resolve()
        pending[2].resolve(profile('osm:way:3')); await Promise.resolve()
        assert.equal(state.sides.left.profile.address.id, 'osm:way:4')
        state.choose('left', null)
        assert.equal(state.sides.left.status, 'empty')
        assert.equal(state.sides.left.profile, null)
        assert.equal(state.sides.right.profile, right)
        assert.deepEqual(changes.at(-1), { left: null, right: 'osm:node:2', radius: 500 })
    } finally { dispose() }
})

test('common radius clears both profiles and late old-radius results never mix with new results', async () => {
    const { state, pending, changes, dispose } = setup()
    try {
        const old = state.load()
        state.setRadius(300)
        assert.equal(pending.length, 4)
        assert.equal(pending[0].signal.aborted, true)
        assert.equal(pending[1].signal.aborted, true)
        assert.equal(state.sides.left.profile, null); assert.equal(state.sides.right.profile, null)
        for (const p of pending.slice(2)) p.resolve(profile(p.id, 300))
        await Promise.resolve()
        for (const p of pending.slice(0,2)) p.resolve(profile(p.id, 500))
        await old
        assert.equal(state.sides.left.profile.radius_m, 300)
        assert.equal(state.sides.right.profile.radius_m, 300)
        assert.deepEqual(changes, [{ left: 'osm:way:1', right: 'osm:node:2', radius: 300 }])
        state.setRadius(1000); assert.equal(pending.length, 4)
        state.choose('left', state.sides.left.id); assert.equal(changes.length, 1)
    } finally { dispose() }
})

test('invalid ID and unavailable source remain side-local and retryable; missing side makes no request', async () => {
    const { state, pending, dispose } = setup({ left: null, right: 'bad-id', radius: 500 })
    try {
        const loaded = state.load()
        assert.equal(pending.length, 1)
        assert.equal(state.sides.left.status, 'empty')
        pending[0].reject(Object.assign(new Error(), { status: 404 })); await loaded
        assert.equal(state.sides.right.status, 'not_found')
        const retry = state.loadSide('right')
        pending[1].reject(Object.assign(new Error(), { status: 503 })); await retry
        assert.equal(state.sides.right.status, 'unavailable')
        const error = state.loadSide('right')
        pending[2].reject(new Error('network')); await error
        assert.equal(state.sides.right.status, 'error')
        state.choose('right', 'osm:node:2')
        pending[3].resolve(profile('osm:node:2')); await Promise.resolve()
        assert.equal(state.sides.right.status, 'ready')
    } finally { dispose() }
})

test('back/forward restoration loads only changed sides and never pushes another history entry', async () => {
    const { state, pending, changes, dispose } = setup()
    try {
        const loaded = state.load()
        for (const p of pending) p.resolve(profile(p.id)); await loaded
        state.choose('right', 'osm:way:3')
        state.restore({ left: 'osm:way:1', right: 'osm:node:2', radius: 500 })
        assert.equal(pending.length, 4)
        assert.equal(pending[2].signal.aborted, true)
        pending[3].resolve(profile('osm:node:2')); await Promise.resolve()
        assert.equal(state.sides.right.profile.address.id, 'osm:node:2')
        assert.equal(changes.length, 1)
        dispose()
        assert.equal(pending[3].signal.aborted, true)
        pending[2].resolve(profile('osm:way:3')); await Promise.resolve()
        assert.equal(state.sides.right.profile.address.id, 'osm:node:2')
    } finally { dispose() }
})

test('a response with another object or radius cannot be presented as the requested comparison', async () => {
    const { state, pending, dispose } = setup()
    try {
        const loaded = state.load()
        pending[0].resolve(profile('osm:way:99'))
        pending[1].resolve(profile('osm:node:2', 300))
        await loaded
        assert.equal(state.sides.left.status, 'error'); assert.equal(state.sides.right.status, 'error')
        assert.equal(state.sides.left.profile, null); assert.equal(state.sides.right.profile, null)
    } finally { dispose() }
})

const comparison = loadModule(new URL('../../resources/js/utils/comparison.ts', import.meta.url))
const { parseComparison, comparisonUrl, comparisonDifferences } = comparison

test('shared URL round-trips exact object IDs, empty sides, Cyrillic and invalid IDs without execution', () => {
    const selection = { left: 'osm:way:123', right: 'bad <ID> & Киренского', radius: 300 }
    assert.deepEqual(parseComparison(comparisonUrl(selection).split('?')[1]), selection)
    assert.deepEqual(parseComparison('left=osm%3Anode%3A1&radius_m=1000'), { left: 'osm:node:1', right: null, radius: 500 })
    assert.deepEqual(parseComparison(''), { left: null, right: null, radius: 500 })
})
test('different source dates, snapshots, methods, availability and coverage produce explicit comparison notes', () => {
    const left = { value: 0, unit: '%', source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: '2026-10-18', method_version: 'v1', quality: { method: 'DERIVED', availability: 'AVAILABLE', freshness: 'UNKNOWN' } }
    const right = { ...left, dataset_import_id: 2, observed_at: '2026-10-10', source_updated_at: '2026-10-19', quality: { method: null, availability: 'INSUFFICIENT_DATA', freshness: 'STALE' }, method_version: 'v2' }
    const notes = comparisonDifferences(left, right, { status: 'COVERED' }, { status: 'PARTIAL' })
    assert.equal(notes.length, 7)
    assert.match(notes.join(' '), /не означает ноль/)
    assert.deepEqual(comparisonDifferences(left, left, { status: 'COVERED' }, { status: 'COVERED' }), [])
    assert.deepEqual(comparisonDifferences(undefined, right), [])
    assert.match(comparisonDifferences(left, { ...left, unit: 'm2' })[0], /Единицы различаются/)
})

test('two search widgets have independent label, listbox and live-status IDs', async () => {
    const stub = { render: () => null }
    const search = { useAddressSearch: () => ({ query: vue.ref('Мира'), results: vue.ref([{ id: 'address:group', label: 'Мира, 10', match_type: 'exact', object_count: 1 }]), meta: vue.ref(null), status: vue.ref('ready'), open: vue.ref(true), activeIndex: vue.ref(0), clear() {}, close() {}, search() {}, choose() {} }) }
    const component = loadComponent(new URL('../../resources/js/components/AddressSearch.vue', import.meta.url), { '@lucide/vue': { Search: stub, X: stub, ArrowRight: stub }, '@/composables/useAddressSearch': search })
    const html = await ssr.renderToString(vue.createSSRApp({ render: () => vue.h('div', [vue.h(component, { resetKey: 0 }), vue.h(component, { resetKey: 0 })]) }))
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])
    assert.equal(ids.length, 8)
    assert.equal(new Set(ids).size, ids.length)
    for (const label of html.matchAll(/\sfor="([^"]+)"/g)) assert.ok(ids.includes(label[1]))
    for (const relation of html.matchAll(/aria-(?:controls|describedby|activedescendant)="([^"]+)"/g)) assert.ok(ids.includes(relation[1]))
})

const display = loadModule(new URL('../../resources/js/utils/metricDisplay.ts', import.meta.url))
const presentation = loadModule(new URL('../../resources/js/utils/profilePresentation.ts', import.meta.url))
const paired = loadModule(new URL('../../resources/js/utils/comparisonPresentation.ts', import.meta.url), { './profilePresentation': presentation })
function compareDependencies(deps) {
    return {
        '@/utils/metricDisplay': display, '@/utils/profilePresentation': presentation,
        '@/utils/comparisonPresentation': paired, '@/utils/comparison': comparison,
        '@/utils/comparisonFacts': facts, '@/utils/mapAnalysis': mapDependencies,
        '@/utils/tripMap': loadModule(new URL('../../resources/js/utils/tripMap.ts', import.meta.url), { '@/utils/tripCandidates': loadModule(new URL('../../resources/js/utils/tripCandidates.ts', import.meta.url)) }),
        '@/utils/comparisonTrips': personalUtils, '@/composables/useComparisonTrips': personalState,
        '@/composables/useComparisonLink': loadModule(new URL('../../resources/js/composables/useComparisonLink.ts', import.meta.url), {
            vue: { ...vue, onMounted: deps.onMounted ?? vue.onMounted, onBeforeUnmount: deps.onBeforeUnmount ?? vue.onBeforeUnmount },
            '@/utils/comparison': comparison, '@/utils/tripMap': loadModule(new URL('../../resources/js/utils/tripMap.ts', import.meta.url), { '@/utils/tripCandidates': loadModule(new URL('../../resources/js/utils/tripCandidates.ts', import.meta.url)) }),
        '@/utils/comparisonTrips': personalUtils,
        }, { window: deps.window ?? { location: { search: '', hash: '', origin: 'http://localhost' } } }),
        '@/composables/useOverviewTopics': { useOverviewTopics: deps.useOverviewTopics },
        '@/composables/useAddressComparison': { useAddressComparison: deps.useAddressComparison },
        '@/composables/useComparisonView': { useComparisonView: deps.useComparisonView },
        '@/layouts/PlaceLayout.vue': deps.PlaceLayout,
        ...Object.fromEntries(['AddressPicker', 'ComparisonMetricRow', 'OverviewTopics', 'ComparisonFacts', 'ComparisonData', 'ComparisonMapSplit', 'ComparisonTrips', 'ComparisonShare', 'ComparisonTripData', 'ProfileMetric', 'ComparisonMetric'].map(name => ['@/components/' + name + '.vue', deps[name]])),
        '@/components/map/CityMap.vue': deps.CityMap, '@/components/map/MapThemeControl.vue': deps.MapThemeControl,
        '@/components/map/MapLayersPanel.vue': deps.MapLayersPanel,
    }
}
function ssrComponent(path, deps) {
    return loadComponent(new URL(path, import.meta.url), compareDependencies(deps), { globals: { window: { location: { search: '', origin: 'http://localhost' } } } })
}
function fullProfile(id) {
    const result = { address: { id, label: id === 'osm:way:1' ? 'Ленина, 102' : 'Киренского, 32' }, point: { lat: 56, lon: 92.9 }, radius_m: 500, map: {}, blocks: {} }
    for (const key of ['transport','parks','vegetation','water','roads','railways']) {
        const metrics = {}
        for (const field of key === 'transport' ? ['stops_count','nearest_stop_distance'] : ['nearest_distance','share','area','length']) {
            metrics[field] = { key: field, value: 0, unit: field === 'share' ? '%' : field === 'stops_count' ? 'count' : 'm', source: 'OpenStreetMap', dataset_import_id: 12,
                observed_at: null, source_updated_at: null, calculated_at: '2026-10-20T00:00:00Z', quality: { method: 'DERIVED', availability: 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Ограничения источника.' } }
        }
        result.blocks[key] = { status: 'READY', data: { metrics, coverage: { status: 'COVERED', reason: 'Радиус обеспечен данными.' }, nearest: null, nearest_stop: null }, message: null }
    }
    return result
}
test('paired overview keeps zero, missing values and independent failures; provenance remains separate', async () => {
    const ProfileMetric = ssrComponent('../../resources/js/components/ProfileMetric.vue', display)
    const ComparisonMetric = ssrComponent('../../resources/js/components/ComparisonMetric.vue', { ...display, ProfileMetric })
    const ComparisonMetricRow = ssrComponent('../../resources/js/components/ComparisonMetricRow.vue', { comparisonRowId: facts.comparisonRowId, ComparisonMetric, ...presentation, ...paired, comparisonDifferences, mappedNearestId: mapDependencies.mappedNearestId })
    const ComparisonData = ssrComponent('../../resources/js/components/ComparisonData.vue', { ...display, ...presentation })
    const ComparisonMapSplit = ssrComponent('../../resources/js/components/ComparisonMapSplit.vue', {})
    const left = fullProfile('osm:way:1'), right = fullProfile('osm:node:2')
    right.blocks.transport = { status: 'ERROR', data: null, message: 'Не удалось рассчитать блок.' }
    right.blocks.water.data.metrics.share.value = null
    right.blocks.water.data.metrics.share.quality = { method: null, availability: 'INSUFFICIENT_DATA', freshness: 'UNKNOWN', reason: 'Неполное покрытие.' }
    right.blocks.water.data.coverage = { status: 'PARTIAL', reason: 'Неполное покрытие.' }
    const sides = { left: { id: left.address.id, profile: left, status: 'ready' }, right: { id: right.address.id, profile: right, status: 'ready' } }
    const page = ssrComponent('../../resources/js/pages/ComparePage.vue', {
        ...personalState, ...personalUtils, ComparisonTrips, ComparisonShare, ComparisonTripData, OverviewTopics, ComparisonFacts, useOverviewTopics: topics.useOverviewTopics,
        PlaceLayout: { props: ['document'], render() { return this.$slots.default() } }, AddressPicker: { render: () => null }, ComparisonMetricRow, ComparisonData, ComparisonMapSplit, MapThemeControl: { render: () => null }, ...paired,
        MapLayersPanel: { render: () => null }, CityMap: { render: () => vue.h('canvas', { 'data-map': 'comparison' }) },
        useAddressComparison: () => ({ radius: vue.ref(500), sides }),
        mappedNearestId: mapDependencies.mappedNearestId,
        useComparisonView: () => ({ toolbar: vue.ref(null), mapPanel: vue.ref(null), results: vue.ref(null), toolbarHeight: vue.ref(0), mapTop: vue.ref(0), mapFocused: vue.ref(false) }),
        comparisonDifferences, comparisonUrl, parseComparison, ...display,
    })
    const html = await ssr.renderToString(vue.createSSRApp(page))
    assert.match(html, /Ленина, 102/)
    assert.match(html, /Киренского, 32/)
    assert.match(html, /Недостаточно данных/)
    assert.match(html, /Неполное покрытие/)
    assert.match(html, /Отсутствие результата не означает ноль/)
    assert.match(html, /Покрытие источника различается/)
    assert.match(html, /Не удалось рассчитать блок/)
    assert.match(html, /Повторить расчёт Б/)
    assert.match(html, /0 %/)
    assert.equal((html.match(/comparison-metric--compact/g) ?? []).length, 24)
    assert.equal((html.match(/data-map="comparison"/g) ?? []).length, 2)
    assert.doesNotMatch(html, /class="metric-card/)
    const visible = html.replace(/<details\b[\s\S]*?<\/details>/g, '')
    assert.match(html, /Дата наблюдения неизвестна/)
    assert.match(html, /актуальность: неизвестна/)
    assert.match(visible, /Неполное покрытие/)
    const rows = html.slice(html.indexOf('id="compare-panel-overview"'), html.indexOf('id="compare-panel-data"'))
    assert.doesNotMatch(rows, /Ленина, 102|Киренского, 32/)
    assert.match(html, /Открыть профиль А/)
    assert.match(html, /Открыть профиль Б/)
    assert.doesNotMatch(html, /Длина картографических линий/)
})

test('only a verified label of the same object survives reload, radius changes and retries; all old analysis is cleared', async () => {
    const { state, pending, dispose } = setup()
    try {
        const loaded = state.load()
        pending[0].resolve({ ...profile('osm:way:1'), address: { id: 'osm:way:1', label: 'Публичный адрес А' }, map: { old: true } })
        pending[1].resolve(profile('osm:node:2'))
        await loaded
        state.setRadius(300)
        assert.deepEqual(state.sides.left.knownAddress, { id: 'osm:way:1', label: 'Публичный адрес А' })
        assert.equal(state.sides.left.profile, null)
        assert.equal(state.sides.right.profile, null)
        pending[2].reject(new Error('offline')); pending[3].resolve(profile('osm:node:2', 300))
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(state.sides.left.status, 'error')
        assert.equal(state.sides.left.knownAddress.label, 'Публичный адрес А')
        const retry = state.loadSide('left')
        assert.equal(state.sides.left.profile, null)
        assert.equal(state.sides.left.knownAddress.label, 'Публичный адрес А')
        state.choose('left', 'osm:way:99')
        assert.equal(state.sides.left.knownAddress, null)
        pending[4].resolve({ ...profile('osm:way:1', 300), address: { id: 'osm:way:1', label: 'Поздний старый адрес' } })
        await retry
        assert.equal(state.sides.left.knownAddress, null)
        pending[5].resolve({ ...profile('osm:way:99', 300), address: { id: 'osm:way:99', label: 'Публичный адрес В' } })
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(state.sides.left.knownAddress.label, 'Публичный адрес В')
        state.choose('left', null)
        assert.equal(state.sides.left.knownAddress, null)
    } finally { dispose() }
})

test('compact metric keeps small values, access restrictions, stale status and observation dates visible', async () => {
    const component = ssrComponent('../../resources/js/components/ComparisonMetric.vue', { ...display, ProfileMetric: ssrComponent('../../resources/js/components/ProfileMetric.vue', display) })
    const metric = { ...fullProfile('osm:way:1').blocks.parks.data.metrics.share, value: 0.01, unit: '%', observed_at: '2025-01-01T00:00:00Z', quality: { method: 'DERIVED', availability: 'AVAILABLE', freshness: 'STALE', reason: 'Данные требуют обновления.' } }
    const html = await ssr.renderToString(vue.createSSRApp(component, { metric, side: 'Б', label: 'Доля парка', access: 'private' }))
    const visible = html.replace(/<details\b[\s\S]*?<\/details>/g, '')
    assert.match(visible, /&lt;0,1 %/)
    assert.match(visible, /частный/)
    assert.match(visible, /Наблюдение: 01.01.2025/)
    assert.match(visible, /Актуальность: устаревшие/)
    assert.match(visible, /Данные требуют обновления/)
    assert.match(html, /Источник и ограничения: Доля парка, вариант Б/)
})

test('map side and layers are view state; replacing a side returns focus without changing its sibling', async () => {
    const mounted = [], disposed = [], pushed = [], focused = [], pending = []
    const win = { location: { search: '?left=osm%3Away%3A1&right=osm%3Anode%3A2&radius_m=500', origin: 'https://synthetic.invalid', hash: '' }, history: { pushState(_state, _title, url) { pushed.push(url) } }, addEventListener() {}, removeEventListener() {} }
    let state
    const deps = { ...vue, ...personalState, ...personalUtils, useOverviewTopics: () => ({ includes: () => true, selection: vue.ref(null) }), onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => disposed.push(fn), window: win,
        document: { title: '', getElementById: id => ({ focus() { focused.push(id) }, querySelector() { return { focus() { focused.push(`${id}:input`) } } } }) },
        ResizeObserver: class { observe() {} disconnect() {} }, navigator: { clipboard: { async writeText() { throw new Error('clipboard denied') } } },
        useAddressComparison(initial, change) {
            state = build(vue.ref, vue.shallowReactive, fn => disposed.push(fn), (id, radius, signal) => new Promise(resolve => pending.push({ id, radius, signal, resolve })))(initial, change)
            return state
        }, useComparisonView: () => ({ toolbar: vue.ref(null), mapPanel: vue.ref(null), results: vue.ref(null), toolbarHeight: vue.ref(0), mapTop: vue.ref(0), mapFocused: vue.ref(false) }), parseComparison, comparisonUrl, comparisonDifferences,
    }
    const page = loadSetup(new URL('../../resources/js/pages/ComparePage.vue', import.meta.url), ['activeSide','activeProfile','areaVisibility','showStops','linearVisibility','chooseAddress','searchOpen','toggleSearch','shareUrl','mapAddress'], { ...compareDependencies(deps), vue: { ...vue, onMounted: deps.onMounted, onBeforeUnmount: deps.onBeforeUnmount } }, { window: win, document: deps.document, ResizeObserver: deps.ResizeObserver, navigator: deps.navigator })
    try {
        mounted.forEach(fn => fn())
        pending.forEach(p => p.resolve(fullProfile(p.id)))
        await new Promise(resolve => setImmediate(resolve))
        const originalLeft = state.sides.left.profile, originalRight = state.sides.right.profile
        const leftMapAddress = page.mapAddress('left')
        page.activeSide.value = 'right'
        page.showStops.value = true
        page.areaVisibility.value = { parks: true, vegetation: false, water: true }
        page.linearVisibility.value = { roads: true, railways: false }
        assert.equal(page.activeProfile.value, originalRight)
        assert.equal(page.mapAddress('left'), leftMapAddress)
        assert.equal(state.sides.left.profile, originalLeft)
        assert.equal(state.radius.value, 500)
        assert.equal(pending.length, 2)
        assert.deepEqual(pushed, [])
        await page.chooseAddress('right', 'osm:way:3')
        assert.equal(page.activeProfile.value, null)
        assert.equal(state.sides.left.profile, originalLeft)
        assert.equal(focused.at(-1), 'compare-change-right')
        assert.equal(page.mapAddress('left'), leftMapAddress)
        assert.equal(pushed.length, 1)
        assert.equal(page.showStops.value, true)
        assert.equal(page.areaVisibility.value.parks, true)
        page.activeSide.value = 'left'
        assert.equal(page.activeProfile.value, originalLeft)
        assert.equal(pushed.length, 1)
        assert.match(page.shareUrl.value, /right=osm%3Away%3A3/)
        await page.chooseAddress('right', null)
        assert.equal(page.searchOpen.right, true)
        assert.equal(focused.at(-1), 'compare-picker-right:input')
        await page.toggleSearch('right')
        assert.equal(page.searchOpen.right, false)
        assert.equal(focused.at(-1), 'compare-change-right')
        pending[2].resolve(fullProfile('osm:way:3'))
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(state.sides.right.profile, null)
    } finally { disposed.forEach(fn => fn()) }
})
