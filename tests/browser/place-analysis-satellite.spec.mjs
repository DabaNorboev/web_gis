import { test, expect } from '@playwright/test'
import { markSelectedSatelliteUnusable, responseFor } from '../frontend/fixtures/place-analysis.mjs'

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
    await page.getByRole('button', { name: 'Анализировать точку', exact: true }).press('Enter')
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
        if (request.blocks[0] === 'satellite' && request.date) options.changeSatellite?.(response.blocks.satellite)
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
    await expect(page.locator('[data-satellite-coverage]')).toBeVisible()
    await expect(page.locator('.pa-sat-meta')).toContainText('Copernicus Sentinel-2 L2A')
}
async function refreshFromOverview(page) {
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await page.getByRole('button', { name: 'Обновить спутник', exact: true }).click()
    await openSatellite(page)
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
    await expect(page.getByLabel('Дата снимка').locator('option:checked')).toHaveText('Выберите дату')
    await expect(card(page)).toHaveCount(0)
    const options = page.getByLabel('Дата снимка', { exact: true }).locator('option')
    await expect(options).toHaveCount(3)
    await expect(options.nth(1)).toContainText('07.05.2024')
    await expect(options.nth(1)).toContainText('ограничение')
    await chooseDate(page, '2024-05-07')
    await expectReady(page)
    await expect.poll(() => state.calls.length).toBe(4)
    expect(state.calls[3].blocks).toEqual(['satellite'])
    expect(state.calls[3].date).toBe('2024-05-07')
    await expect(card(page)).toHaveCount(0)
    await expect(page.locator('[data-satellite-coverage]')).toContainText('87,5')
    await expect(page.locator('[data-satellite-coverage]')).toContainText('пригодно для NDVI')
    await expect(page.getByLabel('Область спутникового слоя').locator('option:checked')).toHaveText('Вся подготовленная территория')
    await expect(page.getByText('Версии', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Synthetic early-spring snow and phenology note; not a summer state.')).toBeVisible()
    await expect(page.locator('.pa-sat-meta > div').filter({ hasText: 'Средний NDVI' }).locator('dd')).toContainText('0,31')
    await expect(page.getByText('Неизвестно / исключено маской')).toBeVisible()
    await expect(page.getByText('NDVI 0.8 … 1')).toBeVisible()
    const guide = page.locator('.pa-guide summary')
    await guide.click()
    await expect(page.getByText(/Прозрачные пиксели означают пропуск/)).toBeVisible()
    await guide.click()
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
    await expect(satelliteLayer.getByLabel('Непрозрачность спутникового слоя')).toBeVisible()
    await expect.poll(() => layerIndex(page, ndviLayer)).toBeLessThan(await layerIndex(page, 'pa-radius-line'))
    await expect.poll(() => layerIndex(page, ndviLayer)).toBeLessThan(await layerIndex(page, 'pa-poi-fill'))
    for (let i = 0; i < 3; i++) await satelliteLayer.locator('.pa-layer-move').first().click()
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
    await expect(page.getByText('Загрузка спутниковых данных…')).toBeVisible()
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
    await expect(page.locator('.pa-alert--retry strong', { hasText: 'Изображения недоступны' })).toBeVisible()
    await expect(page.locator('.pa-alert--retry').filter({ hasText: 'Изображения недоступны' }).locator('p')).toContainText('Аналитика по кругу сохранена')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getStyle().layers.some(layer => layer.id.startsWith('pa-satellite-')))).toBe(false)
    const before = state.calls.length
    options.deliveryDown = false
    await page.getByRole('button', { name: 'Повторить загрузку изображений', exact: true }).click()
    await expectReady(page)
    await expect.poll(() => state.calls.length).toBe(before + 1)
    expect(state.calls.at(-1).blocks).toEqual(['satellite'])
    await expect.poll(() => visibility(page, ndviLayer)).toBe('visible')
})

