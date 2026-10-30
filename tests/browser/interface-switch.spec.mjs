import { test, expect } from './support.mjs'
import { places, profile, comparisonUrl } from './fixtures.mjs'

const storageKey = 'placelens:interface:v1'
const switcher = page => page.getByRole('group', { name: 'Интерфейс', exact: true })
async function choose(page, name) {
    const button = switcher(page).getByRole('button', { name, exact: true })
    await button.press('Enter')
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toBeFocused()
}
async function pointApi(page) {
    const transport = [], labels = []
    let handler = route => route.fulfill({ json: result(route) })
    function result(route) {
        const url = new URL(route.request().url())
        return profile({ ...places.a, lon: +url.searchParams.get('lon'), lat: +url.searchParams.get('lat') }, +url.searchParams.get('radius_m')).blocks.transport.data
    }
    await page.route('**/api/v1/transport/analysis?*', route => { transport.push(route.request().url()); return handler(route) })
    await page.route('**/api/v1/addresses/resolve-point', route => {
        labels.push(route.request().postDataJSON())
        return route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: null, calculated_at: '2026-10-27T00:00:00Z', nearby_radius_m: 100, coverage: { status: 'UNKNOWN', reason: 'Synthetic coverage' }, quality: { method: null, availability: 'INSUFFICIENT_DATA', freshness: 'UNKNOWN', reason: 'Synthetic no address' } } } })
    })
    return { transport, labels, hold() {
        let release, requested
        const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { requested = resolve })
        handler = async route => { requested(); await gate; return route.fulfill({ json: result(route) }) }
        return { release, started }
    } }
}

