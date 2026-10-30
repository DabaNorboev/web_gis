import { test, expect } from './support.mjs'
import { writeFile } from 'node:fs/promises'
import { places } from './fixtures.mjs'
import { carResponse, walkingResponse } from './fixtures/home-trips.mjs'

const root = (two = true) => '/?' + new URLSearchParams({ left: places.a.id, ...(two ? { right: places.b.id } : {}), radius_m: '500' })
const shared = (mode = 'driving') => ({ version: mode === 'walking' ? 2 : 1, mode, places: [{ id: 'stable-goal', label: 'Работа', point: { lon: 92.91, lat: 56.03 } }], roads: {} })
const independent = (mode = 'driving') => ({ version: 1, mode, start: { lon: 92.87, lat: 56.01 }, places: [{ lon: 92.89, lat: 56.02, label: 'Семья' }] })
const hash = (addresses, standalone) => '#' + new URLSearchParams({ ...(addresses ? { places: JSON.stringify(addresses) } : {}), ...(standalone ? { trip: JSON.stringify(standalone) } : {}) })
const panel = page => page.getByRole('region', { name: 'Поездки единого пространства', exact: true })
const editor = page => page.getByRole('region', { name: 'Редактор поездок', exact: true })
const scenario = (page, name) => page.getByRole('group', { name: 'Сценарий', exact: true }).getByRole('button', { name, exact: true })
const entry = (page, side = 'А') => panel(page).getByRole('article', { name: `${side} → Работа`, exact: true })
const view = (page, label) => page.getByRole('group', { name: 'Рабочая область', exact: true }).getByRole('button', { name: label, exact: true })
async function results(page) { if (await view(page, 'Результаты и ввод').isVisible()) await view(page, 'Результаты и ввод').press('Enter') }
async function showMap(page) { if (await view(page, 'Карта').isVisible()) await view(page, 'Карта').press('Enter') }
async function workspace(page) { await page.addInitScript(() => localStorage.setItem('placelens:interface:v1', 'workspace')) }
async function readyProfiles(page, two = true) {
    for (const side of two ? ['А', 'Б'] : ['А']) await expect(page.getByLabel(`Состояние ${side}`, { exact: true })).toHaveAttribute('aria-busy', 'false')
}
async function install(page) {
    const calls = []; let reply = value => value.mode === 'walking' ? walkingResponse(value) : carResponse(value)
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} } } }))
    await page.route('**/api/v1/trips/analyze', async route => {
        const value = route.request().postDataJSON(); calls.push(value)
        const response = await reply(value)
        await route.fulfill(response === 'error' ? { status: 503, json: {} } : { json: response })
    })
    return { calls, respond(fn) { reply = fn } }
}
async function search(page, scope, place) {
    const input = scope.getByRole('combobox', { name: 'Адрес в Красноярске', exact: true })
    await input.fill(place.label)
    await expect(scope.getByRole('listbox', { name: 'Найденные адреса' }).getByRole('option')).toHaveCount(1)
    await input.press('ArrowDown'); await input.press('Enter')
}
async function routeData(page) { return page.evaluate(async () => window.__smokeMapIn('.placelens-map')?.getSource('trips')?.getData()) }
async function settled(page) { await expect.poll(() => page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return !!m && m.loaded() && !m.isMoving() })).toBe(true) }
async function camera(page) { return page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return [m.getCenter().toArray(), m.getZoom()] }) }
async function replaceA(page) {
    await page.getByRole('button', { name: 'Заменить адрес А', exact: true }).press('Enter')
    await search(page, page.locator('#home-panel .place-search'), places.c)
}

