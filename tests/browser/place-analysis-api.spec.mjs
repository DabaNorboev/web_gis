import { fixtures as geocodingFixtures, preview as geocodingPreview } from './support/geocoding.mjs'
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { airSnapshot, responseFor } from '../frontend/fixtures/place-analysis.mjs'

async function choosePoint(page) {
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    const button = page.getByRole('button', { name: 'Точка на карте', exact: true })
    await button.focus(); await page.keyboard.press('Enter')
    await expect(page.locator('.pa-map')).toBeFocused()
    await page.keyboard.press('Enter')
    const analyze = page.getByRole('button', { name: 'Анализировать точку', exact: true })
    await expect(analyze).toBeFocused(); await page.keyboard.press('Enter')
}
function fixture(route, statuses = {}) {
    return route.fulfill({ json: responseFor(route.request().postDataJSON(), statuses) })
}
const card = (page, key) => page.locator(`[data-analysis-block="${key}"]`)

test('analysis guides explain air and NDVI without reloading results', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'phone-320') await page.setViewportSize({ width: 320, height: 500 })
    const calls = []
    await page.route('**/api/v1/place-analysis', route => {
        calls.push(route.request().postDataJSON().blocks[0])
        return fixture(route, { poi: 'READY' })
    })
    await page.goto('/analysis'); await choosePoint(page)
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    await expect.poll(() => calls.length).toBe(3)
    await expect(page.getByText('Как это работает', { exact: true })).toHaveCount(0)
    for (const [tab, title, explanation] of [
        ['Воздух', 'Как читать график PM2.5', 'Почему станция может быть только в списке?'],
        ['Спутник', 'Как читать снимок и NDVI', 'NDVI сам по себе не показывает долю растительности'],
    ]) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        const guide = page.getByText('Как это работает', { exact: true })
        const heading = page.getByRole('heading', { name: title, exact: true })
        await expect(heading).not.toBeVisible()
        await guide.focus(); await page.keyboard.press('Enter')
        await expect(heading).toBeVisible()
        await expect(page.getByText(explanation, { exact: tab === 'Воздух' })).toBeVisible()
        await expect(page.locator('.pa-guide figure')).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await page.keyboard.press('Space')
        await expect(heading).not.toBeVisible()
    }
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    expect(calls).toHaveLength(3)
})

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
    await expect(page.getByRole('heading', { name: 'Сначала выберите место', exact: true })).toBeVisible()
    await expect(page.locator('.pa-map-marker, .pa-map-station')).toHaveCount(0)
    await choosePoint(page)
    await expect(page.getByRole('heading', { name: 'Анализ выбранного места', exact: true })).toBeVisible()
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    await expect(card(page, 'air').getByRole('status')).toHaveText('Загрузка…')
    await expect.poll(() => calls.length).toBe(3)
    expect(calls.every(r => r.place.kind === 'point' && !('address_id' in r.place))).toBe(true)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getSource('pa-radius')?.serialize().data)).toEqual({ type: 'Feature', properties: {}, geometry: firstResponse.analysis_area })
    await expect(page.locator('.pa-map-station')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getStyle().layers.some(layer => layer.type === 'raster' && layer.id.startsWith('pa-satellite-')))).toBe(false)
    await expect.poll(() => page.evaluate(() => Object.keys(window.__smokeMapIn('.pa-map')?.getStyle().sources ?? {}).some(id => id.startsWith('pa-satellite-')))).toBe(false)
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
    await expect(page.getByLabel('Дата снимка').locator('option:checked')).toHaveText('Выберите дату')
    await expect(card(page, 'satellite')).toHaveCount(0)
    await page.getByLabel('Дата снимка', { exact: true }).selectOption('2024-05-07')
    await expect(page.getByText('Загрузка спутниковых данных…')).toBeVisible()
    await expect.poll(() => calls.length).toBe(4)
    expect(calls[3].blocks).toEqual(['satellite']); expect(calls[3].date).toBe('2024-05-07')
    await fixture(routes[3], { satellite: 'READY' })
    await expect(page.locator('[data-satellite-coverage]')).toBeVisible()
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

