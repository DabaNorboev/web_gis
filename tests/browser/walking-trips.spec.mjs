import { test, expect, ready, mapReady } from './support.mjs'
import { places } from './fixtures.mjs'
import { mkdir } from 'node:fs/promises'

const screenshotDir = 'data/reports/walking-ui-2026-10-26/screenshots'
async function screenshot(page, testInfo, name) {
    if (!['phone-320', 'short-desktop'].includes(testInfo.project.name)) return
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: `${screenshotDir}/${name}-${testInfo.project.name}.png`, fullPage: true })
}

// Synthetic contract examples exercise the UI. They do not establish that ORS
// can route between these coordinates or that any building has a usable entrance.
const start = { lon: 92.87, lat: 56.01 }
const target = { lon: 92.89, lat: 56.02, label: 'Работа' }
const startStreet = { lon: 92.8704, lat: 56.01 }
const targetStreet = { lon: 92.8904, lat: 56.02 }
const selected = { version: 1, mode: 'walking', start: { ...start, road: startStreet }, places: [{ ...target, road: targetStreet }] }
const tripLink = value => `/trips#${new URLSearchParams({ trip: JSON.stringify(value) })}`
const comparePair = `/compare?${new URLSearchParams({ left: places.a.id, right: places.b.id, radius_m: '500' })}`
const compareSelection = (mode = 'walking', roads = {}) => ({ version: mode === 'walking' ? 2 : 1, mode,
    places: [{ id: 'goal-0', label: 'Работа', point: { lon: target.lon, lat: target.lat } }], roads })
const compareLink = value => `${comparePair}#${new URLSearchParams({ places: JSON.stringify(value) })}`

const point = value => ({ lon: value.lon, lat: value.lat })
const metric = (key, value, unit, scope) => ({ key, value, unit, scope,
    source: 'OpenStreetMap / ORS foot-walking', dataset_import_id: null, dataset_version: 'synthetic',
    observed_at: null, calculated_at: '2026-10-26T00:00:00Z',
    quality: { method: value === null ? null : 'DERIVED', availability: value === null ? 'INSUFFICIENT_DATA' : 'AVAILABLE',
        freshness: 'UNKNOWN', reason: value === null ? 'Подходы не подтверждены.' : 'Синтетический маршрут.' } })
function walkingRow(value, index) {
    const originalStart = point(value.start), originalTarget = point(value.places[index])
    const streetStart = point(value.start.road ?? value.start), streetTarget = point(value.places[index].road ?? value.places[index])
    const shift = (a, b) => a.lon === b.lon && a.lat === b.lat ? 0 : 30
    const approach = (original, street, explicit) => ({ status: explicit ? 'UNKNOWN' : 'NOT_INCLUDED',
        original, selected_street: street, selection_shift_m: shift(original, street), distance_m: null, duration_s: null,
        reason: 'Смещение не является рассчитанным подходом.' })
    return { index, label: value.places[index].label, start: originalStart, target: originalTarget,
        route_scope: 'street_points', street_points: { start: streetStart, target: streetTarget },
        selection_kind: value.start.road || value.places[index].road ? 'DIFFERENT_STREET_POINTS' : 'INPUT_STREET_POINTS',
        approaches: { start: approach(originalStart, streetStart, !!value.start.road),
            target: approach(originalTarget, streetTarget, !!value.places[index].road) },
        status: 'AVAILABLE', reason: 'Синтетическая проверенная дорожная часть; входы неизвестны.', checks: [],
        diagnostics: { version: 1, issues: [] }, road_choices: null,
        route: { scope: 'street_points', geometry: { type: 'LineString', coordinates: [[streetStart.lon, streetStart.lat], [streetTarget.lon, streetTarget.lat]] },
            distance_m: 1234 + index, duration_s: 480 },
        snaps: { start: { original: streetStart, matched: streetStart, distance_m: 0 },
            target: { original: streetTarget, matched: streetTarget, distance_m: 0 } },
        metrics: { distance: metric('route_distance', 1234 + index, 'm', 'street_points'),
            duration: metric('route_duration', 480, 's', 'street_points') },
        address_metrics: { distance: metric('object_to_object_distance', null, 'm', 'objects'),
            duration: metric('object_to_object_duration', null, 's', 'objects') } }
}
function walkingResponse(value) { return { mode: 'walking', route_scope: 'street_points', start: point(value.start),
    results: value.places.map((_, i) => walkingRow(value, i)),
    source: { name: 'Synthetic OSM', engine: 'ORS', engine_version: 'synthetic', profile: 'foot-walking',
        dataset_version: 'synthetic', pbf_sha256: 'synthetic', extract_sha256: 'synthetic', manifest_sha256: 'synthetic',
        observed_at: null, prepared_at: '2026-10-26T00:00:00Z', pilot_bbox: [92.8, 55.9, 93, 56.1], guard_imports: [] },
    limitation: 'Синтетическая дорожная часть; путь от объектов и подходы неизвестны.' } }
