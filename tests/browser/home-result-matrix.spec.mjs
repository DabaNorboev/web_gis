import { test, expect } from './support.mjs'
import { places, profile } from './fixtures.mjs'
import { carResponse, walkingResponse } from './fixtures/home-trips.mjs'
const root = (two = true) => '/?' + new URLSearchParams({ left: places.a.id, ...(two ? { right: places.b.id } : {}), radius_m: '500' })
const goals = (count = 3, long = false) => ({ version: 1, mode: 'driving', places: [
    { id: 'work', label: long ? 'Работа и дополнительные занятия в другом конце города — длинное название' : 'Работа', point: { lon: 92.91, lat: 56.03 } },
    { id: 'family', label: 'Семья', point: { lon: 92.90, lat: 56.02 } },
    { id: 'study', label: 'Учёба', point: { lon: 92.89, lat: 56.04 } },
].slice(0, count), roads: {} })
const hash = selection => '#' + new URLSearchParams({ places: JSON.stringify(selection) })
const tabs = page => page.getByRole('tablist', { name: 'Раздел результатов', exact: true })
const table = page => page.getByRole('table', { name: /Общая матрица/ })
async function setup(page) {
    await page.addInitScript(() => localStorage.setItem('placelens:interface:v1', 'workspace'))
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} } } }))
    const calls = []
    await page.route('**/api/v1/trips/analyze', route => { const value = route.request().postDataJSON(); calls.push(value); const response = carResponse(value); response.source = { ...walkingResponse(value).source, engine: 'OSRM', profile: 'driving' }; return route.fulfill({ json: response }) })
    return calls
}
// One project intentionally records five exact viewports; remaining suites use all configured projects.
for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1280, height: 560 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    test(`matrix three goals and environment at ${viewport.width}x${viewport.height}`, async ({ page, api }) => {
        await page.setViewportSize(viewport); const calls = await setup(page)
        await page.goto(root() + hash(goals()))
        await expect(table(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toHaveCount(6)
        expect(calls).toHaveLength(2)
        expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([viewport.width, viewport.height])
        await expect(tabs(page).getByRole('tab')).toHaveCount(4)
        await expect(tabs(page).getByRole('tab', { name: 'Обзор', exact: true })).toHaveAttribute('aria-selected', 'true')
        const first = table(page).locator('[data-metric-id="transport:nearest_stop_distance"]')
        if (viewport.width === 1280 && viewport.height === 720) {
            const box = await first.boundingBox(); expect(box.y + box.height).toBeLessThanOrEqual(720)
        }
        await page.locator('.home-result-tools').scrollIntoViewIfNeeded()
        if (viewport.width < 768) await page.locator('.home-result-tools').evaluate(node => {
            const root = node.closest('.placelens-workspace'), dock = root.querySelector('.home-mobile-views')
            root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top - dock.getBoundingClientRect().height
        })
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: test.info().outputPath(`matrix-${viewport.width}x${viewport.height}.png`), fullPage: false })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (viewport.width < 768) {
            const values = await first.locator('td').allTextContents(); expect(values).toHaveLength(2); expect(values.every(value => value.includes('150 м'))).toBe(true)
            for (const button of await first.getByRole('button').all()) { const r = await button.boundingBox(); expect(r.height).toBeGreaterThanOrEqual(44); expect(r.width).toBeGreaterThanOrEqual(44) }
        }
    })
}