const source = 'air.krasn.ru/project/9'
const historyPath = (version, id) => `/api/v1/air/snapshots/${version}/stations/${id}/history`
const hour = n => `2026-08-09 0${n}:00:00`
function airFixture(version = airSnapshot.snapshot_version, firstValue = 0) {
    const metadata = { ...airSnapshot, snapshot_version: version, last_observed_at_raw: hour(3),
        window_raw: { begin_inclusive: hour(0), end_exclusive: hour(4) } }
    const values = [[firstValue, null, undefined, 12], [undefined, 42, undefined, undefined]]
    const histories = values.map((readings, index) => ({
        ...metadata, station_id: String(1001 + index), source,
        rows: readings.map((value, i) => ({
            observed_at_raw: hour(i), observed_at_utc: null, value: value ?? null, row_present: value !== undefined,
            missing_reason: value === undefined ? 'SOURCE_ROW_MISSING' : value === null ? 'SOURCE_VALUE_NULL_OR_ABSENT' : null,
            qc: 'UNKNOWN', qc_reason: value === undefined ? 'SOURCE_ROW_MISSING' : 'SOURCE_QC_NOT_PROVIDED',
        })),
    }))
    const stations = histories.map(({ station_id: id, rows }, index) => {
        const present = rows.filter(row => row.row_present)
        const latest = present.at(-1)
        return {
            id, name: index === 0 ? 'Станция Альфа' : 'Станция Бета', source, status: 'UNKNOWN',
            lon: null, lat: null, crs: null, distance_m: null, coordinate_reason: 'SOURCE_DATUM_CRS_UNCONFIRMED',
            selected: false, group: 'unlocated', latest,
            history: { status: 'AVAILABLE', reason: null, first_observed_at_raw: present[0].observed_at_raw,
                last_observed_at_raw: latest.observed_at_raw, row_count: present.length,
                null_values: present.filter(row => row.value === null).length, missing_hour_bins: rows.length - present.length },
        }
    })
    return { summary: { ...metadata, stations, counts: { selected: 0, unlocated: stations.length }, missing_selected_ids: [] }, histories }
}

function analysisWithAir(request, summary) {
    const response = responseFor(request, { poi: 'READY', air: 'READY', satellite: 'READY' })
    if (response.blocks.air) response.blocks.air.data = summary
    return response
}

const airTab = page => page.getByRole('tab', { name: 'Воздух', exact: true })
const airSeries = page => page.getByRole('region', { name: 'История PM2.5' })
const stationButton = (page, name) => page.getByRole('button', { name, exact: true })
const stationMarker = (page, id) => page.locator(`.pa-map-station[data-station-id="${id}"]`)
const hourlyValues = page => airSeries(page).getByText('Часовые значения и пропуски')

async function openPointAir(page) {
    await page.goto('/')
    await choosePoint(page)
    await airTab(page).click()
    await expect(page.getByRole('list', { name: 'Станции мониторинга воздуха' })).toBeVisible()
}