function walkingStartRefinement(value) {
    const response = walkingResponse(value), row = response.results[0]
    row.status = 'NEEDS_REFINEMENT'
    row.reason = 'Синтетический текст упоминает цель, но локализацию определяет диагностика.'
    row.checks = ['SNAP_CHOICE_REQUIRED']
    row.diagnostics = { version: 1, issues: [{ code: 'SNAP_CHOICE_REQUIRED', category: 'ambiguity', stage: 'snap', location: 'start', target_index: null }] }
    row.road_choices = { start: { status: 'NEEDS_REFINEMENT', point: null, checks: ['SNAP_CHOICE_REQUIRED'], candidates: [] },
        target: { status: 'SELECTED', point: row.street_points.target, checks: [], candidates: [] } }
    row.route = null; row.snaps = null
    row.metrics = { distance: metric('route_distance', null, 'm', 'street_points'), duration: metric('route_duration', null, 's', 'street_points') }
    return response
}
function carResponse(value) { return { mode: 'driving', start: point(value.start),
    results: value.places.map((place, index) => ({ index, label: place.label, start: point(value.start), target: point(place),
        status: 'AVAILABLE', reason: 'Синтетический автомобильный ответ.', checks: [], diagnostics: { version: 1, issues: [] },
        route: { geometry: { type: 'LineString', coordinates: [[value.start.lon, value.start.lat], [place.lon, place.lat]] }, distance_m: 2100, duration_s: 390 },
        snaps: { start: { original: point(value.start), matched: point(value.start), distance_m: 0 },
            target: { original: point(place), matched: point(place), distance_m: 0 } },
        road_choices: null, metrics: { distance: { value: 2100 }, duration: { value: 390 } } })),
    source: null, limitation: 'Синтетический автомобильный ответ.' } }
async function install(page) {
    const calls = []
    let reply = value => value.mode === 'walking' ? walkingResponse(value) : carResponse(value)
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} } } }))
    await page.route('**/api/v1/trips/analyze', async route => {
        const request = route.request(), value = request.postDataJSON()
        calls.push({ value, url: request.url(), headers: request.headers() })
        const result = await reply(value)
        try { await route.fulfill({ json: result }) } catch { /* The UI may abort an obsolete request. */ }
    })
    return { calls, respond(fn) { reply = fn } }
}
const tripMode = page => page.getByRole('combobox', { name: 'Режим маршрута', exact: true })
const compareMode = page => page.locator('#comparison-trip-mode')
const distance = page => page.locator('.personal-distance')
async function noOverflow(page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true) }
function privateCalls(calls) {
    for (const call of calls) {
        expect(new URL(call.url).search).toBe('')
        expect(call.headers.referer).toBeUndefined()
    }
}