test('one profile before trips, accessible single navigation, sources and exact dialog return focus', async ({ page, api }) => {
    const calls = await setup(page); await page.goto(root(false))
    const matrix = page.getByRole('table', { name: /Профиль А/ })
    await expect(matrix.locator('thead th')).toHaveCount(2)
    await expect(matrix.locator('[data-metric-id="transport:nearest_stop_distance"]')).toContainText('150 м')
    expect(calls).toHaveLength(0)
    const overview = tabs(page).getByRole('tab', { name: 'Обзор', exact: true }); await overview.focus()
    await overview.press('End'); const data = tabs(page).getByRole('tab', { name: 'Данные', exact: true })
    await expect(data).toBeFocused(); await expect(data).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'home-result-tab-data')
    await expect(page.getByRole('table')).toHaveCount(0)
    const addressSource = page.getByText('Адрес и точка · А', { exact: true })
    if (page.viewportSize().width < 768) expect((await addressSource.boundingBox()).height).toBeGreaterThanOrEqual(44)
    await addressSource.press('Enter')
    await expect(page.getByRole('tabpanel')).toContainText('дата наблюдения: неизвестна')
    await data.press('Home'); await expect(overview).toBeFocused()
    await overview.press('ArrowLeft'); await expect(data).toBeFocused()
    await data.press('ArrowLeft'); const env = tabs(page).getByRole('tab', { name: 'Окружение', exact: true }); await expect(env).toBeFocused()
    await env.press('Tab'); await expect(page.getByRole('tabpanel')).toBeFocused()
    const info = page.getByRole('button', { name: 'Подробности: Ближайшая остановка, А', exact: true })
    await info.press('Enter'); const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Это не длина пути')
    await expect(dialog).toContainText('Публикация/версия источника')
    await expect(dialog).toContainText('Охват:')
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).press('Enter'); await expect(info).toBeFocused()
    await info.press('Enter'); await page.keyboard.press('Escape'); await expect(info).toBeFocused()
    await info.press('Enter'); await page.getByRole('dialog').getByRole('button', { name: 'На карте А', exact: true }).press('Enter')
    await expect(page.locator('#home-map-title')).toBeFocused()
    await expect.poll(() => page.evaluate(async () => (await window.__smokeMapIn('.placelens-map')?.getSource('transport-selection')?.getData())?.features.filter(feature => feature.properties.kind === 'selected-stop').map(feature => feature.properties.id))).toEqual([10100])
    const returnButton = page.getByRole('group', { name: 'Рабочая область', exact: true }).getByRole('button', { name: 'Результаты и ввод', exact: true })
    if (await returnButton.isVisible()) { await returnButton.press('Enter'); await expect(page.locator('#home-address-title')).toBeFocused() }
    expect(calls).toHaveLength(0)
})

test('category error stays local and absent nearest geometry opens only its layer', async ({ page, api }) => {
    const calls = await setup(page), profiles = []
    await page.route('**/api/v1/addresses/*/profile?*', route => {
        profiles.push(route.request().url())
        const value = profile(places.a)
        value.blocks.transport.data.nearest_stop.id = 99999
        value.blocks.parks = { status: 'ERROR', data: null, message: 'Слой парков временно недоступен. Остальные показатели рассчитаны независимо; неизвестный результат не означает отсутствие парков.' }
        return route.fulfill({ json: value })
    })
    await page.goto(root(false))
    const park = page.locator('[data-metric-id="parks:nearest_distance"]')
    await expect(park).toContainText('Слой парков временно недоступен.')
    await expect(page.locator('[data-metric-id="transport:nearest_stop_distance"]')).toContainText('150 м')
    await park.getByRole('button', { name: 'Повторить расчёт', exact: true }).press('Enter')
    await expect.poll(() => profiles.length).toBe(2)
    await page.getByRole('button', { name: 'Подробности: Ближайшая остановка, А', exact: true }).press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Геометрии ближайшего объекта в ответе нет.')
    await dialog.getByRole('button', { name: 'На карте А', exact: true }).press('Enter')
    await expect(page.locator('#home-map-title')).toBeFocused()
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.placelens-map')?.loaded())).toBe(true)
    expect(await page.evaluate(async () => (await window.__smokeMapIn('.placelens-map').getSource('transport-selection').getData()).features.filter(feature => feature.properties.kind === 'selected-stop'))).toEqual([])
    expect(calls).toHaveLength(0)
})

