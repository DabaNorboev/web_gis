import { test, expect } from '@playwright/test'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

const tilePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const card = page => page.locator('[data-analysis-block="satellite"]')
const ndviLayer = 'pa-satellite-ndvi-raster'
const tciLayer = 'pa-satellite-true-color-raster'

async function pickPoint(page) {
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.pa-map')).toBeFocused()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Анализировать', exact: true }).press('Enter')
}
async function openSatellite(page) {
    await page.getByRole('tab', { name: 'Спутник', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Спутниковые снимки', exact: true })).toBeVisible()
}
function visibility(page, layer) {
    return page.evaluate(layer => window.__smokeMapIn('.pa-map')?.getLayoutProperty(layer, 'visibility'), layer)
}
function paint(page, layer, property) {
    return page.evaluate(([layer, property]) => window.__smokeMapIn('.pa-map')?.getPaintProperty(layer, property), [layer, property])
}
function layerIndex(page, id) {
    return page.evaluate(id => window.__smokeMapIn('.pa-map')?.getStyle().layers.findIndex(layer => layer.id === id), id)
}
async function setup(page, options = {}) {
    const calls = [], tiles = []
    let held = null
    await page.route('**/api/v1/satellite/**', async route => {
        const path = new URL(route.request().url()).pathname
        const match = path.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/)
        if (!match) return route.fulfill({ status: 404, body: '' })
        tiles.push({ z: Number(match[1]), x: Number(match[2]), y: Number(match[3]), path, fail: !!options.tileFail })
        return route.fulfill({ status: options.tileFail ? 503 : 200, contentType: options.tileFail ? 'text/plain' : 'image/png', body: options.tileFail ? '' : tilePng })
    })
    await page.route('**/api/v1/place-analysis', async route => {
        const request = route.request().postDataJSON()
        calls.push(request)
        if (options.holdDate && request.blocks[0] === 'satellite' && request.date === options.holdDate && !held) {
            held = route
            return
        }
        const response = responseFor(request, { poi: 'READY', satellite: 'READY' })
        if (options.deliveryDown && request.blocks[0] === 'satellite' && request.date) {
            response.blocks.satellite.data.delivery_status = 'UNAVAILABLE'
            response.blocks.satellite.data.selected.layers = null
        }
        return route.fulfill({ json: response })
    })
    await page.goto('/analysis')
    await pickPoint(page)
    await expect.poll(() => calls.length).toBe(3)
    return { calls, tiles, held: () => held, release: () => { held = null } }
}
function sourceTiles(page, layer) {
    return page.evaluate(layer => {
        const map = window.__smokeMapIn('.pa-map')
        const source = map?.getLayer(layer)?.source
        return source ? map.getSource(source)?.serialize()?.tiles?.[0] : undefined
    }, layer)
}
async function chooseDate(page, date) {
    await page.getByLabel('Дата снимка', { exact: true }).selectOption(date)
}
async function expectReady(page) {
    await expect(card(page).getByRole('status')).toHaveText('Наблюдение готово')
}
async function setOpacity(page, slider, value) {
    await slider.evaluate((element, next) => {
        element.value = next
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
}

test('two dates, TCI/NDVI, legend, coverage scope, opacity 0/100%, order and persistence across tabs', async ({ page }) => {
    const state = await setup(page)
    await openSatellite(page)
    await expect(card(page).getByRole('status')).toHaveText('Дата не выбрана')
    const options = page.getByLabel('Дата снимка', { exact: true }).locator('option')
    await expect(options).toHaveCount(3)
    await expect(options.nth(1)).toContainText('07.05.2024')
    await expect(options.nth(1)).toContainText('ограничение')
    await chooseDate(page, '2024-05-07')
    await expectReady(page)
    await expect.poll(() => state.calls.length).toBe(4)
    expect(state.calls[3].blocks).toEqual(['satellite'])
    expect(state.calls[3].date).toBe('2024-05-07')
    await expect(card(page)).toHaveClass(/is-partial/)
    await expect(page.locator('[data-satellite-coverage]')).toContainText('87,5')
    await expect(page.locator('[data-satellite-coverage]')).toContainText('пригодно для NDVI')
    await expect(page.locator('[data-satellite-scope]')).toHaveText('Слой показан на всей подготовленной территории. Показатели рассчитаны для выбранного круга.')
    await expect(page.locator('.pa-layers').getByText('Слой показан на всей подготовленной территории')).toHaveCount(0)
    await expect(page.getByText('Synthetic early-spring snow and phenology note; not a summer state.')).toBeVisible()
    await expect(page.locator('.pa-sat-meta > div').filter({ hasText: 'Средний NDVI' }).locator('dd')).toContainText('0,31')
    await expect(page.getByText('MGRS-46VDH')).toBeVisible()
    await expect(page.getByText('Неизвестно / исключено маской')).toBeVisible()
    await expect(page.getByText('NDVI 0.8 … 1')).toBeVisible()
    await expect(page.getByText('Неизвестное прозрачно и не считается низким NDVI', { exact: false })).toBeVisible()
    await expect.poll(() => visibility(page, ndviLayer)).toBe('visible')
    await expect.poll(() => visibility(page, tciLayer)).toBe('none')
    await expect.poll(() => state.tiles.length).toBeGreaterThan(0)
    expect(state.tiles.every(tile => tile.z <= 13)).toBe(true)
    expect(state.tiles.some(tile => tile.z === 13)).toBe(true)
    expect(await page.evaluate(() => window.__smokeMapIn('.pa-map').getZoom())).toBeGreaterThan(13)
    const slider = page.getByLabel('Непрозрачность спутникового слоя')
    await expect(slider).toHaveAttribute('type', 'range')
    await expect(page.locator('.pa-opacity > span')).toHaveText('Непрозрачность:')
    await setOpacity(page, slider, '0')
    await expect.poll(() => paint(page, ndviLayer, 'raster-opacity')).toBe(0)
    await expect(page.locator('.pa-opacity output')).toHaveText('0%')
    await setOpacity(page, slider, '1')
    await expect.poll(() => paint(page, ndviLayer, 'raster-opacity')).toBe(1)
    await expect(page.locator('.pa-opacity output')).toHaveText('100%')
    await setOpacity(page, slider, '0.55')
    await expect.poll(() => paint(page, ndviLayer, 'raster-opacity')).toBeCloseTo(.55, 2)
    const satelliteLayer = page.locator('[data-layer-key="satellite"]')
    await satelliteLayer.locator('input[type="checkbox"]').uncheck()
    await expect.poll(() => visibility(page, ndviLayer)).toBe('none')
    await satelliteLayer.locator('input[type="checkbox"]').check()
    await expect.poll(() => visibility(page, ndviLayer)).toBe('visible')
    await satelliteLayer.locator('.pa-layer-move').first().click()
    await expect.poll(() => layerIndex(page, ndviLayer)).toBeGreaterThan(await layerIndex(page, 'pa-poi-outline'))
    await page.getByRole('button', { name: 'Снимок', exact: true }).click()
    await expect.poll(() => visibility(page, tciLayer)).toBe('visible')
    await expect.poll(() => visibility(page, ndviLayer)).toBe('none')
    await expect(page.locator('[data-layer-key="satellite"]')).toContainText('Спутниковый снимок · 07.05.2024')
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await page.getByRole('tab', { name: 'Спутник', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Снимок', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(slider).toHaveValue('0.55')
    await expect(page.locator('[data-layer-key="satellite"] input[type="checkbox"]')).toBeChecked()
    await expect(page.locator('.pa-layer-item').first()).toHaveAttribute('data-layer-key', 'satellite')
    await chooseDate(page, '2024-08-15')
    await expectReady(page)
    await expect(page.getByText('Synthetic early-spring snow and phenology note; not a summer state.')).toHaveCount(0)
    await expect(page.locator('[data-satellite-coverage]')).toContainText('100')
    await expect.poll(() => sourceTiles(page, 'pa-satellite-ndvi-raster')).toContain('2024-08-15')
})

test('a late reply for an old date cannot replace the current observation and hides old tiles while loading', async ({ page }) => {
    const state = await setup(page, { holdDate: '2024-05-07' })
    await openSatellite(page)
    await chooseDate(page, '2024-08-15')
    await expectReady(page)
    await expect.poll(() => sourceTiles(page, 'pa-satellite-ndvi-raster')).toContain('2024-08-15')
    await chooseDate(page, '2024-05-07')
    await expect(card(page).getByRole('status')).toHaveText('Загрузка…')
    await expect.poll(() => !!state.held()).toBe(true)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getStyle().layers.some(layer => layer.id.startsWith('pa-satellite-')))).toBe(false)
    await chooseDate(page, '2024-08-15')
    await expectReady(page)
    await expect.poll(() => state.calls.length).toBe(6)
    expect(state.calls.at(-1).date).toBe('2024-08-15')
    const old = state.held()
    try { await old.fulfill({ json: responseFor(old.request().postDataJSON(), { poi: 'READY', satellite: 'READY' }) }) } catch { /* Obsolete transport may already be aborted. */ }
    await expect(page.locator('[data-satellite-coverage]')).toContainText('100')
    await expect(page.locator('[data-satellite-coverage]')).not.toContainText('87,5')
    await expect.poll(() => sourceTiles(page, 'pa-satellite-ndvi-raster')).toContain('2024-08-15')
})

test('image delivery failure is explicit and retries only the satellite block', async ({ page }) => {
    const options = { deliveryDown: true }
    const state = await setup(page, options)
    await openSatellite(page)
    await chooseDate(page, '2024-05-07')
    await expect(card(page).getByRole('status')).toHaveText('Изображения недоступны')
    await expect(page.locator('.pa-alert--warning strong', { hasText: 'Изображения недоступны' })).toBeVisible()
    await expect(page.locator('.pa-alert--warning').filter({ hasText: 'Изображения недоступны' }).locator('p')).toContainText('Аналитика по кругу сохранена')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getStyle().layers.some(layer => layer.id.startsWith('pa-satellite-')))).toBe(false)
    const before = state.calls.length
    options.deliveryDown = false
    await page.getByRole('button', { name: 'Повторить загрузку изображений', exact: true }).click()
    await expectReady(page)
    await expect.poll(() => state.calls.length).toBe(before + 1)
    expect(state.calls.at(-1).blocks).toEqual(['satellite'])
    await expect.poll(() => visibility(page, ndviLayer)).toBe('visible')
})

test('keyboard controls, short screens and narrow layout keep the satellite UI usable', async ({ page }) => {
    await setup(page)
    await openSatellite(page)
    await chooseDate(page, '2024-05-07')
    await expectReady(page)
    const mode = page.getByRole('button', { name: 'NDVI', exact: true })
    await mode.focus(); await page.keyboard.press('Enter')
    await expect(mode).toHaveAttribute('aria-pressed', 'true')
    const checkbox = page.locator('[data-layer-key="satellite"] input[type="checkbox"]')
    await checkbox.focus(); await page.keyboard.press('Space')
    await expect(checkbox).not.toBeChecked()
    await page.keyboard.press('Space'); await expect(checkbox).toBeChecked()
    const slider = page.getByLabel('Непрозрачность спутникового слоя')
    const opacityBefore = Number(await slider.inputValue())
    await slider.focus(); await page.keyboard.press('ArrowLeft')
    expect(Number(await slider.inputValue())).toBeLessThan(opacityBefore)
    await expect(page.locator('[data-satellite-scope]')).toBeVisible()
    await page.getByLabel('Дата снимка', { exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByLabel('Дата снимка', { exact: true })).toBeVisible()
    const fits = await page.evaluate(() => {
        const layers = document.querySelector('.pa-layers').getBoundingClientRect()
        return document.documentElement.scrollWidth <= innerWidth + 1 && layers.left >= -1 && layers.right <= innerWidth + 1
    })
    expect(fits).toBe(true)
})


test('a failed raster tile is reported over the map and retries without hiding analytics', async ({ page }) => {
    const options = { tileFail: true }
    const state = await setup(page, options)
    await openSatellite(page)
    await chooseDate(page, '2024-05-07')
    await expectReady(page)
    await expect(page.locator('.pa-map-alert')).toBeVisible()
    await expect(page.locator('.pa-map-alert')).toContainText('Не удалось загрузить изображение')
    await expect(page.locator('[data-satellite-coverage]')).toBeVisible()
    options.tileFail = false
    const before = state.calls.length
    await page.getByRole('button', { name: 'Повторить', exact: true }).click()
    await expect.poll(() => state.calls.length).toBe(before + 1)
    await expect.poll(() => state.tiles.some(tile => !tile.fail)).toBe(true)
    await expect.poll(() => page.locator('.pa-map-alert').count()).toBe(0)
    await expect.poll(() => visibility(page, ndviLayer)).toBe('visible')
})
