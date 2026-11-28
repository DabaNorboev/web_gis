import { openMapLayers, openMapSettings } from './support/map-controls.mjs'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { addressObject, places, searchResponse } from './fixtures.mjs'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

const selectionUrl = '**/api/v1/place-analysis/selection'
const ready = page => page.locator('[data-analysis-block="poi"]').getByRole('status')
const pick = page => page.getByRole('button', { name: 'Точка на карте', exact: true })
const draft = page => page.getByRole('dialog', { name: 'Выбранная точка' })

async function setup(page) {
    const analyses = []
    await page.route('**/api/v1/place-analysis', route => {
        const input = route.request().postDataJSON()
        analyses.push(input)
        return route.fulfill({ json: responseFor(input, { poi: 'READY' }) })
    })
    await page.route('**/api/v1/basemap/imagery/viewport', route => route.fulfill({ json: { provider: 'google_direct' } }))
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    await page.route(/^https:\/\/mt1\.google\.com\/vt\//, route => route.fulfill({
        contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: pixel,
    }))
    await page.goto('/')
    await openMapSettings(page)
    await expect(page.getByRole('button', { name: '3D', exact: true })).toBeEnabled()
    return analyses
}

function jump(page, center) {
    return page.evaluate(center => { window.__smokeMapIn('.pa-map').jumpTo({ center, zoom: 14 }) }, center)
}

function mapState(page) {
    return page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        return { center: map.getCenter().toArray(), zoom: map.getZoom(), circle: map.getSource('pa-radius').serialize().data }
    })
}

test.use({ hasTouch: true })

test('outside clicks and taps preserve the analyzed place and both basemaps are available', async ({ page, viewport }) => {
    const analyses = await setup(page)
    let allow = true
    await page.route(selectionUrl, route => route.fulfill(allow
        ? { json: { status: 'INSIDE' } }
        : { status: 422, json: { code: 'OUTSIDE_SERVICE_AREA' } },
    ))
    await pick(page).press('Enter')
    await page.locator('.pa-map').press('Enter')
    await expect(draft(page)).toBeVisible()
    await draft(page).getByRole('button', { name: 'Анализировать точку' }).press('Enter')
    await expect(ready(page)).toHaveText('Готово')
    await expect.poll(() => analyses.length).toBe(3)
    const before = await mapState(page)

    allow = false
    await jump(page, [93.4, 56.1])
    const outside = await mapState(page)
    expect(outside.center).not.toEqual(before.center)
    const canvas = page.locator('.pa-map canvas')
    const click = { position: { x: 35, y: 172 } }
    if (viewport.width <= 390) await canvas.tap(click)
    else await canvas.click(click)
    const message = page.getByRole('alert').filter({ hasText: 'Точку для анализа можно выбрать только в пределах Красноярска' })
    await expect(message).toBeVisible()
    await expect(draft(page)).toHaveCount(0)
    await expect(ready(page)).toHaveText('Готово')
    expect(await mapState(page)).toEqual(outside)
    expect(outside.circle).toEqual(before.circle)
    expect(analyses).toHaveLength(3)

    await openMapSettings(page)
    const basemap = page.getByRole('group', { name: 'Подложка карты' })
    await basemap.getByRole('button', { name: 'Спутник', exact: true }).press('Enter')
    await expect(page.locator('.pa-imagery-credit')).toBeVisible()
    expect(await mapState(page)).toEqual(outside)
    await basemap.getByRole('button', { name: 'Карта', exact: true }).press('Enter')
    await expect(page.locator('.pa-imagery-credit')).toHaveCount(0)
    await message.getByRole('button', { name: 'Вернуться к Красноярску' }).press('Enter')
    await expect(message).toHaveCount(0)
    expect((await mapState(page)).center).toEqual([92.85, 56.01])
    expect((await mapState(page)).circle).toEqual(before.circle)
})

test('the service boundary uses the server geometry and toggles independently of the basemap', async ({ page }) => {
    const boundaryResponse = page.waitForResponse(response => response.url().endsWith('.geojson') && response.ok())
    await setup(page)
    const servedBoundary = await boundaryResponse
    const serverBoundary = await readFile(new URL('../../resources/gis/krasnoyarsk-boundary.geojson', import.meta.url))
    expect(await servedBoundary.body()).toEqual(serverBoundary)

    await page.evaluate(() => {
        window.__smokeMapIn('.pa-map').jumpTo({ center: [92.69, 56.04], zoom: 8 })
    })
    const before = await mapState(page)
    await openMapLayers(page)
    const boundary = page.getByRole('checkbox', { name: 'Граница территории анализа' })
    const visibleSegments = () => page.evaluate(() => window.__smokeMapIn('.pa-map')
        .queryRenderedFeatures({ layers: ['pa-service-boundary-line'] }).length)
    await expect(boundary).toBeChecked()
    await expect.poll(visibleSegments).toBeGreaterThan(0)

    const basemap = page.getByRole('group', { name: 'Подложка карты' })
    await basemap.getByRole('button', { name: 'Спутник', exact: true }).press('Enter')
    await expect(page.locator('.pa-imagery-credit')).toBeVisible()
    const layers = await page.evaluate(() => window.__smokeMapIn('.pa-map').getStyle().layers.map(layer => layer.id))
    expect(layers.indexOf('pa-service-boundary-line')).toBeGreaterThan(layers.indexOf('pa-imagery-basemap'))
    await expect.poll(visibleSegments).toBeGreaterThan(0)

    await boundary.press('Space')
    await expect(boundary).not.toBeChecked()
    await expect.poll(visibleSegments).toBe(0)
    await basemap.getByRole('button', { name: 'Карта', exact: true }).press('Enter')
    await expect(boundary).not.toBeChecked()
    await boundary.press('Space')
    await expect.poll(visibleSegments).toBeGreaterThan(0)
    expect(await mapState(page)).toEqual(before)
})