test('two goals, unknown values, full details, long text and interface switch preserve independent results', async ({ page, api }) => {
    const calls = await setup(page); await page.goto(root() + hash(goals(2, true)))
    await expect(table(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toHaveCount(4)
    const info = page.getByRole('button', { name: /^Подробности поездки: А → Работа/ })
    await info.press('Enter'); const dialog = page.getByRole('dialog')
    for (const text of ['Исходный старт:', 'Дорожный старт:', 'Коды:', 'SHA-256 PBF:', 'модель без пробок']) await expect(dialog).toContainText(text)
    await page.keyboard.press('Escape'); await expect(info).toBeFocused()
    await page.getByRole('button', { name: 'Все показатели', exact: true }).press('Enter')
    const missing = table(page).locator('[data-metric-id="water:share"] td[data-side=right]')
    await expect(missing).toContainText('Недостаточно данных'); await expect(missing).toContainText('Недостаточное покрытие тестового источника.')
    const url = page.url(), length = await page.evaluate(() => history.length)
    const ui = page.getByRole('group', { name: 'Интерфейс', exact: true })
    await ui.getByRole('button', { name: 'Текущий', exact: true }).press('Enter'); await ui.getByRole('button', { name: 'Новый', exact: true }).press('Enter')
    expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length); expect(calls).toHaveLength(2)
    await expect(missing).toContainText('Недостаточно данных')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('matrix-long-and-unknown.png'), fullPage: false })
})

test('pending B, unknown path and stable-cell retry keep A and other goals; profile failure remains local', async ({ page, api }) => {
    const calls = await setup(page), gate = api.hold(places.b)
    let retried = false
    const reason = 'Недостаточно подготовленных сведений о доступе к улице у выбранной цели. Исходная точка сохранена; требуется проверка на местности и другой явный выбор улицы. Число минут неизвестно.'
    await page.route('**/api/v1/trips/analyze', route => {
        const value = route.request().postDataJSON(); calls.push(value)
        const response = carResponse(value)
        if (value.start.lon === places.b.lon && !retried) {
            const row = response.results[0]
            Object.assign(row, { status: 'UNKNOWN', route: null, snaps: null, reason, metrics: { distance: { value: null }, duration: { value: null } },
                diagnostics: { version: 1, issues: [{ code: 'INSUFFICIENT_DATA', category: 'insufficient_data', stage: 'access', location: 'target', target_index: 0 }] } })
        }
        return route.fulfill({ json: response })
    })
    await page.goto(root() + hash(goals(2))); await gate.started
    await expect(page.getByLabel('Состояние Б', { exact: true })).toHaveAttribute('aria-busy', 'true')
    await expect(table(page).locator('[data-goal-id=work] td[data-side=left]').getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    expect(calls).toHaveLength(1)
    gate.release()
    const unknown = table(page).locator('[data-goal-id=work] td[data-side=right]')
    await expect(unknown).toContainText('Путь неизвестен'); await expect(unknown).toContainText(reason)
    await expect(table(page).locator('[data-goal-id=family] td[data-side=right]').getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    await unknown.scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath('matrix-long-unknown-path.png') })
    retried = true
    await unknown.getByRole('button', { name: 'Повторить эту поездку', exact: true }).press('Enter')
    await expect(unknown.getByRole('button', { name: 'Показать маршрут', exact: true })).toBeVisible()
    expect(calls).toHaveLength(3); expect(calls.at(-1).places).toHaveLength(1); expect(calls.at(-1).start.lon).toBe(places.b.lon)
    await expect(table(page).getByRole('button', { name: 'Показать маршрут', exact: true })).toHaveCount(4)
    await page.goto('/?' + new URLSearchParams({ left: places.a.id, right: 'missing', radius_m: '500' }))
    await expect(page.getByLabel('Состояние Б', { exact: true })).toContainText('Источник профиля временно недоступен')
    await expect(table(page).locator('[data-metric-id="transport:nearest_stop_distance"] td[data-side=left]')).toContainText('150 м')
    await expect(page.getByRole('button', { name: 'Повторить Б', exact: true })).toBeVisible()
    await tabs(page).getByRole('tab', { name: 'Данные', exact: true }).press('Enter')
    await expect(page.getByRole('tabpanel')).toContainText(places.a.label)
    expect(calls).toHaveLength(3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
