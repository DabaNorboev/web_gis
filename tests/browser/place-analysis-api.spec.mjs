import { test, expect } from '@playwright/test'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

async function choosePoint(page) {
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    const button = page.getByRole('button', { name: 'Точка на карте', exact: true })
    await button.focus(); await page.keyboard.press('Enter')
    await expect(page.locator('.pa-map')).toBeFocused()
    await page.keyboard.press('Enter')
    const analyze = page.getByRole('button', { name: 'Анализировать', exact: true })
    await expect(analyze).toBeFocused(); await page.keyboard.press('Enter')
}
function fixture(route, statuses = {}) {
    return route.fulfill({ json: responseFor(route.request().postDataJSON(), statuses) })
}
const card = (page, key) => page.locator(`[data-analysis-block="${key}"]`)

test('API blocks arrive and retry independently; real POI selection and server contour are preserved', async ({ page }) => {
    const calls = []; let airRoute; let firstResponse
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.route('**/api/v1/place-analysis', async route => {
        const request = route.request().postDataJSON(); calls.push(request)
        expect(route.request().method()).toBe('POST')
        if (request.blocks[0] === 'air' && !airRoute) { airRoute = route; return }
        if (request.blocks[0] === 'poi') firstResponse = responseFor(request, { poi: 'READY' })
        return fixture(route, { poi: 'READY' })
    })
    await page.goto('/analysis')
    await expect(page.getByRole('heading', { name: 'Анализ выбранного места', exact: true })).toBeVisible()
    await expect(page.locator('.pa-map-marker, .pa-map-station')).toHaveCount(0)
    await choosePoint(page)
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    await expect(card(page, 'air').getByRole('status')).toHaveText('Загрузка…')
    await expect.poll(() => calls.length).toBe(3)
    expect(calls.every(r => r.place.kind === 'point' && !('address_id' in r.place))).toBe(true)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getSource('pa-radius')?.serialize().data)).toEqual({ type: 'Feature', properties: {}, geometry: firstResponse.analysis_area })
    await expect(page.locator('.pa-map-station')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getStyle().layers.some(layer => layer.id.startsWith('pa-satellite-')))).toBe(false)
    await airRoute.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE', message: 'PRIVATE_CANARY' } })
    await expect(card(page, 'air').getByRole('status')).toHaveText('Ошибка загрузки блока')
    await card(page, 'air').locator('#pa-load-air').click()
    await expect(card(page, 'air').getByRole('status')).toHaveText('Данные недоступны')
    expect(calls.map(r => r.blocks[0]).filter(k => k === 'poi')).toHaveLength(1)
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
    await page.getByRole('button', { name: 'Аптеки (1)', exact: true }).click()
    const row = page.getByRole('button', { name: 'Synthetic API pharmacy 0 м по прямой', exact: true })
    await row.click(); await expect(row).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.pa-map-marker[data-poi-id="osm:node:1"]')).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await page.locator('.pa-map').scrollIntoViewIfNeeded()
    await page.locator('.pa-map-marker[data-poi-id="osm:node:1"]').click()
    await expect(page.getByRole('tab', { name: 'Объекты', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(row).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('PRIVATE_CANARY')).toHaveCount(0)
    expect(errors).toEqual([])
})

test('date change reloads only satellite; late replies are discarded and radius keeps a marked previous contour', async ({ page }) => {
    const routes = []; const calls = []
    await page.route('**/api/v1/place-analysis', route => { calls.push(route.request().postDataJSON()); routes.push(route) })
    await page.goto('/analysis'); await choosePoint(page)
    await expect.poll(() => calls.length).toBe(3)
    for (const route of routes) await fixture(route, { poi: 'READY', satellite: 'READY' })
    await page.getByRole('tab', { name: 'Спутник', exact: true }).click()
    await expect(card(page, 'satellite').getByRole('status')).toHaveText('Дата не выбрана')
    await page.getByLabel('Дата снимка', { exact: true }).selectOption('2024-05-07')
    await expect(card(page, 'satellite').getByRole('status')).toHaveText('Загрузка…')
    await expect.poll(() => calls.length).toBe(4)
    expect(calls[3].blocks).toEqual(['satellite']); expect(calls[3].date).toBe('2024-05-07')
    await fixture(routes[3], { satellite: 'READY' })
    await expect(card(page, 'satellite').getByRole('status')).toHaveText('Наблюдение готово')
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    await expect(card(page, 'air').getByRole('status')).toHaveText('Данные недоступны')
    await expect(card(page, 'satellite').getByRole('status')).toHaveText('Наблюдение готово')
    expect(calls).toHaveLength(4)
    await page.getByRole('spinbutton', { name: 'Радиус анализа:' }).fill('1000')
    await page.getByRole('spinbutton', { name: 'Радиус анализа:' }).press('Tab')
    await expect(page.locator('.pa-map-marker')).toHaveCount(0)
    await expect(page.locator('.pa-map-radius-label')).toContainText('предыдущий')
    await expect.poll(() => calls.length).toBe(7)
    expect(calls.slice(4).every(r => r.radius_m === 1000 && r.date === '2024-05-07')).toBe(true)
    for (const route of routes.slice(4)) await fixture(route, { poi: 'READY', air: 'READY', satellite: 'READY' })
    await expect(page.locator('.pa-map-radius-label')).toHaveText('R = 1000 м')
    for (const key of ['poi', 'air']) await expect(card(page, key).getByRole('status')).toHaveText('Готово')
    await expect(card(page, 'satellite').getByRole('status')).toHaveText('Наблюдение готово')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getSource('pa-radius')?.serialize().data)).toEqual({ type: 'Feature', properties: {}, geometry: responseFor(calls[4]).analysis_area })
})