test('satellite read errors, absent NDVI and corrupt replies preserve the selected POI', async ({ page }) => {
    const options = {
        changeSatellite(block) {
            Object.assign(block, { status: 'ERROR', code: 'SATELLITE_READ_FAILED', message: 'Не удалось прочитать спутниковые данные.', data: null })
        },
    }
    const state = await setup(page, options)
    await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
    await page.getByRole('button', { name: 'Все', exact: true }).click()
    const pharmacy = page.locator('.pa-objects').getByRole('button', { name: /Synthetic API pharmacy/ })
    await pharmacy.click()

    await openSatellite(page)
    await chooseDate(page, '2024-05-07')
    await expect(page.locator('.pa-alert--retry').getByRole('button')).toHaveText('Повторить')
    await expect(page.getByText('Не удалось прочитать спутниковые данные', { exact: true })).toBeVisible()
    await expect.poll(() => sourceTiles(page, tciLayer)).toBeUndefined()

    options.changeSatellite = block => markSelectedSatelliteUnusable(block.data)
    await page.getByRole('button', { name: 'Повторить загрузку спутника' }).click()
    await expect(page.getByText('Средний NDVI недоступен. Нет пригодных пикселей NDVI.', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Дата снимка').locator('option:checked')).toHaveText('07.05.2024')
    await page.getByRole('button', { name: 'Снимок', exact: true }).click()
    await expect.poll(() => visibility(page, tciLayer)).toBe('visible')
    await expect.poll(() => state.tiles.some(tile => tile.path.includes('/2024-05-07/true-color/'))).toBe(true)

    options.deliveryDown = true
    await refreshFromOverview(page)
    await expect(page.getByText('Изображения недоступны', { exact: true })).toBeVisible()
    await expect.poll(() => sourceTiles(page, tciLayer)).toBeUndefined()

    options.deliveryDown = false
    options.changeSatellite = block => {
        const data = block.data
        markSelectedSatelliteUnusable(data)
        const coverage = data.selected.coverage
        Object.assign(coverage, {
            prepared_pixels: 0, prepared_fraction: 0, geographic_pixels: 0, geographic_fraction: 0,
            inside_rectangle_outside_target_pixels: coverage.circle_pixels, source_pixels: {},
        })
        coverage.reason_counts.cloud_or_cirrus = 0
        coverage.reason_counts.outside_target = coverage.circle_pixels
        const noPreparedData = { reason: 'NO_PREPARED_DATA', mean_ndvi_reason: 'NO_PREPARED_DATA' }
        Object.assign(data.selected, noPreparedData, { layers: null })
        Object.assign(data.releases.find(release => release.date === data.selected.date), noPreparedData)
    }
    await page.getByRole('button', { name: 'Повторить загрузку изображений' }).click()
    await expect(page.getByText('Средний NDVI недоступен. Для круга нет подготовленных пикселей.', { exact: true })).toBeVisible()
    await expect(page.getByText('Изображения недоступны', { exact: true })).toHaveCount(0)
    await expect.poll(() => sourceTiles(page, tciLayer)).toBeUndefined()

    options.changeSatellite = block => {
        markSelectedSatelliteUnusable(block.data)
        block.data.selected.layers.ndvi.tileSize = 512
    }
    await refreshFromOverview(page)
    await expect(page.locator('.pa-alert--retry').getByRole('status')).toHaveText('Получен несогласованный ответ')
    await expect.poll(() => sourceTiles(page, tciLayer)).toBeUndefined()

    await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
    await expect(pharmacy).toBeVisible()
    await expect(pharmacy).toHaveAttribute('aria-pressed', 'true')
    expect(state.calls.filter(call => call.blocks.includes('poi'))).toHaveLength(1)
})

test('keyboard controls, short screens and narrow layout keep the satellite UI usable', async ({ page }) => {
    await setup(page, { changeSatellite(block) {
        const reasons = block.data.selected.coverage.reason_counts
        reasons.nodata -= 50
        reasons.SCL2_dark_or_shadow = 50
    } })
    await openSatellite(page)
    await chooseDate(page, '2024-05-07')
    await expectReady(page)
    const coverage = page.getByText('Покрытие круга и причины исключений', { exact: true })
    await coverage.focus(); await page.keyboard.press('Enter')
    const darkReason = page.locator('.pa-sat-reasons li').filter({ hasText: 'Тёмная поверхность или тень' })
    await expect(darkReason).toBeVisible()
    const aligned = row => row.evaluate(element => {
        const [label, value] = Array.from(element.children, child => child.getBoundingClientRect())
        return Math.abs(label.top - value.top) <= 1 && label.right <= value.left
            && value.right <= element.getBoundingClientRect().right + 1
    })
    expect(await aligned(darkReason)).toBe(true)
    expect(await aligned(page.locator('.pa-sat-meta > div').filter({ hasText: 'Средний NDVI' }))).toBe(true)
    await page.getByText('Ограничения набора', { exact: true }).click()
    await expect(page.getByText('Точность маски облаков и теней отдельно не проверялась.')).toBeVisible()
    await expect(page.getByText('Synthetic fixture limitation, not a real dataset.')).toHaveCount(0)
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
    await expect(page.getByLabel('Область спутникового слоя')).toBeVisible()
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

test('circle display masks raster pixels only, follows camera, and survives mode and tab changes', async ({ page }) => {
    const state = await setup(page)
    await openSatellite(page)
    await chooseDate(page, '2024-05-07')
    await expectReady(page)
    const scope = page.getByLabel('Область спутникового слоя')
    await expect(scope).toHaveValue('territory')
    await page.locator('[data-layer-key="radius"] input[type="checkbox"]').uncheck()
    await setOpacity(page, page.getByLabel('Непрозрачность спутникового слоя'), '1')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map').areTilesLoaded())).toBe(true)
    await page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        const ring = map.getSource('pa-radius').serialize().data.geometry.coordinates[0]
        const west = ring[0][0], east = ring[1][0], south = ring[0][1], north = ring[2][1]
        window.__scopeSamples = [[(west + east) / 2, (south + north) / 2], [east + (east - west), (south + north) / 2]]
        map.jumpTo({ center: window.__scopeSamples[0], zoom: 14 })
    })
    async function pixels() {
        return page.evaluate(() => new Promise(resolve => {
            const map = window.__smokeMapIn('.pa-map')
            map.once('render', () => {
                const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')
                resolve(window.__scopeSamples.map(coordinate => {
                    const p = map.project(coordinate), rgba = new Uint8Array(4)
                    gl.readPixels(Math.round(p.x * canvas.width / canvas.clientWidth), Math.round(canvas.height - p.y * canvas.height / canvas.clientHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
                    return [...rgba]
                }))
            })
            map.triggerRepaint()
        }))
    }
    await expect.poll(() => pixels()).toEqual([[0, 0, 0, 255], [0, 0, 0, 255]])
    const city = await pixels()
    const requests = state.calls.length
    await scope.selectOption('circle')
    await expect(page.getByLabel('Область спутникового слоя').locator('option:checked')).toHaveText('Только круг анализа')
    const circle = await pixels()
    expect(circle[0]).toEqual(city[0])
    expect(circle[1]).not.toEqual(city[1])
    const checkbox = page.locator('[data-layer-key="satellite"] input[type="checkbox"]')
    await checkbox.uncheck()
    const hidden = await pixels()
    expect(circle[1]).toEqual(hidden[1])
    expect(circle[0]).not.toEqual(hidden[0])
    await checkbox.check()
    await page.getByRole('button', { name: 'Снимок', exact: true }).click()
    expect((await pixels())[1]).toEqual(hidden[1])
    await page.getByRole('button', { name: 'NDVI', exact: true }).click()
    const ndvi = await pixels()
    expect(ndvi[1]).toEqual(hidden[1])
    await page.evaluate(() => window.__smokeMapIn('.pa-map').jumpTo({ bearing: 35, pitch: 35, zoom: 14.5 }))
    const moved = await pixels()
    expect(moved[0]).not.toEqual(moved[1])
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await openSatellite(page)
    await expect(scope).toHaveValue('circle')
    expect(state.calls).toHaveLength(requests)
    await scope.selectOption('territory')
    await expect(page.getByLabel('Область спутникового слоя').locator('option:checked')).toHaveText('Вся подготовленная территория')
    const restored = await pixels()
    expect(restored[0]).toEqual(restored[1])
})


test('satellite controls have one owner and NDVI legend preserves manual state across the page lifecycle', async ({ page }, testInfo) => {
    const state = await setup(page)
    const layers = page.locator('.pa-layers')
    const legend = layers.getByRole('button', { name: 'Легенда NDVI', exact: true })
    const body = page.locator('#pa-ndvi-legend-body')
    await expect(legend).toHaveCount(0)
    await openSatellite(page)
    await expect(page.getByLabel('Дата снимка', { exact: true })).toHaveCount(1)
    await expect(page.getByRole('group', { name: 'Вид спутниковых данных' })).toHaveCount(1)
    await expect(page.getByLabel('Область спутникового слоя')).toHaveCount(1)
    await expect(layers.locator('select, .pa-sat-mode')).toHaveCount(0)
    await expect(page.locator('.pa-panel__scroll').getByLabel('Непрозрачность спутникового слоя')).toHaveCount(0)
    await expect(legend).toHaveCount(0)
    await chooseDate(page, '2024-05-07')
    await expectReady(page)
    await expect(legend).toHaveAttribute('aria-expanded', 'true')
    await expect(legend).toHaveAttribute('aria-controls', 'pa-ndvi-legend-body')
    await expect(body).toBeVisible()
    await expect(body.locator('.pa-legend__swatch')).toHaveCount(8)
    await expect(body.getByText('Неизвестно / исключено маской', { exact: true })).toBeVisible()
    const satellite = layers.locator('[data-layer-key="satellite"]')
    await expect(satellite).toContainText('NDVI (Sentinel-2) · 07.05.2024')
    await expect(satellite.getByLabel('Непрозрачность спутникового слоя')).toHaveCount(1)
    const requests = state.calls.length
    await page.getByLabel('Область спутникового слоя').selectOption('circle')
    await expect(page.getByLabel('Область спутникового слоя').locator('option:checked')).toHaveText('Только круг анализа')
    expect(state.calls).toHaveLength(requests)
    await legend.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('satellite-controls-ndvi.png') })
    await legend.focus(); await page.keyboard.press('Enter')
    await expect(legend).toHaveAttribute('aria-expanded', 'false')
    await expect(body).toBeHidden()
    for (const tab of ['Обзор', 'Объекты', 'Воздух', 'Спутник']) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        await expect(legend).toHaveAttribute('aria-expanded', 'false')
        await expect(body).toBeHidden()
        if (tab !== 'Спутник') await expect(page.getByLabel('Область спутникового слоя')).toHaveCount(0)
    }
    await expect(page.getByLabel('Область спутникового слоя')).toHaveValue('circle')
    await chooseDate(page, '2024-08-15')
    await expectReady(page)
    await expect(satellite).toContainText('15.08.2024')
    await expect(legend).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Снимок', exact: true }).click()
    await expect(legend).toHaveCount(0)
    await expect(satellite).toContainText('Спутниковый снимок · 15.08.2024')
    await expect(page.getByText('Легенда снимка', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'NDVI', exact: true }).click()
    await expect(legend).toHaveAttribute('aria-expanded', 'false')
    await legend.focus(); await page.keyboard.press('Space')
    await expect(legend).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(legend).toHaveAttribute('aria-expanded', 'true')
    await expect(body).toBeVisible()
    const checkbox = satellite.locator('input[type="checkbox"]')
    await checkbox.uncheck()
    await expect(legend).toHaveCount(0)
    await checkbox.check()
    await expect(legend).toHaveAttribute('aria-expanded', 'true')
    const slider = page.getByLabel('Непрозрачность спутникового слоя')
    await setOpacity(page, slider, '0')
    await expect(legend).toHaveCount(0)
    await setOpacity(page, slider, '0.7')
    await expect(legend).toHaveAttribute('aria-expanded', 'true')
    await legend.click()
    // Confirm a different synthetic place, retaining the page-owned preference.
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).click()
    await page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map'), center = map.getCenter()
        map.jumpTo({ center: [center.lng + .01, center.lat] })
    })
    await page.locator('.pa-map').press('Enter')
    await page.getByRole('button', { name: 'Анализировать точку', exact: true }).click()
    await expect(card(page).getByRole('status')).toHaveText('Наблюдение готово')
    await expect(legend).toHaveAttribute('aria-expanded', 'false')
    await openSatellite(page)
    await expect(page.getByLabel('Область спутникового слоя')).toHaveValue('circle')
    await chooseDate(page, '')
    await expect(page.getByLabel('Дата снимка').locator('option:checked')).toHaveText('Выберите дату')
    await expect(card(page)).toHaveCount(0)
    await expect(legend).toHaveCount(0)
    await chooseDate(page, '2024-05-07')
    await expectReady(page)
    await expect(legend).toHaveAttribute('aria-expanded', 'false')
    await legend.focus(); await page.keyboard.press('Enter')
    await expect(body).toBeVisible()
    // The panel itself remains collapsible even when its contents need scrolling.
    const panelToggle = layers.getByRole('button', { name: 'Слои карты', exact: true })
    await panelToggle.focus(); await page.keyboard.press('Enter')
    await expect(panelToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(legend).toBeHidden()
    await page.keyboard.press('Space')
    await expect(panelToggle).toHaveAttribute('aria-expanded', 'true')
    await body.getByText('Неизвестно / исключено маской', { exact: true }).scrollIntoViewIfNeeded()
    await expect(body).toBeVisible()
    expect(await layers.evaluate(el => el.scrollHeight >= el.clientHeight)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
})
