import { test, expect } from './support.mjs'
import { places, profile } from './fixtures.mjs'

const initial = { lon: 92.90000012345678, lat: 56.00000012345678 }
function labelResponse(match = 'CONTAINING', ids = [1]) {
    return { data: { match, requires_choice: ids.length > 1, candidates: ids.map(id => ({ id: `osm:way:${id}`, label: `Тестовая, ${id}`, object_type: 'building', geometry_type: 'POLYGON', distance_m: match === 'CONTAINING' ? 0 : 24.6 })) },
        meta: { source: 'OpenStreetMap', dataset_import_id: 3, observed_at: null, source_updated_at: null, calculated_at: '2026-10-23T00:00:00Z', nearby_radius_m: 100,
            coverage: { status: 'UNKNOWN', reason: 'Подтверждённая область отбора данных отсутствует.' },
            quality: { method: match === 'NONE' ? null : 'DERIVED', availability: match === 'NONE' ? 'INSUFFICIENT_DATA' : 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Полнота, вход и доступ не подтверждены.' } } }
}
async function install(page) {
    const requests = [], transport = []
    let handler = route => route.fulfill({ json: labelResponse() })
    await page.route('**/api/v1/addresses/resolve-point', async route => {
        const request = route.request()
        requests.push({ url: request.url(), method: request.method(), headers: request.headers(), point: request.postDataJSON() })
        await handler(route)
    })
    await page.route('**/api/v1/transport/analysis?*', route => {
        const params = new URL(route.request().url()).searchParams
        const point = { lon: Number(params.get('lon')), lat: Number(params.get('lat')) }, radius = Number(params.get('radius_m'))
        transport.push(point)
        const data = profile({ ...places.a, ...point }, radius)
        return route.fulfill({ json: { ...data.blocks.transport.data, point, radius_m: radius, scope: 'imported_stops',
            analysis_area: data.map.analysis_area, analysis_bounds: data.map.analysis_bounds, stops_in_radius: [], nearest_stop: null,
            coverage: { status: 'COVERED', reason: 'Synthetic coverage' } } })
    })
    return { requests, transport, respond(next) { handler = next } }
}
const selectedPoint = page => page.evaluate(async () => {
    const data = await window.__smokeMapIn('.placelens-map').getSource('transport-selection').getData()
    return data.features.find(feature => feature.properties.kind === 'point')?.geometry.coordinates
})
const open = page => page.goto(`/?lon=${initial.lon}&lat=${initial.lat}&radius_m=500`)

test('home point label handles containment, ambiguity and nearby without moving analysis or changing history', async ({ page, api }) => {
    const pointApi = await install(page)
    pointApi.respond(route => route.fulfill({ json: labelResponse('CONTAINING', [1, 2]) }))
    await open(page)
    const label = page.locator('.point-address')
    await expect(label).toContainText('Выберите подпись')
    await expect(label.getByRole('radio')).toHaveCount(2)
    expect(pointApi.requests).toHaveLength(1)
    const request = pointApi.requests[0]
    expect(request.point).toEqual(initial); expect(request.method).toBe('POST')
    expect(new URL(request.url).search).toBe(''); expect(request.headers.referer).toBeUndefined()
    await expect(label.getByRole('radio').first()).not.toBeChecked()
    const url = page.url()
    await label.getByRole('radio').first().press('Space')
    await label.getByRole('radio').first().press('ArrowRight')
    await expect(label.getByRole('radio').last()).toBeChecked()
    await expect(label.getByRole('heading')).toHaveText('Тестовая, 2')
    expect(page.url()).toBe(url)
    expect(pointApi.transport.at(-1)).toEqual(initial)
    await expect.poll(() => selectedPoint(page)).toEqual([initial.lon, initial.lat])
    await page.getByRole('button', { name: '300 м', exact: true }).press('Enter')
    await expect(page.getByRole('button', { name: '300 м', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(pointApi.requests).toHaveLength(1)
    expect(pointApi.transport.at(-1)).toEqual(initial)
    await label.getByText('Источник и точность подписи', { exact: true }).press('Enter')
    await expect(label).toContainText('Дата наблюдения: неизвестна')
    await expect(label).toContainText('Анализ остаётся в выбранных координатах')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const count = pointApi.requests.length
    const canvas = page.locator('.placelens-map canvas')
    await canvas.scrollIntoViewIfNeeded()
    await canvas.hover()
    await page.mouse.move(40, 40) // Pointer movement alone is not a selection.
    expect(pointApi.requests).toHaveLength(count)
    pointApi.respond(route => route.fulfill({ json: labelResponse('NEARBY', [3]) }))
    await canvas.click({ position: { x: 120, y: 180 } })
    await expect(label.getByRole('heading')).toHaveText('Рядом с Тестовая, 3')
    await expect(label).toContainText('25 м по прямой до контура')
    const changed = pointApi.requests.at(-1).point
    expect(changed).not.toEqual(initial)
    await expect.poll(() => selectedPoint(page)).toEqual([changed.lon, changed.lat])
    expect(pointApi.transport.at(-1)).toEqual(changed)
    await page.goBack()
    await expect.poll(() => pointApi.requests.at(-1).point).toEqual(initial)
    await expect.poll(() => selectedPoint(page)).toEqual([initial.lon, initial.lat])
    await page.screenshot({ path: test.info().outputPath('point-label.png'), fullPage: true })
})

test('home point label loading failure retry and no-data leave transport available', async ({ page, api }) => {
    const pointApi = await install(page)
    let release
    const gate = new Promise(resolve => { release = resolve })
    pointApi.respond(async route => { await gate; await route.fulfill({ status: 503, json: { message: 'Synthetic failure' } }) })
    await open(page)
    const label = page.locator('.point-address')
    await expect(label).toContainText('Определяем адрес по локальным данным')
    await expect(page.getByRole('button', { name: '300 м', exact: true })).toBeEnabled()
    release()
    await expect(label.getByRole('button', { name: 'Повторить определение адреса' })).toBeVisible()
    pointApi.respond(route => route.fulfill({ json: labelResponse('NONE', []) }))
    await label.getByRole('button', { name: 'Повторить определение адреса' }).press('Enter')
    await expect(label).toContainText('Подходящих адресных данных нет')
    await expect(label.getByRole('heading')).toHaveText('Точка анализа')
    expect(pointApi.requests).toHaveLength(2)
    expect(pointApi.transport).toHaveLength(1)
    const unavailable = labelResponse('NONE', []); unavailable.meta.quality.availability = 'UNAVAILABLE'
    pointApi.respond(route => route.fulfill({ json: unavailable }))
    await page.reload()
    await expect(label).toContainText('Адресные данные недоступны')
    await expect(label.getByRole('button', { name: 'Повторить определение адреса' })).toBeVisible()
    pointApi.respond(route => route.fulfill({ json: labelResponse() }))
    await label.getByRole('button', { name: 'Повторить определение адреса' }).press('Enter')
    await expect(label).toContainText('Внутри или на границе адресного контура OSM')
    await page.getByRole('button', { name: 'Сбросить', exact: true }).press('Enter')
    await expect(label).toHaveCount(0)
    await expect(page.getByRole('combobox')).toBeVisible()
    expect(new URL(page.url()).searchParams.has('lon')).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('home ignores point label responses that escaped abort after a newer selection and reset', async ({ page, api }) => {
    // Delay delivery after real fetch/JSON completed, modeling a response that
    // escaped network cancellation. All other requests use the real fetch.
    await page.addInitScript(() => {
        const fetch = window.fetch.bind(window)
        window.__labelDeliveries = []
        window.fetch = async (...args) => {
            const response = await fetch(...args)
            if (args[0] !== '/api/v1/addresses/resolve-point') return response
            const data = await response.json()
            return { ok: response.ok, status: response.status, json: () => new Promise(resolve => window.__labelDeliveries.push(() => resolve(data))) }
        }
    })
    const pointApi = await install(page)
    await open(page)
    await expect.poll(() => page.evaluate(() => window.__labelDeliveries.length)).toBe(1)
    pointApi.respond(route => route.fulfill({ json: labelResponse('NEARBY', [9]) }))
    const canvas = page.locator('.placelens-map canvas')
    await canvas.scrollIntoViewIfNeeded(); await canvas.click({ position: { x: 120, y: 180 } })
    await expect.poll(() => page.evaluate(() => window.__labelDeliveries.length)).toBe(2)
    await page.evaluate(() => window.__labelDeliveries[1]())
    await expect(page.locator('.point-address h2')).toHaveText('Рядом с Тестовая, 9')
    await page.evaluate(() => window.__labelDeliveries[0]())
    await expect(page.locator('.point-address h2')).toHaveText('Рядом с Тестовая, 9')
    const latest = pointApi.requests.at(-1).point
    await expect.poll(() => selectedPoint(page)).toEqual([latest.lon, latest.lat])
    await page.getByRole('button', { name: 'Анализировать центр карты', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__labelDeliveries.length)).toBe(3)
    await page.getByRole('button', { name: 'Сбросить', exact: true }).click()
    await page.evaluate(() => window.__labelDeliveries[2]())
    await expect(page.locator('.point-address')).toHaveCount(0)
})