test('walking /trips keeps original objects separate from selected streets and shows street-only measures', async ({ page, api }, testInfo) => {
    const service = await install(page)
    await page.goto(tripLink(selected))
    await expect(tripMode(page)).toHaveValue('walking')
    await expect(page.locator('#trip-result-0 .walking-values')).toContainText('1,2 км')
    expect(service.calls).toHaveLength(1)
    expect(service.calls[0].value).toEqual({ mode: selected.mode, start: selected.start, places: selected.places })
    const row = walkingResponse(selected).results[0]
    expect(row.start).toEqual(start); expect(row.target).toEqual(point(target))
    expect(row.street_points).toEqual({ start: startStreet, target: targetStreet })
    expect(row.approaches.start.distance_m).toBeNull()
    expect(row.address_metrics.distance.value).toBeNull()
    await expect(page.locator('#trip-result-0')).toContainText('Дорожная часть между выбранными уличными точками')
    await expect(page.locator('#trip-result-0')).toContainText('Выбраны другие уличные точки')
    await expect(page.locator('#trip-result-0')).toContainText('Расстояние и время подхода неизвестны')
    await expect(page.locator('#trip-result-0')).not.toContainText('модельное время без актуальных пробок')
    await expect(page.locator('.trip-sources')).toContainText('ORS')
    await expect.poll(() => page.evaluate(async () => {
        const source = window.__smokeMapIn('#trip-map')?.getSource('trips')
        if (!source) return null
        const features = (await source.getData()).features
        return { routes: features.filter(feature => feature.properties.kind === 'route').map(feature => feature.geometry.coordinates),
            connectors: features.filter(feature => feature.properties.kind === 'connector').length }
    })).toEqual({ routes: [[[startStreet.lon, startStreet.lat], [targetStreet.lon, targetStreet.lat]]], connectors: 0 })
    await noOverflow(page)
    privateCalls(service.calls)
    await screenshot(page, testInfo, 'trips-walking')
    await page.locator('#trip-result-0').scrollIntoViewIfNeeded()
    await screenshot(page, testInfo, 'trips-walking-result')
})

test('walking /trips explicit street pick keeps the original target and zero shift is shown as zero', async ({ page, api }) => {
    const service = await install(page)
    await page.goto(tripLink({ ...selected, start, places: [target] }))
    await expect(page.locator('.walking-values')).toHaveCount(1)
    await expect(page.locator('#trip-result-0 .walking-endpoint').first()).toContainText('Геометрическое смещение объекта к улице: 0 м')
    const count = service.calls.length
    await page.getByRole('button', { name: 'Выбрать улицу места 1 на карте', exact: true }).press('Enter')
    await expect(page.locator('.trip-map-controls')).toContainText(/Место 1.*дорожная точка/)
    await page.locator('#trip-map canvas').press('ArrowRight')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('#trip-map')?.isMoving())).toBe(false)
    await page.getByRole('button', { name: 'Выбрать центр карты', exact: true }).press('Enter')
    await expect.poll(() => service.calls.length).toBe(count + 1)
    const chosen = service.calls.at(-1).value
    expect(chosen.mode).toBe('walking')
    expect(chosen.places[0].lon).toBe(target.lon)
    expect(chosen.places[0].lat).toBe(target.lat)
    expect(chosen.places[0].road).toBeDefined()
    expect(chosen.places[0].road).not.toEqual(point(target))
    await expect(page.locator('#trip-result-0')).toContainText('Расстояние и время подхода неизвестны')
    await noOverflow(page)
    privateCalls(service.calls)
})

test('walking /trips no-candidate refinement opens the street picker from summary and primary actions', async ({ page, api }) => {
    const service = await install(page)
    service.respond(value => value.start.road ? walkingResponse(value) : walkingStartRefinement(value))
    await page.goto(tripLink({ ...selected, start, places: [target] }))
    const failure = page.locator('#trip-result-0')
    await expect(failure).toHaveAttribute('data-status', 'NEEDS_REFINEMENT')
    await expect(failure).toHaveAttribute('data-awaiting-choice', 'true')
    await expect(failure).toContainText('Выберите дорожную точку старта')
    await expect(failure.locator('.trip-candidates')).toHaveCount(0)
    await expect(failure.locator('.walking-values')).toHaveCount(0)
    await expect(failure).toContainText('Полный путь между исходными объектами неизвестен')
    expect(service.calls).toHaveLength(1)
    const original = point(service.calls[0].value.start)

    await page.getByRole('button', { name: 'Выбрать вариант, место 1', exact: true }).press('Enter')
    await expect(page.locator('.trip-map-controls')).toContainText('Старт — дорожная точка')
    await expect(page.locator('#trip-map canvas')).toBeFocused()
    expect(service.calls).toHaveLength(1)
    await failure.getByRole('button', { name: 'Выбрать вариант', exact: true }).press('Enter')
    await expect(page.locator('#trip-map canvas')).toBeFocused()
    expect(service.calls).toHaveLength(1)

    await page.locator('#trip-map canvas').press('ArrowRight')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('#trip-map')?.isMoving())).toBe(false)
    await page.getByRole('button', { name: 'Выбрать центр карты', exact: true }).press('Enter')
    await expect.poll(() => service.calls.length).toBe(2)
    await expect(failure.locator('.walking-values')).toHaveCount(1)
    expect(point(service.calls.at(-1).value.start)).toEqual(original)
    expect(service.calls.at(-1).value.start.road).toBeDefined()
    await expect(failure).toContainText('Расстояние и время подхода неизвестны')
    await noOverflow(page)
    privateCalls(service.calls)
})