test('exact address and keyboard station choice show zero and two distinct gaps', async ({ page }) => {
    const calls = []
    const geo = await geocodingFixtures(page)
    const { summary, histories: [history] } = airFixture()
    let historyCalls = 0
    await page.route(`**${historyPath(history.snapshot_version, history.station_id)}`, route => {
        historyCalls++
        expect(route.request().method()).toBe('GET')
        return route.fulfill({ json: history })
    })
    await page.route('**/api/v1/place-analysis', route => {
        const request = route.request().postDataJSON(); calls.push(request)
        const response = analysisWithAir({ ...request, place: { kind: 'point', ...geo.selected.place.point } }, summary)
        response.analysis_version = 2; response.place = geo.selected.place
        return route.fulfill({ json: response })
    })
    await page.goto('/analysis')
    await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click()
    await geocodingPreview(page)
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect.poll(() => calls.length).toBe(3)
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    expect(calls.every(r => r.place.kind === 'address' && r.analysis_version === 2 && r.place.selection_token === geo.selected.selection_token && !('lon' in r.place))).toBe(true)
    await airTab(page).click()
    const alpha = stationButton(page, 'Станция Альфа')
    await expect(alpha).toHaveAttribute('aria-pressed', 'false')
    expect(historyCalls).toBe(0)
    await expect(page.locator('.pa-map-station')).toHaveCount(0)
    await expect(page.getByText(/ближайшая/i)).toHaveCount(0)
    await page.keyboard.press('Tab')
    await expect(page.locator('.pa-guide summary')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.locator('#pa-load-air')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(alpha).toBeFocused()
    await page.keyboard.press('Space')
    await expect(alpha).toHaveAttribute('aria-pressed', 'true')
    await expect(airSeries(page)).toBeVisible()
    await expect(page.getByText(/Часовой пояс исходных меток и контроль качества неизвестны/)).toBeVisible()
    await expect(page.getByText(`Источник: ${source}`, { exact: true })).toBeVisible()
    await expect(airSeries(page).getByText(`Период наблюдений: ${hour(0)} — ${hour(3)}`, { exact: true })).toBeVisible()
    await expect(page.locator('.pa-chart .pa-bar.is-zero')).toHaveCount(1)
    await expect(page.locator('.pa-chart [data-missing-reason] .pa-bar')).toHaveCount(0)
    const bins = page.locator('.pa-chart__bin')
    for (const [index, label] of ['0 мкг/м³', 'Пустое значение', 'Пропущен час', '12 мкг/м³'].entries()) {
        await bins.nth(index).hover({ position: { x: 5, y: 12 } })
        const reading = page.locator('.pa-chart__reading')
        await expect(reading.locator('time')).toHaveText(hour(index))
        await expect(reading.locator('strong')).toHaveText(label)
    }
    await hourlyValues(page).click()
    const cells = time => airSeries(page).getByRole('row', { name: new RegExp(time) }).getByRole('cell')
    await expect(cells(hour(0))).toHaveText([hour(0), '0'])
    await expect(cells(hour(1))).toHaveText([hour(1), 'Пустое значение'])
    await expect(cells(hour(2))).toHaveText([hour(2), 'Пропущен час'])
    expect(calls).toHaveLength(3)
    expect(historyCalls).toBe(1)
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
})

async function ignoreHistoryAbort(page) {
    await page.addInitScript(() => {
        const original = window.fetch.bind(window)
        window.fetch = async (input, options) => {
            if (typeof input !== 'string' || !input.startsWith('/api/v1/air/snapshots/')) return original(input, options)
            const response = await original(input, { ...options, signal: undefined })
            const json = response.json.bind(response)
            response.json = async () => {
                const body = await json()
                setTimeout(() => { document.documentElement.dataset.lastHistoryBody = input }, 0)
                return body
            }
            return response
        }
    })
}

test('late station response cannot replace the chosen station', async ({ page }) => {
    const { summary, histories: [alpha, beta] } = airFixture()
    Object.assign(summary.stations[1], {
        lon: 92.91, lat: 56.023, crs: 'EPSG:4326', coordinate_reason: 'A11_OPERATOR_MAP_INTERPRETATION',
        coordinate_provenance: { raw_file: 'raw/air-project9-api.json', source_id: beta.station_id },
    })
    await ignoreHistoryAbort(page)
    let delayed
    const alphaPath = historyPath(alpha.snapshot_version, alpha.station_id)
    await page.route(`**${alphaPath}`, route => { delayed = route })
    await page.route(`**${historyPath(beta.snapshot_version, beta.station_id)}`, route => route.fulfill({ json: beta }))
    await page.route('**/api/v1/place-analysis', route => route.fulfill({ json: analysisWithAir(route.request().postDataJSON(), summary) }))
    await openPointAir(page)
    await expect(page.locator('.pa-map-station')).toHaveCount(1)
    await expect(stationMarker(page, alpha.station_id)).toHaveCount(0)
    await stationButton(page, 'Станция Альфа').click()
    await expect.poll(() => !!delayed).toBe(true)
    await stationButton(page, 'Станция Бета').click()
    await expect(airSeries(page).getByText(`Период наблюдений: ${hour(1)}`, { exact: true })).toBeVisible()
    await hourlyValues(page).click()
    await expect(airSeries(page).getByRole('cell', { name: '42', exact: true })).toBeVisible()
    await delayed.fulfill({ json: alpha })
    await expect(page.locator('html')).toHaveAttribute('data-last-history-body', alphaPath)
    await expect(stationButton(page, 'Станция Бета')).toHaveAttribute('aria-pressed', 'true')
    await expect(stationMarker(page, beta.station_id)).toHaveAttribute('aria-pressed', 'true')
    await expect(airSeries(page).getByRole('cell', { name: '42', exact: true })).toBeVisible()
})

test('only an explicit station choice fits the circle and docking keeps the loaded chart', async ({ page }, testInfo) => {
    const { summary, histories } = airFixture()
    const [first, second] = [[92.91, 56.023], [92.79, 56.025]]
    const unlocated = { ...summary.stations[0], id: '1003', name: 'Станция без координат' }
    summary.stations.push(unlocated)
    summary.counts.unlocated = 3
    for (const [index, location] of [first, second].entries()) {
        const station = summary.stations[index]
        Object.assign(station, { lon: location[0], lat: location[1], crs: 'EPSG:4326', distance_m: index ? 4400 : 3500,
            coordinate_reason: 'A11_OPERATOR_MAP_INTERPRETATION',
            coordinate_provenance: { raw_file: 'raw/air-project9-api.json', source_id: station.id } })
    }
    histories.push({ ...histories[0], station_id: unlocated.id })
    const historyRequests = []
    for (const history of histories) {
        await page.route(`**${historyPath(history.snapshot_version, history.station_id)}`, route => {
            historyRequests.push(history.station_id)
            return route.fulfill({ json: history })
        })
    }
    let airRoute, circle
    await page.route('**/api/v1/place-analysis', route => {
        const request = route.request().postDataJSON()
        const response = analysisWithAir(request, summary)
        circle = response.analysis_bounds
        if (request.blocks[0] === 'air') { airRoute = route; return }
        return route.fulfill({ json: response })
    })
    await page.goto('/')
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        const original = map.fitBounds.bind(map)
        map.fitBounds = (bounds, options) => {
            window.lastFit = bounds.toArray().flat()
            return original(bounds, options)
        }
    })
    const fit = () => page.evaluate(() => window.lastFit)
    const camera = () => page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        return [...map.getCenter().toArray(), map.getZoom()]
    })
    const mapHeight = () => page.locator('.pa-map').evaluate(element => element.clientHeight)
    await choosePoint(page)
    await expect.poll(() => fit()).toEqual(circle)
    const initialCamera = await camera()
    await expect.poll(() => !!airRoute).toBe(true)
    await airRoute.fulfill({ json: analysisWithAir(airRoute.request().postDataJSON(), summary) })
    await expect(page.locator('.pa-map-station')).toHaveCount(2)
    expect(await camera()).toEqual(initialCamera)
    const toggleStations = page.locator('[data-layer-key="stations"] input[type=checkbox]')
    await toggleStations.uncheck()
    await expect(page.locator('.pa-map-station')).toHaveCount(0)
    await toggleStations.check()
    await expect(page.locator('.pa-map-station')).toHaveCount(2)
    expect(await camera()).toEqual(initialCamera)

    await airTab(page).click()
    await expect(page.locator('.pa-station small')).toHaveText(['3,5 км по прямой', '4,4 км по прямой', 'Расстояние неизвестно'])
    await stationButton(page, 'Станция Альфа').click()
    await expect.poll(() => fit()).toEqual([circle[0], circle[1], first[0], first[1]])
    await expect(airSeries(page)).toBeVisible()
    await stationButton(page, 'Станция Бета').click()
    const secondFit = [second[0], circle[1], circle[2], second[1]]
    await expect.poll(() => fit()).toEqual(secondFit)
    await expect(airSeries(page)).toBeVisible()

    const height = await mapHeight()
    await page.getByRole('button', { name: 'Открыть график внизу' }).click()
    const dock = page.locator('#pa-air-dock')
    await expect(dock.locator('.pa-history')).toBeVisible()
    await dock.locator('.pa-chart__bin').nth(1).hover({ position: { x: 5, y: 12 } })
    await expect(dock.locator('.pa-chart__reading strong')).toHaveText('42 мкг/м³')
    await expect(page.locator('#pa-panel .pa-history')).toHaveCount(0)
    await expect(stationButton(page, 'Станция Бета')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Вернуть в боковую панель' })).toBeFocused()
    expect(historyRequests).toEqual(['1001', '1002'])
    const divider = page.getByRole('separator', { name: 'Ширина панели анализа' })
    if (testInfo.project.name.includes('desktop')) {
        await expect.poll(mapHeight).toBeLessThan(height)
        const initialWidth = Number(await divider.getAttribute('aria-valuenow'))
        await divider.press('ArrowRight')
        await expect(divider).toHaveAttribute('aria-valuenow', String(initialWidth + 16))
        await divider.press('Home')
        await expect(divider).toHaveAttribute('aria-valuenow', '320')
        const box = await divider.boundingBox()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 4 })
        await page.mouse.up()
        await expect(divider).toHaveAttribute('aria-valuenow', '410')
    } else {
        await expect(divider).toHaveCount(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await expect.poll(() => fit()).toEqual(secondFit)
    await expect.poll(() => page.evaluate(([bounds, station]) => {
        const map = window.__smokeMapIn('.pa-map')
        const canvas = map.getCanvas().getBoundingClientRect()
        const layers = document.querySelector('.pa-layers').getBoundingClientRect()
        const [west, south, east, north] = bounds
        return [[west, south], [east, north], station].every(point => {
            const p = map.project(point)
            const x = canvas.left + p.x, y = canvas.top + p.y
            return p.x >= 12 && p.x <= canvas.width - 12 && p.y >= 12 && p.y <= canvas.height - 12
                && (x < layers.left || x > layers.right || y < layers.top || y > layers.bottom)
        })
    }, [circle, second])).toBe(true)
    await page.getByRole('button', { name: 'Вернуть в боковую панель' }).click()
    await expect(page.locator('#pa-panel .pa-history')).toBeVisible()
    await expect(dock).toBeHidden()
    await expect(page.getByRole('button', { name: 'Открыть график внизу' })).toBeFocused()
    expect(historyRequests).toEqual(['1001', '1002'])

    await expect.poll(mapHeight).toBe(height)
    const selectedCamera = await camera()
    await stationButton(page, 'Станция без координат').click()
    await expect(airSeries(page)).toBeVisible()
    expect(await camera()).toEqual(selectedCamera)
    expect(historyRequests).toEqual(['1001', '1002', '1003'])
})