test('home full keyboard flow: one address, shared goal, pair, modes, route, replacement and preserved interfaces', async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Добавить адрес А', exact: true }).press('Enter')
    await search(page, page.locator('#home-panel .place-search'), places.a); await readyProfiles(page, false)
    await page.getByRole('tablist', { name: 'Раздел результатов' }).getByRole('tab', { name: 'Поездки', exact: true }).press('Enter')
    await editor(page).getByRole('button', { name: 'Добавить общую цель', exact: true }).press('Enter')
    await editor(page).getByLabel('Название общей цели', { exact: true }).fill('Работа')
    await editor(page).locator('.goal-point-editor > summary').press('Enter')
    await search(page, editor(page).getByRole('region', { name: /Поиск и подпись: Общая цель/ }), places.d)
    expect(service.calls).toHaveLength(0)
    await editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true }).press('Enter')
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible(); expect(service.calls).toHaveLength(1)
    await page.getByRole('button', { name: 'Добавить адрес Б', exact: true }).press('Enter')
    await search(page, page.locator('#home-panel .place-search'), places.b); await readyProfiles(page)
    expect(service.calls).toHaveLength(1)
    await page.getByRole('tablist', { name: 'Раздел результатов' }).getByRole('tab', { name: 'Поездки', exact: true }).press('Enter')
    await editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true }).press('Enter')
    await expect(entry(page, 'Б').getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible(); expect(service.calls).toHaveLength(3)
    await editor(page).getByLabel('Общий режим поездок').selectOption('walking')
    expect(service.calls).toHaveLength(3)
    await editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true }).press('Enter')
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    expect(service.calls).toHaveLength(5); expect(service.calls.at(-1).mode).toBe('walking')
    await entry(page).getByRole('button', { name: 'Показать маршрут', exact: true }).press('Enter'); await settled(page)
    await expect.poll(async () => (await routeData(page))?.features.filter(f => f.properties.kind === 'route').length).toBe(1)
    const before = await camera(page), url = page.url(), history = await page.evaluate(() => window.history.length)
    const ui = page.getByRole('group', { name: 'Интерфейс', exact: true })
    await ui.getByRole('button', { name: 'Текущий', exact: true }).press('Enter')
    await ui.getByRole('button', { name: 'Новый', exact: true }).press('Enter'); await settled(page)
    expect(await camera(page)).toEqual(before); expect(page.url()).toBe(url); expect(await page.evaluate(() => window.history.length)).toBe(history)
    expect(service.calls).toHaveLength(5); await expect(page.locator('.placelens-map canvas')).toHaveCount(1)
    await page.screenshot({ path: test.info().outputPath('home-trips-filled-map.png'), fullPage: true })
    await results(page); await replaceA(page)
    await page.getByRole('tablist', { name: 'Раздел результатов' }).getByRole('tab', { name: 'Поездки', exact: true }).press('Enter')
    await expect(entry(page, 'Б').getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await expect(entry(page)).toContainText('Нужен расчёт'); expect(service.calls).toHaveLength(5)
    await entry(page).getByRole('button', { name: 'Рассчитать эту поездку', exact: true }).press('Enter')
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible(); expect(service.calls).toHaveLength(6)
    expect(service.calls.at(-1).start.lon).toBe(places.c.lon)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('home-trips-filled-results.png'), fullPage: true })
})

test('home fragments wait for each profile, restore once, preserve private drafts, ordinary sharing and history', async ({ page, api }) => {
    await workspace(page); const service = await install(page); const gate = api.hold(places.b)
    await page.addInitScript(() => { window.__copies = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.__copies.push(text) } }) })
    await page.goto(root() + hash(shared('walking'), independent('walking')))
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    expect(service.calls).toHaveLength(2) // standalone + ready A, never waiting B
    const initial = page.url(), h = await page.evaluate(() => history.length)
    await page.getByRole('button', { name: 'Показать А', exact: true }).press('Enter')
    await page.getByRole('tablist', { name: 'Раздел результатов' }).getByRole('tab', { name: 'Поездки', exact: true }).press('Enter')
    gate.release(); await expect(entry(page, 'Б').getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    expect(service.calls).toHaveLength(3); expect(page.url()).toBe(initial); expect(await page.evaluate(() => history.length)).toBe(h)
    await scenario(page, 'Отдельная поездка').press('Enter')
    await expect(panel(page)).toContainText('Семья'); await expect(panel(page).getByRole('article', { name: 'Старт → Семья' })).toContainText('1,2 км')
    await scenario(page, 'Адреса').press('Enter')
    await page.getByRole('tablist', { name: 'Раздел результатов' }).getByRole('tab', { name: 'Поездки', exact: true }).press('Enter')
    await page.locator('.comparison-share summary').press('Enter')
    await page.getByRole('button', { name: 'Ссылка на сравнение адресов', exact: true }).press('Enter')
    await page.getByRole('button', { name: 'Ссылка с личными местами', exact: true }).press('Enter')
    const copies = await page.evaluate(() => window.__copies)
    expect(new URL(copies[0]).hash).toBe(''); expect(new URL(copies[0]).searchParams.get('left')).toBe(places.a.id)
    expect(new URLSearchParams(new URL(copies[1]).hash.slice(1)).has('places')).toBe(true)
    expect(new URLSearchParams(new URL(copies[1]).hash.slice(1)).has('trip')).toBe(true)
    await page.locator('.comparison-share summary').press('Escape')
    const input = editor(page).getByLabel('Название общей цели', { exact: true }); await input.fill('Работа переименована')
    expect(await page.evaluate(() => history.length)).toBe(h); expect(service.calls).toHaveLength(3)
    await page.getByRole('button', { name: 'Убрать А', exact: true }).press('Enter')
    const afterEdit = service.calls.length
    await page.goBack(); await expect.poll(() => service.calls.length).toBe(afterEdit + 1)
    expect(await page.evaluate(() => history.length)).toBe(h + 1)
    await page.goForward(); expect(service.calls).toHaveLength(afterEdit + 1)
    await page.reload(); await expect.poll(() => service.calls.length).toBe(afterEdit + 3) // B + standalone only
    expect(new URL(page.url()).search).not.toContain('road')
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('Семья')
})