test('a transient basemap tile failure retries without moving the camera outside the city', async ({ page }) => {
    await setup(page)
    await jump(page, [93.4, 56.1])
    const before = await mapState(page)
    let failedTile
    let attempts = 0
    // A minimal MVT with an empty road layer.
    const tile = Buffer.from([0x1a, 0x0b, 0x78, 0x02, 0x0a, 0x04, 0x72, 0x6f, 0x61, 0x64, 0x28, 0x80, 0x20])
    await page.route('**/smoke-vector/*.pbf', route => {
        const url = route.request().url()
        failedTile ??= url
        if (url === failedTile && ++attempts === 1) return route.fulfill({ status: 503 })
        return route.fulfill({ contentType: 'application/vnd.mapbox-vector-tile', body: tile })
    })
    const recovered = page.waitForResponse(response => response.url() === failedTile && response.ok())
    await page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        map.addSource('openmaptiles', { type: 'vector', tiles: [location.origin + '/smoke-vector/{z}-{x}-{y}.pbf'] })
        map.addLayer({ id: 'smoke-vector-road', type: 'line', source: 'openmaptiles', 'source-layer': 'road' })
    })
    await recovered
    expect(attempts).toBe(2)
    expect(await mapState(page)).toEqual(before)
})

test('late boundary checks and unavailable results cannot confirm an obsolete keyboard choice', async ({ page }) => {
    const analyses = await setup(page)
    let stale
    let available = false
    await page.route(selectionUrl, route => {
        const point = route.request().postDataJSON()
        if (point.lon > 93) { stale = route; return }
        return route.fulfill(available ? { json: { status: 'INSIDE' } }
            : { status: 503, json: { code: 'SERVICE_AREA_UNAVAILABLE' } })
    })
    await pick(page).press('Enter')
    await jump(page, [93.4, 56.1])
    await page.locator('.pa-map').press('Enter')
    await expect.poll(() => !!stale).toBe(true)
    await jump(page, [92.85, 56.01])
    await page.locator('.pa-map').press('Enter')
    const unavailable = page.getByRole('alert').filter({ hasText: 'Не удалось проверить границу Красноярска' })
    await expect(unavailable).toBeVisible()
    await expect(draft(page)).toHaveCount(0)
    await stale.fulfill({ json: { status: 'INSIDE' } }).catch(() => {})
    await expect(unavailable).toBeVisible()
    await expect(draft(page)).toHaveCount(0)

    available = true
    await page.locator('.pa-map').press('Enter')
    await expect(draft(page)).toBeVisible()
    await expect(unavailable).toHaveCount(0)
    expect(analyses).toHaveLength(0)
})

test('outside local resolver coordinates stay unselected', async ({ page }) => {
    const analyses = await setup(page)
    const address = { ...places.a, lon: 93.4, lat: 56.1 }
    await page.route('**/api/v1/addresses/search?*', route => route.fulfill({
        json: searchResponse(new URL(route.request().url()).searchParams.get('q')),
    }))
    await page.route(/\/api\/v1\/addresses\/osm[^/?]+$/, route => route.fulfill({ json: {
        address: { id: address.id, label: address.label, object: addressObject(address),
            bounds: [address.lon, address.lat, address.lon, address.lat], source: 'OpenStreetMap',
            dataset_import_id: 1, observed_at: null, source_updated_at: null, reason: 'Synthetic' },
        capabilities: { resolver_version: 1, selected_profile_version: 1 },
    } }))
    await page.route(selectionUrl, route => {
        expect(route.request().postDataJSON()).toEqual({ lon: address.lon, lat: address.lat })
        return route.fulfill({ status: 422, json: { code: 'OUTSIDE_SERVICE_AREA' } })
    })
    await page.getByRole('combobox', { name: 'Поиск адреса' }).fill('Тестовая улица, 1')
    await page.getByRole('button', { name: 'Тестовая улица, 1', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Точку для анализа можно выбрать только в пределах Красноярска' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
    expect(analyses).toHaveLength(0)
})
