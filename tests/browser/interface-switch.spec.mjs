import { test, expect, homeScreen } from './support.mjs'
import { places, profile, comparisonUrl } from './fixtures.mjs'

const storageKey = 'placelens:interface:v1'
const switcher = page => page.getByRole('group', { name: 'Интерфейс', exact: true })
async function assertWorkspace(page) { await expect(switcher(page)).toHaveCount(0) }
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

test('workspace preserves pending search, explicit object choice and reload', async ({ page, api }) => {
    let release, requested
    const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { requested = resolve })
    await page.route('**/api/v1/addresses/search?*', async route => {
        requested(); await gate
        const { searchResponse } = await import('./fixtures.mjs')
        return route.fulfill({ json: searchResponse('Неоднозначная') })
    })
    await page.goto('/')
    await expect(switcher(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Добавить адрес А', exact: true }).click()
    const input = page.getByRole('combobox', { name: 'Адрес в Красноярске', exact: true })
    await input.fill('Неоднозначная')
    await started
    const url = page.url(), history = await page.evaluate(() => window.history.length)
    await assertWorkspace(page)
    await expect(input).toHaveValue('Неоднозначная')
    release()
    await expect(page.getByRole('listbox', { name: 'Найденные адреса' }).getByRole('option')).toHaveCount(1)
    await input.press('ArrowDown'); await input.press('Enter')
    const objects = page.getByRole('list', { name: 'Объекты выбранного адреса' })
    await expect(objects.getByRole('button')).toHaveCount(10)
    await assertWorkspace(page)
    await expect(objects.getByRole('button')).toHaveCount(10)
    expect(page.url()).toBe(url)
    expect(await page.evaluate(() => window.history.length)).toBe(history)
    expect(api.calls.filter(url => url.endsWith('/profile?radius_m=500'))).toHaveLength(0)
    await assertWorkspace(page)
    await objects.getByRole('button').first().press('Enter')
    await expect(page).toHaveURL(/\/\?left=osm%3Away%3A501/)
    await expect(switcher(page)).toHaveCount(0)
    await page.reload()
    await expect(switcher(page)).toHaveCount(0)
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(null)
})

test('pending point caption keeps map instance and history without transport', async ({ page, api }) => {
    const points = await pointApi(page)
    let release
    const gate = new Promise(resolve => { release = resolve })
    await page.route('**/api/v1/addresses/resolve-point', async route => {
        points.labels.push(route.request().postDataJSON())
        await gate
        return route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: null, calculated_at: '2026-11-01T00:00:00Z', nearby_radius_m: 100, coverage: { status: 'UNKNOWN', reason: 'Synthetic' }, quality: { method: null, availability: 'INSUFFICIENT_DATA', freshness: 'UNKNOWN', reason: 'Synthetic' } } } })
    })
    await page.goto('/?lon=92.87&lat=56.01&radius_m=500#point-info')
    await expect(page.locator('.point-address')).toContainText('Определяем адрес')
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.placelens-map'))).toBe(true)
    await page.evaluate(() => { window.__g2Map = window.__smokeMapIn('.placelens-map'); window.__g2Canvas = document.querySelector('.placelens-map canvas') })
    const url = page.url(), history = await page.evaluate(() => window.history.length)
    await assertWorkspace(page)
    expect(points.transport).toHaveLength(0)
    expect(points.labels).toHaveLength(1)
    release()
    await expect(page.locator('.point-address')).toContainText('Подходящих адресных данных нет')
    expect(page.url()).toBe(url)
    expect(await page.evaluate(() => window.history.length)).toBe(history)
    expect(await page.evaluate(() => window.__g2Map === window.__smokeMapIn('.placelens-map') && window.__g2Canvas === document.querySelector('.placelens-map canvas'))).toBe(true)
    await page.getByText('Источник и точность подписи', { exact: true }).click()
    await expect(page.locator('.point-address')).toContainText('Дата наблюдения: неизвестна')
    expect(points.labels).toHaveLength(1)
    await page.getByRole('button', { name: 'Убрать точку', exact: true }).click()
    await page.goBack()
    await expect(page.locator('.point-address')).toContainText('Подходящих адресных данных нет')
    expect(points.transport).toHaveLength(0)
})

test('home map controls remain reachable without remounting', async ({ page, api }) => {
    await pointApi(page)
    await page.goto('/')
    await expect(page.locator('#home-selection-title')).toHaveText('Мои места')
    await homeScreen(page, 'Карта')
    await expect(page.locator('.placelens-map canvas')).toBeVisible()
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.placelens-map')?.loaded())).toBe(true)
    await page.evaluate(() => { window.__homeMap = window.__smokeMapIn('.placelens-map') })
    await page.locator('.placelens-map canvas').press('Enter')
    await expect(page.locator('.home-point-label')).toBeVisible()
    await expect(page.locator('.transport-results')).toHaveCount(0)
    await homeScreen(page, 'Настройки')
    await expect(page.getByRole('button', { name: 'Добавить адрес А', exact: true })).toBeVisible()
    await homeScreen(page, 'Карта')
    expect(await page.evaluate(() => window.__homeMap === window.__smokeMapIn('.placelens-map'))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('home-map.png'), fullPage: true })
})

test('blocked preference storage preserves direct compare and trips pages', async ({ page, api }) => {
    await page.addInitScript(key => {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem
        Storage.prototype.getItem = function (name) { if (name === key) throw Error('Blocked preference'); return get.call(this, name) }
        Storage.prototype.setItem = function (name, value) { if (name === key) throw Error('Blocked preference'); return set.call(this, name, value) }
    }, storageKey)
    await page.goto(comparisonUrl())
    await assertWorkspace(page); await assertWorkspace(page)
    await page.goto('/trips')
    await expect(page).toHaveURL('/trips')
    const name = page.getByRole('textbox', { name: 'Название для себя', exact: true })
    await name.fill('Синтетическая цель')
    await page.getByRole('combobox', { name: 'Режим маршрута', exact: true }).selectOption('walking')
    const url = page.url()
    await assertWorkspace(page); await assertWorkspace(page)
    await expect(name).toHaveValue('Синтетическая цель')
    await expect(page.getByRole('combobox', { name: 'Режим маршрута', exact: true })).toHaveValue('walking')
    expect(page.url()).toBe(url)
    await page.goto(comparisonUrl())
    await expect(page).toHaveURL(/\/compare\?/)
})

for (const stored of [null, 'classic', 'workspace', 'blocked']) {
    test(`workspace is available with ${stored} storage`, async ({ page, api }) => {
        await page.addInitScript(value => {
            if (value === 'blocked') Object.defineProperty(window, 'localStorage', { get() { throw Error('Blocked') } })
            else if (value) localStorage.setItem('placelens:interface:v1', value)
        }, stored)
        await page.goto('/')
        await expect(page.locator('.home-v2')).toBeVisible()
        await expect(switcher(page)).toHaveCount(0)
        await expect(page.getByRole('link', { name: 'Сравнить адреса', exact: true })).toHaveCount(0)
        await expect(page.getByRole('link', { name: 'Поездки · пилот', exact: true })).toHaveCount(0)
        await page.reload()
        await expect(page.locator('.home-v2')).toBeVisible()
        await page.goto('/address/' + encodeURIComponent(places.a.id))
        await expect(page.locator('.address-workspace')).toBeVisible()
    })
}
