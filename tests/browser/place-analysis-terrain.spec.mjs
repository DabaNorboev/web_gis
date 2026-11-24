import { expect, test } from '@playwright/test'
import { GeoJSONVT } from '@maplibre/geojson-vt'
import { fromGeojsonVt } from '@maplibre/vt-pbf'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

const terrainTiles = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/**'
const terrainPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAB/klEQVR42u3TQQ0AAAgDsUlHClL3xwJNquCSy2zgLQkwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADIABVMAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABMIAEGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAbAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHgKPTkEOHbz54BAAAAAElFTkSuQmCC', 'base64') // 160 m, encoded as Terrarium RGB.
const satellitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const imageryPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO4pOsGAAMaAUYOwgtKAAAAAElFTkSuQmCC', 'base64')
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
            exaggeration: map.getTerrain()?.exaggeration ?? null,
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
    await expect.poll(async () => (await readMap(page)).elevation).toBeCloseTo(240, 6)
    const tilted = await readMap(page)
    expect(tilted).toMatchObject({ terrain: 'pa-terrain', exaggeration: 1.5, hasTerrainSource: true, circle: initial.circle })
    expect(tilted.pitch).toBeCloseTo(55, 8)
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

test('satellite basemap refreshes attribution and preserves terrain and analysis layers', async ({ page }) => {
    test.setTimeout(60_000)
    const viewports = []
    await page.route('**/api/v1/basemap/imagery/viewport', route => {
        viewports.push(route.request().postDataJSON())
        return route.fulfill({ json: {
            provider: 'google', max_zoom: 19, tile_size: 256,
            attribution: viewports.length === 1 ? 'Map data © Google, First area' : 'Map data © Google, Second area',
        } })
    })
    await page.route('**/api/v1/basemap/imagery/*/*/*', route => route.fulfill({ contentType: 'image/png', body: imageryPng }))
    await page.route(terrainTiles, route => route.fulfill(terrainReply))
    const { relief, marker, analysisRequests } = await openAnalysis(page)
    await page.getByRole('tab', { name: 'Спутник', exact: true }).press('Enter')
    const date = page.getByLabel('Дата снимка', { exact: true })
    await date.selectOption('2024-05-07')
    await expect(page.locator('[data-satellite-coverage]')).toBeVisible()
    const scope = page.getByLabel('Область спутникового слоя')
    await scope.selectOption('circle')
    const requestCount = analysisRequests.length

    const basemap = page.getByRole('group', { name: 'Подложка карты' })
    const vectorButton = basemap.getByRole('button', { name: 'Карта', exact: true })
    const imageryButton = basemap.getByRole('button', { name: 'Спутник', exact: true })
    const credit = page.locator('.pa-imagery-credit')
    const before = await readMap(page)
    expect(viewports).toHaveLength(0)
    await expect(vectorButton).toHaveAttribute('aria-pressed', 'true')
    await imageryButton.press('Space')
    await expect(credit).toContainText('Map data © Google, First area')
    await expect(credit.getByRole('img', { name: 'Google Maps' })).toBeVisible()
    expect(await readMap(page)).toEqual(before)
    const order = await page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        return {
            order: map.getStyle().layers.map(layer => layer.id),
            vector: map.getLayoutProperty('offline', 'visibility'),
        }
    })
    expect(order.vector).toBe('none')
    expect(order.order.indexOf('pa-imagery-basemap')).toBeLessThan(order.order.indexOf('pa-satellite-ndvi-raster'))
    expect(order.order.indexOf('pa-imagery-basemap')).toBeLessThan(order.order.indexOf('pa-radius-line'))

    const imageryOutsideCircle = () => page.evaluate(() => new Promise(resolve => {
        const map = window.__smokeMapIn('.pa-map')
        map.once('render', () => {
            const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')
            const pixel = new Uint8Array(4)
            gl.readPixels(Math.floor(canvas.width * .08), Math.floor(canvas.height * .5), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
            resolve([...pixel])
        })
        map.triggerRepaint()
    }))
    await expect.poll(imageryOutsideCircle, { timeout: 20_000 }).toEqual([210, 45, 70, 255])

    await relief.press('Enter')
    await expect.poll(async () => (await readMap(page)).elevation).toBeCloseTo(240, 6)
    await page.evaluate(() => {
        window.__smokeMapIn('.pa-map').jumpTo({ center: [92.851, 56.011], zoom: 15, bearing: 30 })
    })
    await expect(credit).toContainText('Map data © Google, Second area')
    await expect.poll(imageryOutsideCircle, { timeout: 20_000 }).toEqual([210, 45, 70, 255])
    expect(viewports.length).toBeGreaterThan(1)
    await expect.poll(() => viewports.at(-1)?.zoom).toBe(15)
    const tilted = await readMap(page)
    await vectorButton.press('Enter')
    await expect(credit).toHaveCount(0)
    await expect(vectorButton).toHaveAttribute('aria-pressed', 'true')
    expect(await readMap(page)).toEqual(tilted)
    expect(await page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        return !map.getLayer('pa-imagery-basemap') && map.getLayoutProperty('offline', 'visibility') === 'visible'
    })).toBe(true)
    await expect(date).toHaveValue('2024-05-07')
    await expect(scope).toHaveValue('circle')
    await expect(marker).toBeAttached()
    expect(analysisRequests).toHaveLength(requestCount)
})