test('unavailable providers never display demo objects or measurements; malformed response is retryable', async ({ page }) => {
    let poiCalls = 0
    await page.route('**/api/v1/place-analysis', route => {
        const request = route.request().postDataJSON()
        if (request.blocks[0] === 'poi' && ++poiCalls === 1) {
            const r = responseFor(request); r.place.point.lon += .1
            return route.fulfill({ json: r })
        }
        return fixture(route)
    })
    await page.goto('/analysis'); await choosePoint(page)
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Получен несогласованный ответ')
    await card(page, 'poi').locator('#pa-load-poi').click()
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Данные недоступны')
    for (const tab of ['Объекты', 'Спутник', 'Воздух']) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        await expect(page.locator('.pa-map-marker, .pa-map-station, .pa-history')).toHaveCount(0)
        await expect(page.getByText('PM2.5 18.6', { exact: false })).toHaveCount(0)
    }
    await expect(page.getByText('Данные о станциях и наблюдениях пока недоступны.')).toBeVisible()
    await expect(page.getByText('Synthetic air provider unavailable')).toHaveCount(0)
})

test('exact address choice and station selection keep identity and independent POI results', async ({ page }) => {
    const calls = []
    const objects = ['osm:node:1', 'osm:node:2'].map(id => responseFor({ place: { kind: 'address', address_id: id } }).place.address.object)
    await page.route('**/api/v1/addresses/search?**', route => route.fulfill({ json: { data: [{ id: 'address:synthetic-group', label: 'Synthetic address', bounds: [.39, .49, .41, .51], objects }] } }))
    await page.route('**/api/v1/place-analysis', route => {
        const request = route.request().postDataJSON(); calls.push(request)
        const response = responseFor(request, { poi: 'READY', air: 'READY' })
        if (response.blocks.air) {
            const selected = request.stations.selected_ids.includes('synthetic-station')
            response.blocks.air.data.stations = [{ id: 'synthetic-station', name: 'Synthetic station', lon: .401, lat: .5,
                source: 'Synthetic', dataset_import_id: 1, distance_m: 100, group: selected ? 'selected' : 'nearest', selected, status: 'UNKNOWN' }]
            response.blocks.air.data.counts = { selected: selected ? 1 : 0, nearest: selected ? 0 : 1, other: 0 }
        }
        return route.fulfill({ json: response })
    })
    await page.goto('/analysis')
    const search = page.getByRole('combobox', { name: 'Поиск адреса' })
    await search.fill('Synthetic')
    await expect(page.getByRole('option')).toHaveCount(2)
    await search.press('ArrowDown'); await search.press('ArrowDown'); await search.press('Enter')
    await expect(search).toHaveValue('Synthetic address')
    await expect.poll(() => calls.length).toBe(3)
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    expect(calls.every(r => r.place.kind === 'address' && r.place.address_id === 'osm:node:2' && !('lon' in r.place))).toBe(true)
    await page.getByRole('tab', { name: 'Воздух', exact: true }).click()
    await page.getByRole('button', { name: 'Включить станцию в выбор', exact: true }).click()
    await expect(card(page, 'air').getByRole('button')).toBeFocused()
    await page.getByRole('spinbutton', { name: 'Радиус выбора станций, м' }).fill('1000')
    await page.getByRole('spinbutton', { name: 'Радиус выбора станций, м' }).press('Tab')
    await expect(card(page, 'air').getByRole('status')).toHaveText('Требуется явный запуск анализа.')
    expect(calls).toHaveLength(3)
    await card(page, 'air').locator('#pa-load-air').click()
    await expect(card(page, 'air').getByRole('status')).toHaveText('Готово')
    expect(calls).toHaveLength(4)
    expect(calls[3].blocks).toEqual(['air'])
    expect(calls[3].stations).toEqual({ selected_ids: ['synthetic-station'], radius_m: 1000 })
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
})