test('late old version cannot replace history after a summary refresh', async ({ page }) => {
    const old = airFixture(), next = airFixture('a'.repeat(64), 18)
    const alphaPath = historyPath(old.summary.snapshot_version, '1001')
    let delayed, current = old
    await ignoreHistoryAbort(page)
    await page.route(`**${alphaPath}`, route => { delayed = route })
    await page.route(`**${historyPath(next.summary.snapshot_version, '1001')}`, route => route.fulfill({ json: next.histories[0] }))
    await page.route('**/api/v1/place-analysis', route => route.fulfill({ json: analysisWithAir(route.request().postDataJSON(), current.summary) }))
    await openPointAir(page)
    await stationButton(page, 'Станция Альфа').click()
    await expect.poll(() => !!delayed).toBe(true)
    current = next
    await page.locator('#pa-load-air').click()
    await expect(airSeries(page)).toBeVisible()
    await hourlyValues(page).click()
    await expect(airSeries(page).getByRole('cell', { name: '18', exact: true })).toBeVisible()
    await delayed.fulfill({ json: old.histories[0] })
    await expect(page.locator('html')).toHaveAttribute('data-last-history-body', alphaPath)
    await expect(airSeries(page).getByRole('cell', { name: '18', exact: true })).toBeVisible()
})