test('satellite basemap restores the vector map after a failure and retries with Google hybrid', async ({ page }) => {
    let available = false
    const tileRequests = []
    await page.route('**/api/v1/basemap/imagery/viewport', route => route.fulfill(available
        ? { json: { provider: 'google_hybrid' } } : { status: 503, json: { code: 'IMAGERY_UNAVAILABLE' } }))
    await page.route(/^https:\/\/mt1\.google\.com\/vt\//, route => {
        tileRequests.push(route.request().url())
        return route.fulfill({
            contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: satellitePng,
        })
    })
    const { marker, analysisRequests } = await openAnalysis(page)
    const before = await readMap(page)
    const basemap = page.getByRole('group', { name: 'Подложка карты' })
    await basemap.getByRole('button', { name: 'Спутник', exact: true }).press('Enter')
    const alert = page.getByRole('alert').filter({ hasText: 'Спутниковая подложка недоступна' })
    await expect(alert).toBeVisible()
    await expect(basemap.getByRole('button', { name: 'Карта', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await readMap(page)).toEqual(before)

    available = true
    await alert.getByRole('button', { name: 'Повторить' }).press('Enter')
    const credit = page.locator('.pa-imagery-credit')
    await expect(credit.getByRole('img', { name: 'Google Maps' })).toBeVisible()
    await expect(credit).toContainText('© Google')
    await expect(page.getByText('Дата съёмки не указана', { exact: true })).toBeVisible()
    expect(tileRequests).not.toHaveLength(0)
    expect(tileRequests[0]).toMatch(/^https:\/\/mt1\.google\.com\/vt\/lyrs=y&hl=ru&x=\d+&y=\d+&z=\d+$/)
    const firstZoom = Number(tileRequests[0].match(/&z=(\d+)$/)[1])
    await page.evaluate(() => window.__smokeMapIn('.pa-map').jumpTo({ zoom: 18 }))
    await expect.poll(() => tileRequests.some(url => Number(url.match(/&z=(\d+)$/)?.[1]) > Math.max(14, firstZoom))).toBe(true)
    await expect(alert).toHaveCount(0)
    await page.evaluate(zoom => window.__smokeMapIn('.pa-map').jumpTo({ zoom }), before.zoom)
    expect(await readMap(page)).toEqual(before)
    await expect(marker).toBeAttached()
    expect(analysisRequests).toHaveLength(3)
})

test('3D buildings follow the map theme and render on both basemaps', async ({ page }) => {
    const footprints = [
        ['complete', { render_height: 30, render_min_height: 6 }],
        ['hidden boolean', { render_height: 34, render_min_height: 0, hide_3d: true }],
        ['hidden integer', { render_height: 36, render_min_height: 0, hide_3d: 1 }],
        ['unknown base', { render_height: 26 }],
        ['inverted heights', { render_height: 16, render_min_height: 19 }],
    ].map(([name, heights], i) => {
        const west = 92.8509 + i * .00044, east = west + .00025
        const south = 56.0108, north = 56.0111
        return {
            type: 'Feature',
            properties: { name, ...heights },
            geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
        }
    })
    const buildings = new GeoJSONVT({ type: 'FeatureCollection', features: footprints }, { maxZoom: 14 })
    await page.route('**/smoke-buildings/**/*.mvt', route => {
        const [, z, x, y] = new URL(route.request().url()).pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.mvt$/)
        const tile = buildings.getTile(Number(z), Number(x), Number(y))
        return route.fulfill({
            contentType: 'application/vnd.mapbox-vector-tile',
            body: Buffer.from(fromGeojsonVt(tile ? { building: tile } : {})),
        })
    })
    await page.route(terrainTiles, route => route.fulfill(terrainReply))

    await page.route('**/api/v1/basemap/imagery/viewport', route => route.fulfill({ json: {
        provider: 'google', max_zoom: 19, tile_size: 256, attribution: 'Map data © Google',
    } }))
    await page.route('**/api/v1/basemap/imagery/*/*/*', route => route.fulfill({ contentType: 'image/png', body: imageryPng }))
    const { flat, relief, marker, analysisRequests } = await openAnalysis(page)
    await page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        map.addSource('openmaptiles', {
            type: 'vector',
            tiles: [location.origin + '/smoke-buildings/{z}/{x}/{y}.mvt'],
            maxzoom: 14,
        })
        map.jumpTo({ center: [92.852, 56.011], zoom: 14.4 })
    })
    const initial = await readMap(page)
    const layer = () => page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        return map.getStyle().layers.find(layer => layer.id === 'pa-buildings-3d') ?? null
    })
    const drawn = () => page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        return [...new Set(map.queryRenderedFeatures({ layers: ['pa-buildings-3d'] }).map(feature => feature.properties.name))]
    })
    const note = page.getByText('При приближении видны здания с приблизительными высотами.', { exact: true })
    expect(await layer()).toBeNull()
    await expect(note).toHaveCount(0)
    await relief.press('Space')
    await expect(note).toBeVisible()
    await expect.poll(async () => (await readMap(page)).elevation).toBeCloseTo(240, 6)
    expect(await layer()).toMatchObject({
        type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 15,
        layout: { visibility: 'none' },
    })
    expect(await drawn()).toEqual([])

    await page.evaluate(() => window.__smokeMapIn('.pa-map').setZoom(15.7))
    await expect.poll(() => page.evaluate(() => {
        const features = window.__smokeMapIn('.pa-map').querySourceFeatures('openmaptiles', { sourceLayer: 'building' })
        return new Set(features.map(feature => feature.properties.name)).size
    })).toBe(footprints.length)
    await expect.poll(drawn).toEqual(['complete'])
    const beforeTheme = await readMap(page)
    const color = (await layer()).paint['fill-extrusion-color']
    await page.getByRole('button', { name: 'Тёмная', exact: true }).press('Enter')
    await expect.poll(async () => (await layer()).paint['fill-extrusion-color']).not.toBe(color)
    expect(await readMap(page)).toEqual(beforeTheme)
    await expect.poll(drawn).toEqual(['complete'])
    await expect(marker).toBeAttached()

    await page.evaluate(() => window.__smokeMapIn('.pa-map').setZoom(14.5))
    await expect.poll(async () => (await layer()).layout.visibility).toBe('none')
    await expect.poll(drawn).toEqual([])
    await page.evaluate(() => window.__smokeMapIn('.pa-map').setZoom(15.7))
    await expect.poll(async () => (await layer()).layout.visibility).toBe('visible')
    await expect.poll(drawn).toEqual(['complete'])

    const basemap = page.getByRole('group', { name: 'Подложка карты' })
    const credit = page.locator('.pa-imagery-credit')
    const beforeSatellite = await readMap(page)
    await basemap.getByRole('button', { name: 'Спутник', exact: true }).press('Enter')
    await expect(credit).toBeVisible()
    await expect(note).toBeVisible()
    await expect.poll(drawn).toEqual(['complete'])
    expect(await readMap(page)).toEqual(beforeSatellite)

    const expectBuildingsAboveImagery = async () => {
        const layers = await page.evaluate(() => window.__smokeMapIn('.pa-map').getStyle().layers.map(layer => layer.id))
        expect(layers).toContain('pa-imagery-basemap')
        expect(layers.indexOf('pa-buildings-3d')).toBeGreaterThan(layers.indexOf('pa-imagery-basemap'))
    }
    await expectBuildingsAboveImagery()
    await flat.press('Enter')
    expect(await layer()).toBeNull()
    await relief.press('Enter')
    await expect.poll(async () => (await readMap(page)).elevation).toBeCloseTo(240, 6)
    await expect.poll(drawn).toEqual(['complete'])
    await expectBuildingsAboveImagery()

    await basemap.getByRole('button', { name: 'Карта', exact: true }).press('Enter')
    await expect(credit).toHaveCount(0)
    await expect(note).toBeVisible()
    await expect.poll(drawn).toEqual(['complete'])

    await flat.press('Enter')
    expect(await layer()).toBeNull()
    await expect(note).toHaveCount(0)
    expect((await readMap(page)).circle).toEqual(initial.circle)
    expect(analysisRequests).toHaveLength(3)
})