test('interface preserves pending search and explicit object choice, persists across routes and reload', async ({ page, api }) => {
    let release, requested
    const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { requested = resolve })
    await page.route('**/api/v1/addresses/search?*', async route => {
        requested(); await gate
        const { searchResponse } = await import('./fixtures.mjs')
        return route.fulfill({ json: searchResponse('Неоднозначная') })
    })
    await page.goto('/')
    await expect(switcher(page).getByRole('button', { name: 'Текущий', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const input = page.getByRole('combobox', { name: 'Адрес в Красноярске', exact: true })
    await input.fill('Неоднозначная')
    await started
    const url = page.url(), history = await page.evaluate(() => window.history.length)
    await choose(page, 'Новый')
    await expect(input).toHaveValue('Неоднозначная')
    release()
    await expect(page.getByRole('listbox', { name: 'Найденные адреса' }).getByRole('option')).toHaveCount(1)
    await input.press('ArrowDown'); await input.press('Enter')
    const objects = page.getByRole('list', { name: 'Объекты выбранного адреса' })
    await expect(objects.getByRole('button')).toHaveCount(10)
    await choose(page, 'Текущий')
    await expect(objects.getByRole('button')).toHaveCount(10)
    expect(page.url()).toBe(url)
    expect(await page.evaluate(() => window.history.length)).toBe(history)
    expect(api.calls.filter(url => url.endsWith('/profile?radius_m=500'))).toHaveLength(0)
    await choose(page, 'Новый')
    await objects.getByRole('button').first().press('Enter')
    await expect(page).toHaveURL(/\/\?left=osm%3Away%3A501/)
    await expect(switcher(page).getByRole('button', { name: 'Новый', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.reload()
    await expect(switcher(page).getByRole('button', { name: 'Новый', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe('workspace')
})

test('pending point analysis and map instance survive both interfaces, then radius and history still work', async ({ page, api }) => {
    const points = await pointApi(page), gate = points.hold()
    const pointUrl = '/?lon=92.87&lat=56.01&radius_m=500#point-info'
    await page.goto(pointUrl)
    await gate.started
    await expect(page.locator('.point-address')).toContainText('Подходящих адресных данных нет')
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.placelens-map'))).toBe(true)
    await page.evaluate(() => { window.__g2Map = window.__smokeMapIn('.placelens-map'); window.__g2Canvas = document.querySelector('.placelens-map canvas') })
    const url = page.url(), history = await page.evaluate(() => window.history.length)
    await choose(page, 'Новый'); await choose(page, 'Текущий'); await choose(page, 'Новый')
    expect(points.transport).toHaveLength(1)
    expect(points.labels).toHaveLength(1)
    gate.release()
    await expect(page.locator('.transport-results')).toContainText('Остановка 1')
    expect(page.url()).toBe(url)
    expect(await page.evaluate(() => window.history.length)).toBe(history)
    expect(await page.evaluate(() => window.__g2Map === window.__smokeMapIn('.placelens-map') && window.__g2Canvas === document.querySelector('.placelens-map canvas'))).toBe(true)
    await page.getByText('ⓘ Источник и качество данных', { exact: true }).click()
    await choose(page, 'Текущий')
    await expect(page.locator('.transport-results')).toContainText('Дата наблюдения: неизвестна')
    expect(points.labels).toHaveLength(1)
    await page.getByRole('button', { name: '300 м', exact: true }).click()
    await expect.poll(() => points.transport.length).toBe(2)
    await page.goBack()
    await expect(page.getByRole('button', { name: '500 м', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await choose(page, 'Новый')
    await page.screenshot({ path: test.info().outputPath('new-point-results.png'), fullPage: true })
})

test('new home fills the viewport and map controls remain reachable without remounting', async ({ page, api }) => {
    await page.addInitScript(key => localStorage.setItem(key, 'workspace'), storageKey)
    await pointApi(page)
    await page.goto('/')
    const isPhone = test.info().project.use.viewport.width < 768
    await expect(page.getByRole('heading', { name: 'Места и цели' })).toBeVisible()
    if (isPhone) {
        await page.getByRole('group', { name: 'Сценарий', exact: true }).getByRole('button', { name: 'Остановки', exact: true }).press('Enter')
        await page.getByRole('button', { name: 'Выбрать точку на карте', exact: true }).click()
    }
    await expect(page.getByRole('button', { name: 'Выбрать центр карты', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
        const map = window.__smokeMapIn('.placelens-map')
        return !!map && map.loaded() && map.getCanvas().clientWidth > 0 && map.getCanvas().clientHeight > 0
    })).toBe(true)
    expect(await page.evaluate(() => {
        // Shared static CSS must be present in the smoke shell, including the
        // MapLibre controls and the switcher's scoped styles.
        return getComputedStyle(document.querySelector('.interface-switch')).display === 'flex'
            && getComputedStyle(document.querySelector('.maplibregl-ctrl-bottom-left')).position === 'absolute'
    })).toBe(true)
    expect(await page.evaluate(() => {
        const rect = document.querySelector('.placelens-map').getBoundingClientRect()
        return rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth
    })).toBe(true)
    await page.screenshot({ path: test.info().outputPath('new-search-map.png'), fullPage: true })
    await page.getByRole('button', { name: 'Выбрать центр карты', exact: true }).press('Enter')
    await expect(page.locator('.transport-results')).toBeVisible()
    await expect(page.locator('.transport-results')).toContainText('Остановка 1')
    if (isPhone) {
        await expect(page.getByRole('heading', { name: /Остановки в радиусе/ })).toBeFocused()
        const views = page.getByRole('group', { name: 'Рабочая область', exact: true })
        await views.getByRole('button', { name: 'Карта', exact: true }).click()
        await expect(page.locator('.placelens-map')).toBeVisible()
        await views.getByRole('button', { name: 'Результаты и ввод', exact: true }).click()
        await expect(page.locator('.transport-results')).toBeVisible()
        if (test.info().project.name === 'phone-390') {
            await page.setViewportSize({ width: 390, height: 480 })
            await views.getByRole('button', { name: 'Карта', exact: true }).click()
            await expect.poll(() => page.locator('.city-map-surface').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(80)
            await views.getByRole('button', { name: 'Результаты и ввод', exact: true }).click()
            const sources = page.getByText('ⓘ Источник и качество данных', { exact: true })
            await sources.scrollIntoViewIfNeeded()
            await expect(sources).toBeVisible()
            await page.screenshot({ path: test.info().outputPath('new-point-short-phone.png'), fullPage: true })
        }
    } else {
        await page.getByRole('button', { name: 'Развернуть результаты' }).click()
        await expect(page.getByRole('button', { name: 'Свернуть результаты' })).toHaveAttribute('aria-expanded', 'true')
    }
})

test('blocked preference storage still switches and shared navigation links go to the other page', async ({ page, api }) => {
    await page.addInitScript(key => {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem
        Storage.prototype.getItem = function (name) { if (name === key) throw Error('Blocked preference'); return get.call(this, name) }
        Storage.prototype.setItem = function (name, value) { if (name === key) throw Error('Blocked preference'); return set.call(this, name, value) }
    }, storageKey)
    await page.goto(comparisonUrl())
    await choose(page, 'Новый'); await choose(page, 'Текущий')
    await page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link', { name: 'Поездки · пилот', exact: true }).click()
    await expect(page).toHaveURL('/trips')
    const name = page.getByRole('textbox', { name: 'Название для себя', exact: true })
    await name.fill('Синтетическая цель')
    await page.getByRole('combobox', { name: 'Режим маршрута', exact: true }).selectOption('walking')
    const url = page.url()
    await choose(page, 'Новый'); await choose(page, 'Текущий')
    await expect(name).toHaveValue('Синтетическая цель')
    await expect(page.getByRole('combobox', { name: 'Режим маршрута', exact: true })).toHaveValue('walking')
    expect(page.url()).toBe(url)
    await page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link', { name: 'Сравнить адреса', exact: true }).click()
    await expect(page).toHaveURL('/compare')
})