test('409 refreshes only the summary and a history failure retries only the GET', async ({ page }) => {
    const old = airFixture(), next = airFixture('a'.repeat(64), 18)
    const calls = []
    let current = old, newHistoryCalls = 0
    await page.route(`**${historyPath(old.summary.snapshot_version, '1001')}`, route => route.fulfill({
        status: 409, json: { code: 'AIR_SNAPSHOT_CHANGED' },
    }))
    await page.route(`**${historyPath(next.summary.snapshot_version, '1001')}`, route => ++newHistoryCalls === 1
        ? route.fulfill({ status: 503, json: { code: 'AIR_SOURCE_UNAVAILABLE' } })
        : route.fulfill({ json: next.histories[0] }))
    await page.route('**/api/v1/place-analysis', route => {
        const request = route.request().postDataJSON()
        calls.push(request.blocks[0])
        return route.fulfill({ json: analysisWithAir(request, current.summary) })
    })
    await openPointAir(page)
    await page.getByRole('tab', { name: 'Спутник', exact: true }).click()
    await page.getByLabel('Дата снимка', { exact: true }).selectOption('2024-05-07')
    await expect(page.locator('[data-satellite-coverage]')).toBeVisible()
    await airTab(page).click()
    await stationButton(page, 'Станция Альфа').click()
    const summaryButton = stationButton(page, 'Обновить')
    await expect(summaryButton).toBeVisible()
    await expect(airSeries(page)).toHaveCount(0)
    current = next
    await summaryButton.click()
    const retry = stationButton(page, 'Повторить загрузку истории')
    await expect(retry).toBeVisible()
    expect(calls).toHaveLength(5)
    expect(calls[4]).toBe('air')
    await retry.click()
    await expect(airSeries(page)).toBeVisible()
    expect(newHistoryCalls).toBe(2)
    expect(calls).toHaveLength(5)
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    await expect(card(page, 'satellite').getByRole('status')).toHaveText('Наблюдение готово')
})