test('home standalone starts and goals use the common map with keyboard, retain separate goals and recheck street edits', async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    await page.goto(root(false) + hash(shared()))
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await scenario(page, 'Отдельная поездка').press('Enter')
    await editor(page).getByRole('button', { name: 'Выбрать старт на карте', exact: true }).press('Enter'); await settled(page)
    await page.getByRole('button', { name: 'Выбрать центр карты', exact: true }).press('Enter')
    await editor(page).getByRole('button', { name: 'Выбрать отдельную цель на карте', exact: true }).press('Enter')
    await page.locator('.placelens-map canvas').press('ArrowRight')
    await page.getByRole('button', { name: 'Выбрать центр карты', exact: true }).press('Enter')
    await editor(page).getByLabel('Название отдельной цели', { exact: true }).fill('Своя цель')
    expect(service.calls).toHaveLength(1)
    await editor(page).getByRole('button', { name: 'Рассчитать от произвольного старта', exact: true }).press('Enter')
    const row = panel(page).getByRole('article', { name: 'Старт → Своя цель' })
    await expect(row.getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible(); expect(service.calls).toHaveLength(2)
    await row.getByRole('button', { name: 'Подробности поездки: Старт → Своя цель', exact: true }).press('Enter')
    await page.getByRole('dialog').getByRole('button', { name: 'Дорожная точка цели', exact: true }).press('Enter')
    await page.getByRole('button', { name: 'Выбрать центр карты', exact: true }).press('Enter')
    await expect(row.getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible(); expect(service.calls).toHaveLength(3)
    expect(service.calls.at(-1).places[0].road).toBeTruthy()
    await scenario(page, 'Адреса').press('Enter')
    await page.getByRole('tablist', { name: 'Раздел результатов' }).getByRole('tab', { name: 'Поездки', exact: true }).press('Enter')
    await expect(editor(page).getByLabel('Название общей цели', { exact: true })).toHaveValue('Работа')
    expect(service.calls).toHaveLength(3)
})

test('home failures, late responses and changed goals or addresses stay independent', async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    service.respond(value => value.start.lon === places.a.lon ? 'error' : carResponse(value))
    await page.goto(root() + hash(shared()))
    await expect(entry(page)).toContainText('Расчёт не получен')
    await expect(entry(page, 'Б').getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    service.respond(carResponse)
    await entry(page).getByRole('button', { name: 'Повторить эту поездку', exact: true }).press('Enter')
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible(); expect(service.calls).toHaveLength(3)
    // A real fetch response can finish after its request was invalidated.
    await page.evaluate(() => { const fetch = window.fetch.bind(window); window.fetch = async (input, init) => {
        const response = await fetch(input, String(input).includes('/trips/analyze') ? { ...init, signal: undefined } : init)
        return response
    } })
    let release; const held = new Promise(resolve => { release = resolve })
    service.respond(async value => { await held; return carResponse(value) })
    await editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true }).press('Enter')
    await expect.poll(() => service.calls.length).toBe(5)
    await replaceA(page)
    await page.getByRole('tablist', { name: 'Раздел результатов' }).getByRole('tab', { name: 'Поездки', exact: true }).press('Enter')
    release(); await expect(entry(page, 'Б').getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await expect(entry(page)).toContainText('Нужен расчёт')
    await editor(page).getByRole('button', { name: 'Удалить общую цель Работа', exact: true }).press('Enter')
    expect(service.calls).toHaveLength(5); await expect(panel(page).locator('.trip-result')).toHaveCount(0)
    expect(new URL(page.url()).hash).toBe('')
})

