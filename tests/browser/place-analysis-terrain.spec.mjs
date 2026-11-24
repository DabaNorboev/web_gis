import { expect, test } from '@playwright/test'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

const terrainTiles = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/**'
const terrainPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAB/klEQVR42u3TQQ0AAAgDsUlHClL3xwJNquCSy2zgLQkwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADIABVMAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABMIAEGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAbAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHgKPTkEOHbz54BAAAAAElFTkSuQmCC', 'base64') // 160 m, encoded as Terrarium RGB.
const satellitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const terrainReply = { contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: terrainPng }

function readMap(page) {
    return page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        return {
            center: map.getCenter().toArray(),
            zoom: map.getZoom(),
            pitch: map.getPitch(),
            elevation: map.queryTerrainElevation(map.getCenter()),
            terrain: map.getTerrain()?.source ?? null,
            hasTerrainSource: !!map.getSource('pa-terrain'),
            circle: map.getSource('pa-radius')?.serialize().data,
        }
    })
}

async function openAnalysis(page) {
    const analysisRequests = []
    await page.route('**/api/v1/place-analysis', route => {
        const request = route.request().postDataJSON()
        analysisRequests.push(request)
        return route.fulfill({ json: responseFor(request, { poi: 'READY', satellite: 'READY' }) })
    })
    await page.route('**/api/v1/satellite/**', route => route.fulfill({ contentType: 'image/png', body: satellitePng }))
    await page.goto('/')
    const mode = page.getByRole('group', { name: 'Режим карты' })
    const flat = mode.getByRole('button', { name: '2D', exact: true })
    const relief = mode.getByRole('button', { name: '3D', exact: true })
    await expect(flat).toHaveAttribute('aria-pressed', 'true')
    await expect(relief).toBeEnabled()

    await page.getByRole('button', { name: 'Точка на карте', exact: true }).press('Enter')
    await page.locator('.pa-map').press('Enter')
    await page.getByRole('button', { name: 'Анализировать точку', exact: true }).press('Enter')
    const marker = page.locator('.pa-map-marker[data-poi-id="osm:node:1"]')
    await expect(marker).toBeVisible()
    return { mode, flat, relief, marker, analysisRequests }
}

test('3D loads terrain on demand and preserves the analysis and camera across mode changes', async ({ page }) => {
    const requests = []
    await page.route(terrainTiles, route => {
        requests.push(route.request().url())
        return route.fulfill(terrainReply)
    })
    const { mode, flat, relief, marker, analysisRequests } = await openAnalysis(page)
    await page.getByRole('tab', { name: 'Спутник', exact: true }).press('Enter')
    const date = page.getByLabel('Дата снимка', { exact: true })
    await date.selectOption('2024-05-07')
    await expect(page.locator('[data-satellite-coverage]')).toBeVisible()
    const scope = page.getByLabel('Область спутникового слоя')
    await scope.selectOption('circle')
    await page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        const { lng, lat } = map.getCenter()
        map.jumpTo({ center: [lng + .001, lat], zoom: 14.4 })
    })
    const requestCount = analysisRequests.length
    const initial = await readMap(page)
    expect(initial).toMatchObject({ pitch: 0, terrain: null, hasTerrainSource: false })
    expect(requests).toHaveLength(0)
    expect(initial.circle.geometry.type).toBe('Polygon')

    const controlBounds = await mode.boundingBox()
    const zoomControls = await page.locator('.pa-map .maplibregl-ctrl-top-right .maplibregl-ctrl-group').boundingBox()
    expect(controlBounds.x + controlBounds.width).toBeLessThan(zoomControls.x)
    await relief.press('Space')
    await expect(relief).toHaveAttribute('aria-pressed', 'true')
    await expect(relief).toBeFocused()
    await expect.poll(async () => (await readMap(page)).elevation).toBeCloseTo(160, 6)
    const tilted = await readMap(page)
    expect(tilted).toMatchObject({ pitch: 45, terrain: 'pa-terrain', hasTerrainSource: true, circle: initial.circle })
    expect(tilted.center).toEqual(initial.center)
    expect(tilted.zoom).toBeCloseTo(initial.zoom, 8)
    expect(requests.length).toBeGreaterThan(0)
    await expect(page.getByRole('link', { name: 'Рельеф AWS Terrain Tiles' })).toHaveCount(1)
    await expect(marker).toBeVisible()
    await expect(date).toHaveValue('2024-05-07')
    await expect(scope).toHaveValue('circle')

    // Returning to 2D keeps the position the user reached while exploring in 3D.
    await page.evaluate(() => window.__smokeMapIn('.pa-map').jumpTo({ center: [92.852, 56.011], zoom: 15 }))
    const explored = await readMap(page)
    await flat.press('Enter')
    await expect(flat).toHaveAttribute('aria-pressed', 'true')
    const restored = await readMap(page)
    expect(restored).toMatchObject({ pitch: 0, terrain: null, hasTerrainSource: false, circle: initial.circle })
    expect(restored.center).toEqual(explored.center)
    expect(restored.zoom).toBeCloseTo(explored.zoom, 8)
    await expect(page.getByRole('link', { name: 'Рельеф AWS Terrain Tiles' })).toHaveCount(0)
    await expect(marker).toBeVisible()
    await expect(date).toHaveValue('2024-05-07')
    await expect(scope).toHaveValue('circle')
    expect(analysisRequests).toHaveLength(requestCount)
})

for (const status of [404, 503]) {
    test(`terrain ${status} returns to 2D and can be retried independently`, async ({ page }) => {
        let available = false
        let attempted = 0
        await page.route(terrainTiles, route => {
            attempted++
            return route.fulfill(available ? terrainReply : {
                status, headers: { 'access-control-allow-origin': '*' }, body: '',
            })
        })
        const { flat, relief, marker, analysisRequests } = await openAnalysis(page)
        await expect.poll(() => analysisRequests.length).toBe(3)
        const initial = await readMap(page)
        await relief.click()
        const message = page.getByText('Рельеф недоступен. Карта переключена в 2D.', { exact: true })
        await expect(message).toBeVisible({ timeout: 12_000 })
        await expect(flat).toHaveAttribute('aria-pressed', 'true')
        const restored = await readMap(page)
        expect(restored).toMatchObject({ pitch: 0, terrain: null, hasTerrainSource: false, circle: initial.circle })
        expect(restored.center).toEqual(initial.center)
        expect(restored.zoom).toBeCloseTo(initial.zoom, 8)
        expect(attempted).toBeGreaterThan(0)
        await expect(marker).toBeVisible()

        available = true
        await relief.click()
        await expect(message).toHaveCount(0)
        await expect(relief).toHaveAttribute('aria-pressed', 'true')
        await expect.poll(async () => (await readMap(page)).elevation).toBeCloseTo(160, 6)
        expect(analysisRequests).toHaveLength(3)
    })
}
