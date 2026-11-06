import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Opt-in real test HTTP. The stand proxies /api to the accepted A10.2 test
// process; tile URLs stay same-origin. Screenshots are evidence only and say
// nothing about working activation or Nginx/FPM.
const screenshots = fileURLToPath(new URL('../../data/reports/i2-satellite-ui-2026-11-06/', import.meta.url))
mkdirSync(screenshots, { recursive: true })
const card = page => page.locator('[data-analysis-block="satellite"]')
const ndviLayer = 'pa-satellite-ndvi-raster'
const tciLayer = 'pa-satellite-true-color-raster'

async function pickPoint(page) {
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await expect(page.locator('.pa-map-status')).toHaveCount(0)
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.pa-map')).toBeFocused()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Анализировать', exact: true }).press('Enter')
}
async function openSatellite(page) {
    await page.getByRole('tab', { name: 'Спутник', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Спутниковые снимки', exact: true })).toBeVisible()
    await expect(page.getByLabel('Дата снимка', { exact: true })).toBeVisible()
}
function visibility(page, layer) {
    return page.evaluate(layer => window.__smokeMapIn('.pa-map')?.getLayoutProperty(layer, 'visibility'), layer)
}
function sourceTiles(page, layer) {
    return page.evaluate(layer => {
        const map = window.__smokeMapIn('.pa-map')
        const source = map?.getLayer(layer)?.source
        return source ? map.getSource(source)?.serialize()?.tiles?.[0] : undefined
    }, layer)
}
async function settleMap(page) {
    await expect.poll(() => page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        return !!map && map.loaded() && !map.isMoving()
    })).toBe(true)
}

test('real A10.2 catalog, two dates, TCI/NDVI, legend, zoom and quick changes', async ({ page }, testInfo) => {
    const calls = [], tiles = []
    page.on('request', request => {
        const url = new URL(request.url())
        if (url.pathname === '/api/v1/place-analysis') calls.push(request.postDataJSON())
        const match = url.pathname.match(/\/api\/v1\/satellite\/[a-f0-9]{64}\/(\d{4}-\d{2}-\d{2})\/(true-color|ndvi)\/(\d+)\/(\d+)\/(\d+)\.png$/)
        if (match) tiles.push({ date: match[1], layer: match[2], z: Number(match[3]), x: Number(match[4]), y: Number(match[5]) })
    })
    await page.goto('/')
    await pickPoint(page)
    await openSatellite(page)
    await expect(card(page).getByRole('status')).toHaveText('Дата не выбрана')
    const options = page.getByLabel('Дата снимка', { exact: true }).locator('option')
    await expect.poll(() => options.count()).toBeGreaterThan(2)
    const twoDates = await options.evaluateAll(values => values.slice(1, 3).map(option => option.value))
    expect(twoDates).toEqual(['2024-05-07', '2024-08-15'])
    await page.getByLabel('Дата снимка', { exact: true }).selectOption('2024-05-07')
    await expect(card(page).getByRole('status')).toHaveText('Наблюдение готово')
    await expect(page.getByText('снег на западных возвышенностях', { exact: false })).toBeVisible()
    await expect(page.locator('[data-satellite-coverage]')).toContainText('круга')
    await expect(page.getByText('Неизвестно / исключено маской')).toBeVisible()
    await expect(page.getByText('Легенда NDVI')).toBeVisible()
    await expect.poll(() => visibility(page, ndviLayer)).toBe('visible')
    await expect.poll(() => visibility(page, tciLayer)).toBe('none')
    await expect.poll(() => tiles.length).toBeGreaterThan(0)
    expect(tiles.every(tile => tile.z <= 13)).toBe(true)
    expect(tiles.some(tile => tile.z === 13)).toBe(true)
    expect(await page.evaluate(() => window.__smokeMapIn('.pa-map').getZoom())).toBeGreaterThan(13)
    await settleMap(page)
    await page.screenshot({ path: `${screenshots}/ndvi-2024-05-07-${testInfo.project.name}.png` })

    await page.getByRole('button', { name: 'Снимок', exact: true }).click()
    await expect.poll(() => visibility(page, tciLayer)).toBe('visible')
    await expect.poll(() => visibility(page, ndviLayer)).toBe('none')
    await settleMap(page)
    await page.screenshot({ path: `${screenshots}/true-color-2024-05-07-${testInfo.project.name}.png` })

    await page.getByLabel('Дата снимка', { exact: true }).selectOption('2026-06-06')
    await expect(card(page).getByRole('status')).toHaveText('Наблюдение готово')
    await expect(page.getByText('снег на западных возвышенностях', { exact: false })).toHaveCount(0)
    await expect.poll(() => sourceTiles(page, 'pa-satellite-true-color-raster')).toContain('/2026-06-06/true-color/')
    await settleMap(page)
    await page.screenshot({ path: `${screenshots}/true-color-2026-06-06-${testInfo.project.name}.png` })

    const before = calls.length
    await page.getByLabel('Дата снимка', { exact: true }).selectOption('2024-08-15')
    await page.getByLabel('Дата снимка', { exact: true }).selectOption('2026-09-09')
    await expect(card(page).getByRole('status')).toHaveText('Наблюдение готово')
    await expect(page.getByLabel('Дата снимка', { exact: true })).toHaveValue('2026-09-09')
    expect(calls.length).toBeGreaterThan(before)
    expect(calls.at(-1).blocks).toEqual(['satellite'])
    await expect.poll(() => sourceTiles(page, 'pa-satellite-true-color-raster')).toContain('/2026-09-09/true-color/')

    await page.locator('.pa-map').scrollIntoViewIfNeeded()
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.pa-map')).toBeFocused()
    await page.evaluate(() => window.__smokeMapIn('.pa-map').jumpTo({ center: [92.87, 56.03], zoom: 15.15 }))
    const target = await page.evaluate(() => {
        const center = window.__smokeMapIn('.pa-map').getCenter()
        return { lon: center.lng, lat: center.lat }
    })
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Выбранная точка' })).toBeVisible()
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click()
    await expect.poll(() => calls.some(call => call.place.kind === 'point' && Math.abs(call.place.lon - target.lon) < 1e-6 && Math.abs(call.place.lat - target.lat) < 1e-6)).toBe(true)
    await expect(card(page).getByRole('status')).toHaveText('Наблюдение готово')
})

test('real API and a controlled satellite refusal stay independent and retry', async ({ page }) => {
    let fail = true
    await page.route('**/api/v1/place-analysis', async route => {
        const request = route.request().postDataJSON()
        if (fail && request.blocks[0] === 'satellite' && request.date === '2024-08-15') {
            return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE', message: 'Controlled satellite refusal' } })
        }
        return route.continue()
    })
    await page.goto('/')
    await pickPoint(page)
    await openSatellite(page)
    await page.getByLabel('Дата снимка', { exact: true }).selectOption('2024-08-15')
    await expect(card(page).getByRole('status')).toHaveText('Ошибка загрузки блока')
    await expect(page.getByText('Повторить загрузку спутника', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(page.locator('[data-analysis-block="air"]').getByRole('status')).toHaveText('Данные недоступны')
    await expect(page.getByText('Данные о станциях и наблюдениях пока недоступны.')).toBeVisible()
    await page.getByRole('tab', { name: 'Спутник', exact: true }).click()
    fail = false
    await page.getByRole('button', { name: 'Повторить загрузку спутника', exact: true }).click()
    await expect(card(page).getByRole('status')).toHaveText('Наблюдение готово')
    await expect.poll(() => visibility(page, ndviLayer)).toBe('visible')
})