for (const cancel of [false, true]) test(`home early explicit route focus ${cancel ? 'cancels on goal removal' : 'waits for real map readiness'}`, async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    let release; const gate = new Promise(resolve => { release = resolve })
    await page.route('**/smoke-background.json', async route => { await gate; await route.fulfill({ json: { type: 'FeatureCollection', features: [] } }) })
    await page.goto(root(false) + hash(shared()))
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await page.evaluate(() => {
        const map = window.__smokeMapIn('.placelens-map'), fit = map.fitBounds.bind(map)
        window.__homeFits = []
        map.fitBounds = (bounds, options) => { window.__homeFits.push(bounds); return fit(bounds, options) }
    })
    await entry(page).getByRole('button', { name: 'Показать маршрут', exact: true }).press('Enter')
    if (cancel) {
        await results(page); await editor(page).getByRole('button', { name: 'Удалить общую цель Работа', exact: true }).press('Enter')
        await showMap(page)
    }
    const before = await camera(page); release(); await settled(page)
    if (cancel) expect(await page.evaluate(() => window.__homeFits.filter(bounds => bounds[1][0] >= 92.91))).toHaveLength(0)
    else {
        await expect.poll(async () => JSON.stringify(await camera(page)) !== JSON.stringify(before)).toBe(true)
        const data = await routeData(page); expect(data.features.filter(f => f.properties.kind === 'route')).toHaveLength(1)
        const focused = await camera(page)
        await page.getByRole('button', { name: 'Тёмная', exact: true }).press('Enter')
        await settled(page); expect(await camera(page)).toEqual(focused)
    }
    expect(service.calls).toHaveLength(1)
})

test('home street candidates use the real canvas, preserve endpoints and never focus after a new response', async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    service.respond(value => {
        if (value.places[0].road) return walkingResponse(value)
        const response = walkingResponse(value), row = response.results[0], p = value.places[0]
        row.status = 'NEEDS_REFINEMENT'; row.route = null; row.snaps = null
        row.metrics.distance.value = null; row.metrics.duration.value = null
        row.diagnostics.issues = [{ code: 'SNAP_CHOICE_REQUIRED', category: 'ambiguity', stage: 'snap', location: 'target', target_index: 0 }]
        row.road_choices = { start: { status: 'SELECTED', point: value.start, candidates: [] }, target: { status: 'CHOOSE', candidates: [
            { point: { lon: p.lon + .001, lat: p.lat }, distance_m: 4, name: 'Проверяемая улица' },
        ] } }
        return response
    })
    await page.goto(root() + hash(shared('walking')))
    await expect(entry(page).getByRole('button', { name: 'Варианты на карте', exact: true })).toBeVisible()
    await entry(page).getByRole('button', { name: 'Варианты на карте', exact: true }).press('Enter'); await settled(page)
    const original = await routeData(page), before = await camera(page)
    const coords = await page.evaluate(async () => {
        const m = window.__smokeMapIn('.placelens-map'), data = await m.getSource('trips').getData()
        const feature = data.features.find(f => f.properties.kind === 'candidate'), p = m.project(feature.geometry.coordinates)
        return { x: p.x, y: p.y }
    })
    await page.locator('.placelens-map canvas').click({ position: coords })
    await expect.poll(() => service.calls.length).toBe(3)
    await expect.poll(async () => (await routeData(page)).features.filter(f => f.properties.kind === 'route').length).toBe(1)
    expect(service.calls.at(-1).places[0].road).toEqual({ lon: 92.911, lat: 56.03 })
    expect(service.calls.at(-1).places[0].lon).toBe(92.91)
    expect((await routeData(page)).features.filter(f => f.properties.kind === 'original')).toEqual(original.features.filter(f => f.properties.kind === 'original'))
    await settled(page); expect(await camera(page)).toEqual(before)
    await page.locator('.placelens-map canvas').click({ position: coords }) // old candidate is no longer offered
    expect(service.calls).toHaveLength(3)
    await results(page)
    await expect(entry(page, 'Б').getByRole('button', { name: 'Варианты на карте', exact: true })).toBeVisible()
    expect(api.calls.filter(url => url.includes('/transport/analysis'))).toHaveLength(0)
})