test('walking /trips mode switch clears routes and hints without a hidden POST; late answer stays obsolete', async ({ page, api }) => {
    const service = await install(page)
    await page.goto(tripLink(selected))
    await expect(page.locator('.walking-values')).toHaveCount(1)
    const count = service.calls.length
    await tripMode(page).selectOption('driving')
    await expect(tripMode(page)).toHaveValue('driving')
    await expect(page.locator('.walking-values')).toHaveCount(0)
    expect(service.calls).toHaveLength(count)
    const saved = JSON.parse(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('trip'))
    expect(saved.mode).toBe('driving')
    expect(saved.start).toEqual(start)
    expect(saved.places[0]).toEqual(target)
    await tripMode(page).focus(); await tripMode(page).press('ArrowDown')
    await expect(tripMode(page)).toHaveValue('walking')
    expect(service.calls).toHaveLength(count)
    await page.locator('#trip-form').getByRole('button', { name: 'Рассчитать поездки', exact: true }).press('Enter')
    await expect(page.locator('.walking-values')).toHaveCount(1)
    expect(service.calls.at(-1).value.mode).toBe('walking')
    expect(service.calls.at(-1).value.start.road).toBeUndefined()
    expect(service.calls.at(-1).value.places[0].road).toBeUndefined()
    await expect(page.locator('#trip-result-0')).not.toContainText('Выбраны другие уличные точки')
    const current = service.calls.length
    let release
    service.respond(value => new Promise(resolve => { release = () => resolve(walkingResponse(value)) }))
    await page.locator('#trip-form').getByRole('button', { name: 'Рассчитать поездки', exact: true }).press('Enter')
    await expect.poll(() => typeof release).toBe('function')
    await tripMode(page).selectOption('driving')
    await expect(page.locator('.walking-values')).toHaveCount(0)
    release()
    await expect(page.locator('.walking-values')).toHaveCount(0)
    expect(service.calls).toHaveLength(current + 1)
    await noOverflow(page)
    privateCalls(service.calls)
})

test('walking /compare restores mode and street-only pair, preserves address pair in ordinary share', async ({ page, context, api }, testInfo) => {
    const service = await install(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const roads = { left: { 'goal-0': { start: startStreet, target: targetStreet } }, right: { 'goal-0': {} } }
    await page.goto(compareLink(compareSelection('walking', roads))); await ready(page)
    await expect(compareMode(page)).toHaveValue('walking')
    await expect(distance(page)).toHaveCount(2)
    expect(service.calls).toHaveLength(2)
    for (const call of service.calls) expect(call.value.mode).toBe('walking')
    const left = service.calls.find(call => call.value.start.lon === places.a.lon)
    expect(left.value.start).toEqual({ lon: places.a.lon, lat: places.a.lat, road: startStreet })
    expect(left.value.places[0]).toEqual({ ...point(target), label: target.label, road: targetStreet })
    await expect(page.locator('#personal-trip-left-goal-0')).toContainText('Только уличная часть')
    await expect(page.locator('#personal-trip-left-goal-0')).toContainText('модель уличной части')
    await expect(page.locator('#comparison-personal-trips')).toContainText('Полный путь от объектов и подходы не рассчитаны')
    await page.locator('#personal-trip-left-goal-0').scrollIntoViewIfNeeded()
    await screenshot(page, testInfo, 'compare-walking')
    await page.locator('.comparison-share summary').press('Enter')
    await page.getByRole('button', { name: 'Ссылка на сравнение адресов', exact: true }).press('Enter')
    expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('#')
    await page.getByRole('button', { name: 'Ссылка с личными местами', exact: true }).press('Enter')
    const personal = await page.evaluate(() => navigator.clipboard.readText())
    expect(personal).toContain('#places=')
    expect(JSON.parse(new URLSearchParams(new URL(personal).hash.slice(1)).get('places'))).toMatchObject({ version: 2, mode: 'walking' })
    await noOverflow(page)
    privateCalls(service.calls)
})

test('walking /compare street choice is local to one pair and keeps the original goal', async ({ page, api }) => {
    const service = await install(page)
    await page.goto(compareLink(compareSelection())); await ready(page)
    await expect(distance(page)).toHaveCount(2)
    const count = service.calls.length
    const left = page.locator('#personal-trip-left-goal-0')
    await left.locator('.personal-refine summary').press('Enter')
    await left.getByRole('button', { name: 'Уличная точка цели А', exact: true }).press('Enter')
    await mapReady(page)
    await page.locator('#compare-map-left canvas').press('ArrowRight')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('#compare-map-left')?.isMoving())).toBe(false)
    await page.getByRole('button', { name: 'Выбрать центр карты', exact: true }).press('Enter')
    await page.locator('.comparison-map-return').press('Enter')
    await expect(left.locator('.personal-distance')).toHaveCount(0)
    await expect(page.locator('#personal-trip-right-goal-0 .personal-distance')).toHaveCount(1)
    expect(service.calls).toHaveLength(count)
    await left.getByRole('button', { name: 'Рассчитать А', exact: true }).press('Enter')
    await expect(left.locator('.personal-distance')).toHaveCount(1)
    expect(service.calls).toHaveLength(count + 1)
    const chosen = service.calls.at(-1).value
    expect(chosen.mode).toBe('walking')
    expect(chosen.start).toEqual({ lon: places.a.lon, lat: places.a.lat })
    expect(point(chosen.places[0])).toEqual(point(target))
    expect(chosen.places[0].road).toBeDefined()
    await noOverflow(page)
    privateCalls(service.calls)
})