test('individual terrain tile failures keep 3D during startup and camera movement', async ({ page }) => {
    let failNextTile = true
    const { promise: initialReplies, resolve: releaseInitialReplies } = Promise.withResolvers()
    await page.route(terrainTiles, async route => {
        if (failNextTile) {
            failNextTile = false
            return route.fulfill({ status: 503, headers: terrainReply.headers, body: '' })
        }
        await initialReplies
        return route.fulfill(terrainReply)
    })
    const { relief, marker, analysisRequests } = await openAnalysis(page)
    const circle = (await readMap(page)).circle
    const terrainErrors = await page.evaluateHandle(() => {
        const errors = []
        window.__smokeMapIn('.pa-map').on('error', event => {
            if (event.sourceId === 'pa-terrain') errors.push(event.error.message)
        })
        return errors
    })
    const errorCount = () => terrainErrors.evaluate(errors => errors.length)

    try {
        await relief.click()
        await expect.poll(errorCount).toBe(1)
        await expect(relief).toHaveAttribute('aria-pressed', 'true')
    } finally {
        releaseInitialReplies()
    }
    await expect.poll(async () => (await readMap(page)).elevation).toBeCloseTo(240, 6)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map').areTilesLoaded())).toBe(true)

    failNextTile = true
    await page.evaluate(() => window.__smokeMapIn('.pa-map').jumpTo({
        center: [92.975, 56.075], zoom: 14, bearing: 75, pitch: 55,
    }))
    await expect.poll(errorCount).toBe(2)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map').areTilesLoaded())).toBe(true)
    await expect(relief).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Рельеф недоступен.', { exact: false })).toHaveCount(0)
    const afterMove = await readMap(page)
    expect(afterMove).toMatchObject({ terrain: 'pa-terrain', circle })
    expect(afterMove.pitch).toBeCloseTo(55, 8)
    expect(await page.evaluate(() => window.__smokeMapIn('.pa-map').getBearing())).toBeCloseTo(75, 8)
    await expect(marker).toBeAttached()
    expect(analysisRequests).toHaveLength(3)
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
        await expect.poll(async () => (await readMap(page)).elevation).toBeCloseTo(240, 6)
        expect(analysisRequests).toHaveLength(3)
    })
}