test('home editing or removing a goal during a request rejects late rows and never turns the map into point analysis', async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    await page.addInitScript(() => { const fetch = window.fetch.bind(window); window.fetch = async (input, init) => {
        const response = await fetch(input, String(input).includes('/trips/analyze') ? { ...init, signal: undefined } : init)
        if (String(input).includes('/trips/analyze')) { const json = response.json.bind(response); response.json = async () => { const body = await json(); window.__lateHomeTrips = (window.__lateHomeTrips ?? 0) + 1; return body } }
        return response
    } })
    let release; const wait = new Promise(resolve => { release = resolve })
    service.respond(async value => { await wait; return carResponse(value) })
    await page.goto(root() + hash(shared()))
    await expect.poll(() => service.calls.length).toBe(2)
    await editor(page).locator('.goal-point-editor > summary').press('Enter')
    await editor(page).getByRole('button', { name: 'Выбрать цель на карте', exact: true }).press('Enter')
    await settled(page); await page.getByRole('button', { name: 'Выбрать центр карты', exact: true }).press('Enter')
    await editor(page).getByRole('button', { name: 'Удалить общую цель Работа', exact: true }).press('Enter')
    release(); await expect.poll(() => page.evaluate(() => window.__lateHomeTrips)).toBe(2)
    await expect(panel(page).locator('.trip-result')).toHaveCount(0)
    await showMap(page); await expect.poll(async () => (await routeData(page)).features.length).toBe(0)
    expect(api.calls.filter(url => url.includes('/transport/analysis'))).toHaveLength(0)
    expect(service.calls).toHaveLength(2)
})

test('home early focus is cancelled by a newer request sequence and is never replayed for the reply', async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    let release; const wait = new Promise(resolve => { release = resolve })
    await page.route('**/smoke-background.json', async route => { await wait; await route.fulfill({ json: { type: 'FeatureCollection', features: [] } }) })
    await page.goto(root(false) + hash(shared()))
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'), fit = m.fitBounds.bind(m); window.__homeFits = []; m.fitBounds = (bounds, options) => { window.__homeFits.push(bounds); return fit(bounds, options) } })
    await entry(page).getByRole('button', { name: 'Показать маршрут', exact: true }).press('Enter')
    await results(page)
    await editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true }).press('Enter')
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await showMap(page); release(); await settled(page)
    expect(await page.evaluate(() => window.__homeFits.filter(bounds => bounds[1][0] >= 92.91))).toHaveLength(0)
    expect(service.calls).toHaveLength(2)
})