test('walking /compare mode switch clears both cells and map route without POST, then reload rechecks chosen mode', async ({ page, api }) => {
    const service = await install(page)
    await page.goto(compareLink(compareSelection())); await ready(page)
    await expect(distance(page)).toHaveCount(2)
    await page.locator('#personal-trip-left-goal-0').getByRole('button', { name: 'Показать маршрут А', exact: true }).press('Enter')
    await mapReady(page)
    const count = service.calls.length
    if (page.viewportSize().width < 1100) await page.locator('.comparison-map-return').press('Enter')
    await compareMode(page).selectOption('driving')
    await expect(distance(page)).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => {
        const source = window.__smokeMapIn('#compare-map-left')?.getSource('trips')
        return source ? (await source.getData()).features.filter(feature => feature.properties.kind === 'route').length : 0
    })).toBe(0)
    expect(service.calls).toHaveLength(count)
    const saved = JSON.parse(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('places'))
    expect(saved.version).toBe(1)
    expect(saved.mode).toBe('driving')
    expect(saved.places[0].point).toEqual(point(target))
    await page.reload(); await ready(page)
    await expect(distance(page)).toHaveCount(2)
    expect(service.calls.slice(count).map(call => call.value.mode)).toEqual(['driving', 'driving'])
    await compareMode(page).focus(); await compareMode(page).press('ArrowDown')
    await expect(compareMode(page)).toHaveValue('walking')
    await expect(distance(page)).toHaveCount(0)
    expect(service.calls).toHaveLength(count + 2)
    await noOverflow(page)
    privateCalls(service.calls)
})

test('legacy v1 /compare fragment without mode still restores car routing', async ({ page, api }) => {
    const service = await install(page)
    const legacy = compareSelection('driving')
    delete legacy.mode
    await page.goto(compareLink(legacy)); await ready(page)
    await expect(compareMode(page)).toHaveValue('driving')
    await expect(distance(page)).toHaveCount(2)
    expect(service.calls.map(call => call.value.mode)).toEqual(['driving', 'driving'])
    privateCalls(service.calls)
})

test('walking /compare discards delayed replies after a mode change', async ({ page, api }) => {
    const service = await install(page)
    await page.goto(compareLink(compareSelection())); await ready(page)
    await expect(distance(page)).toHaveCount(2)
    const count = service.calls.length, releases = []
    service.respond(value => new Promise(resolve => { releases.push(() => resolve(walkingResponse(value))) }))
    await page.getByRole('button', { name: 'Рассчитать поездки А/Б', exact: true }).press('Enter')
    await expect.poll(() => releases.length).toBe(2)
    await compareMode(page).selectOption('driving')
    await expect(distance(page)).toHaveCount(0)
    for (const release of releases) release()
    await expect(distance(page)).toHaveCount(0)
    expect(service.calls).toHaveLength(count + 2)
    await noOverflow(page)
    privateCalls(service.calls)
})