test('short mobile screen can scroll through the graph and hourly values', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 500 })
    const { summary, histories: [history] } = airFixture()
    await page.route(`**${historyPath(history.snapshot_version, history.station_id)}`, route => route.fulfill({ json: history }))
    await page.route('**/api/v1/place-analysis', route => route.fulfill({ json: analysisWithAir(route.request().postDataJSON(), summary) }))
    await openPointAir(page)
    await stationButton(page, 'Станция Альфа').click()
    await expect(page.locator('.pa-chart')).toBeVisible()
    const values = hourlyValues(page)
    await values.scrollIntoViewIfNeeded()
    await values.click()
    const last = airSeries(page).getByRole('cell', { name: '12', exact: true })
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    const horizontalOverflow = await page.locator('.pa-panel__scroll').evaluate(panel =>
        panel.scrollWidth > panel.clientWidth || document.documentElement.scrollWidth > window.innerWidth)
    expect(horizontalOverflow).toBe(false)
})

test('pinned A11 map and list open the same station weeks', async ({ page }) => {
    const directory = process.env.AIR_API_TEST_EXCHANGE
    test.skip(!directory, 'Requires captured PHP fixture exchange')
    const { summary, histories } = JSON.parse(readFileSync(`${directory}/a11.json`, 'utf8'))
    const air = summary.blocks.air.data
    // The API fixture request includes a selected station; the UI summary request starts without a selection.
    const data = { ...air, stations: air.stations.map(station => ({ ...station, selected: false, group: 'unlocated' })),
        counts: { selected: 0, unlocated: air.stations.length }, missing_selected_ids: [] }
    const positions = { '3846': [92.910795, 56.024966], '3858': [92.97329, 56.01204], '4228': [92.943622, 56.022003] }
    const requests = [], historyRequests = []
    let bounds
    const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    await page.route('**/api/v1/satellite/**/*.png', route => route.fulfill({ contentType: 'image/png', body: tile }))
    await page.route('**/api/v1/place-analysis', route => {
        const request = route.request().postDataJSON()
        requests.push(request.blocks[0])
        const response = analysisWithAir(request, data)
        bounds = response.analysis_bounds
        return route.fulfill({ json: response })
    })
    for (const history of histories) {
        await page.route(`**${historyPath(history.snapshot_version, history.station_id)}`, route => {
            historyRequests.push(new URL(route.request().url()).pathname)
            return route.fulfill({ json: history })
        })
    }

    await page.goto('/analysis'); await choosePoint(page)
    await page.getByRole('tab', { name: 'Спутник', exact: true }).click()
    await page.getByLabel('Дата снимка', { exact: true }).selectOption('2024-05-07')
    await expect(page.locator('[data-satellite-coverage]')).toBeVisible()
    await expect(page.locator('.pa-map-station')).toHaveCount(3)
    expect(positions['3858'][0]).toBeGreaterThan(bounds[2])
    for (const history of histories) {
        const id = history.station_id
        const marker = stationMarker(page, id)
        await airTab(page).click()
        await stationButton(page, data.stations.find(station => station.id === id).name).click()
        await expect.poll(() => marker.evaluate((element, coords) => {
            const map = window.__smokeMapIn('.pa-map')
            const point = map.project(coords)
            const canvas = map.getCanvas().getBoundingClientRect()
            const box = element.getBoundingClientRect()
            return Math.hypot(box.x + box.width / 2 - canvas.x - point.x, box.y + box.height / 2 - canvas.y - point.y)
        }, positions[id])).toBeLessThan(2)
        await marker.click()
        await expect(airTab(page)).toHaveAttribute('aria-selected', 'true')
        await expect(marker).toHaveAttribute('aria-pressed', 'true')
        await expect(stationButton(page, data.stations.find(station => station.id === id).name)).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('.pa-chart .pa-chart__bin')).toHaveCount(168)
        expect(historyRequests.at(-1)).toBe(historyPath(air.snapshot_version, id))
    }

    const history = histories[0]
    const station = data.stations.find(item => item.id === history.station_id)
    await stationButton(page, station.name).click()
    await expect(stationMarker(page, station.id)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Местоположение по данным источника', { exact: true })).toBeVisible()
    await expect(airSeries(page).getByText('Период наблюдений: 2026-08-09 00:00:00 — 2026-08-15 23:00:00', { exact: true })).toBeVisible()
    await expect(page.locator('.pa-chart .pa-chart__bin')).toHaveCount(168)
    await hourlyValues(page).click()
    const zero = history.rows.find(row => row.value === 0)
    await expect(airSeries(page).getByRole('row', { name: new RegExp(zero.observed_at_raw) }).getByRole('cell'))
        .toHaveText([zero.observed_at_raw, '0'])
    expect(historyRequests).toEqual([...histories, history].map(row => historyPath(air.snapshot_version, row.station_id)))
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    await expect(card(page, 'satellite').getByRole('status')).toHaveText('Наблюдение готово')
    expect(requests.sort()).toEqual(['air', 'poi', 'satellite', 'satellite'])
})