test('home walking standalone link survives removal and reload of the independent shared draft; conflicting modes are explicit', async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    await page.goto(root(false) + hash(shared('walking'), independent('walking')))
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    expect(service.calls).toHaveLength(2)
    await editor(page).getByRole('button', { name: 'Удалить общую цель Работа', exact: true }).press('Enter')
    await scenario(page, 'Отдельная поездка').press('Enter')
    await expect(panel(page).getByRole('article', { name: 'Старт → Семья' }).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    const url = page.url(); await page.reload()
    await expect(scenario(page, 'Отдельная поездка')).toHaveAttribute('aria-pressed', 'true')
    await scenario(page, 'Отдельная поездка').press('Enter')
    await expect(panel(page).getByRole('article', { name: 'Старт → Семья' }).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    expect(service.calls).toHaveLength(3); expect(service.calls.at(-1).mode).toBe('walking'); expect(page.url()).toBe(url)
    await page.goto(root(false) + hash(shared('walking'), independent('driving')))
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    expect(service.calls).toHaveLength(4)
    await scenario(page, 'Отдельная поездка').press('Enter')
    await expect(editor(page)).toContainText('Отдельный сценарий из ссылки не восстановлен')
    await expect(editor(page).getByLabel('Общий режим поездок')).toHaveValue('walking')
})

test('home route and camera survive basemap failure, retry, themes and panel resize without another analysis', async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    await page.route('**/smoke-background.json', route => route.abort('connectionfailed'))
    await page.goto(root() + hash(shared()))
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await entry(page).getByRole('button', { name: 'Показать маршрут', exact: true }).press('Enter'); await settled(page)
    const before = await camera(page), data = await routeData(page)
    const notice = page.locator('.placelens-map .city-map-resource-status')
    await expect(notice).toContainText('Подложка загружена не полностью. Анализ сохранён.')
    const bounds = await notice.evaluate(element => {
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
        const range = document.createRange(); range.selectNodeContents(element.querySelector('span'))
        return { viewport: { width: innerWidth, height: innerHeight }, map: rect(element.closest('.city-map')), frame: rect(element.closest('.placelens-map')),
            notice: rect(element), button: rect(element.querySelector('button')), translate: getComputedStyle(element).translate,
            text: [...range.getClientRects()].map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height })),
            clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }
    })
    const boundsPath = test.info().outputPath('basemap-status-bounds.json')
    await writeFile(boundsPath, JSON.stringify(bounds, null, 2))
    await test.info().attach('basemap-status-bounds', { path: boundsPath, contentType: 'application/json' })
    await page.screenshot({ path: test.info().outputPath('basemap-status.png'), fullPage: false })
    expect(bounds.viewport).toEqual(page.viewportSize())
    for (const outer of [bounds.map, bounds.frame, { x: 0, y: 0, right: bounds.viewport.width, bottom: bounds.viewport.height }]) {
        for (const inner of [bounds.notice, bounds.button, ...bounds.text]) {
            expect(inner.width).toBeGreaterThan(0); expect(inner.height).toBeGreaterThan(0)
            expect(inner.x).toBeGreaterThanOrEqual(outer.x - 1); expect(inner.right).toBeLessThanOrEqual(outer.right + 1)
            expect(inner.y).toBeGreaterThanOrEqual(outer.y - 1); expect(inner.bottom).toBeLessThanOrEqual(outer.bottom + 1)
        }
    }
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth)
    expect(bounds.scrollHeight).toBeLessThanOrEqual(bounds.clientHeight)
    await results(page)
    await expect(entry(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await expect(entry(page, 'Б').getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await showMap(page)
    await page.unroute('**/smoke-background.json')
    await page.getByRole('button', { name: 'Повторить загрузку подложки', exact: true }).press('Enter'); await settled(page)
    await expect(notice).toHaveCount(0)
    for (const name of ['Тёмная', 'Улицы', 'Светлая']) {
        await page.getByRole('button', { name, exact: true }).press('Enter'); await settled(page)
        expect(await routeData(page)).toEqual(data); expect(await camera(page)).toEqual(before)
    }
    const size = page.viewportSize(); await page.setViewportSize({ width: size.width, height: size.height - 20 }); await settled(page)
    expect(await routeData(page)).toEqual(data); expect(await camera(page)).toEqual(before)
    if (size.width >= 768) {
        await page.getByRole('button', { name: 'Развернуть результаты', exact: true }).press('Enter')
        await settled(page); expect(await routeData(page)).toEqual(data); expect(await camera(page)).toEqual(before)
        expect(await page.evaluate(() => {
            const frame = document.querySelector('.placelens-map').getBoundingClientRect()
            return ['.maplibregl-ctrl-zoom-in', '.maplibregl-ctrl-zoom-out', '.maplibregl-ctrl-scale', '.maplibregl-ctrl-attrib'].every(selector => {
                const r = document.querySelector('.placelens-map ' + selector).getBoundingClientRect()
                return r.top >= frame.top && r.bottom <= frame.bottom && r.left >= frame.left && r.right <= frame.right
            })
        })).toBe(true)
    }
    expect(service.calls).toHaveLength(2)
})


test('home standalone-only link opens its result without address profiles and can expand on a short screen', async ({ page, api }) => {
    await workspace(page); const service = await install(page)
    await page.goto('/' + hash(null, independent('walking')))
    const row = panel(page).getByRole('article', { name: 'Старт → Семья' })
    await expect(row.getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    expect(service.calls).toHaveLength(1)
    expect(api.calls.filter(url => url.includes('/profile?'))).toHaveLength(0)
    if (page.viewportSize().width >= 768) {
        await page.getByRole('button', { name: 'Развернуть результаты', exact: true }).press('Enter')
        await expect(page.getByRole('button', { name: 'Свернуть результаты', exact: true })).toHaveAttribute('aria-expanded', 'true')
    }
    await row.getByRole('button', { name: 'Показать маршрут', exact: true }).press('Enter'); await settled(page)
    await expect.poll(async () => (await routeData(page)).features.filter(f => f.properties.kind === 'route').length).toBe(1)
    expect(service.calls).toHaveLength(1)
})
