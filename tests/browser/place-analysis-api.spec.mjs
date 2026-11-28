import { openMapLayers } from './support/map-controls.mjs'
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

test('satellite opacity and POI category filters leave independent map markers in place', async ({ page }) => {
    const { summary } = airFixture()
    const station = summary.stations[0]
    Object.assign(station, {
        lon: 92.85, lat: 56.01, crs: 'EPSG:4326', distance_m: 0,
        coordinate_reason: 'A11_OPERATOR_MAP_INTERPRETATION',
        coordinate_provenance: { raw_file: 'raw/air-project9-api.json', source_id: station.id },
    })
    await page.route('**/api/v1/place-analysis', route =>
        route.fulfill({ json: analysisWithAir(route.request().postDataJSON(), summary) }))
    await page.goto('/analysis')
    await choosePoint(page)

    const poi = page.locator('.pa-map-marker[data-poi-id="osm:node:1"]')
    const stationMarker = page.locator('.pa-map-station')
    await expect(poi).toHaveCount(1)
    await expect(stationMarker).toHaveCount(1)
    await poi.evaluate(element => { element.dataset.markerProbe = 'poi' })
    await stationMarker.evaluate(element => { element.dataset.markerProbe = 'station' })

    await openMapLayers(page)
    await page.getByLabel('Непрозрачность спутникового слоя').press('ArrowLeft')
    await expect(page.locator('.pa-opacity output')).toHaveText('65%')
    await expect(poi).toHaveAttribute('data-marker-probe', 'poi')
    await expect(stationMarker).toHaveAttribute('data-marker-probe', 'station')

    await page.getByRole('tab', { name: 'Объекты', exact: true }).press('Enter')
    await page.getByRole('button', { name: 'Аптеки (1)', exact: true }).press('Enter')
    await expect(poi).toHaveCount(1)
    await expect(stationMarker).toHaveAttribute('data-marker-probe', 'station')
    await poi.press('Enter')
    await expect(page.locator('.pa-objects [data-poi-id="osm:node:1"] > button')).toHaveAttribute('aria-pressed', 'true')
})

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
        ['Воздух', 'Как читать график PM2,5', 'Почему станция может быть только в списке?'],
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
    await page.getByRole('tab', { name: 'Снимки и NDVI', exact: true }).click()
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
    const applyRadius = page.getByRole('button', { name: 'Пересчитать для 1000 м', exact: true })
    await expect(applyRadius).toBeVisible()
    await expect(page.locator('.pa-map-marker')).toHaveCount(1)
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    await expect(page.locator('.pa-map-radius-label')).toHaveText('R = 500 м · предыдущий')
    await expect(page.getByText('На карте прежний контур · 500 м', { exact: true })).toBeVisible()
    await page.waitForTimeout(450) // The old debounce would already have sent a request.
    expect(calls).toHaveLength(4)
    await applyRadius.click()
    await expect(page.locator('.pa-map-marker')).toHaveCount(0)
    await expect(page.locator('.pa-map-radius-label')).toHaveText('R = 500 м · предыдущий')
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
        await expect(page.getByText('PM2,5 18,6', { exact: false })).toHaveCount(0)
    }
    await expect(page.getByText('Данные о станциях и наблюдениях пока недоступны.')).toBeVisible()
    await expect(page.getByText('Synthetic air provider unavailable')).toHaveCount(0)
})

const source = 'air.krasn.ru/project/9'
const historyPath = (version, id) => `/api/v1/air/snapshots/${version}/stations/${id}/history`
const hour = n => new Date(Date.UTC(2026, 7, 9, n)).toISOString().slice(0, 19).replace('T', ' ')
const displayedHour = n => {
    const [date, time] = hour(n).split(' ')
    return `${date.split('-').reverse().join('.')}, ${time.slice(0, 5)}`
}
function airFixture(version = airSnapshot.snapshot_version, firstValue = 0,
    values = [[firstValue, null, undefined, 12], [undefined, 42, undefined, undefined]]) {
    const lastRow = Math.max(...values.map(readings => readings.findLastIndex(value => value !== undefined)))
    const metadata = { ...airSnapshot, snapshot_version: version, last_observed_at_raw: hour(lastRow),
        window_raw: { begin_inclusive: hour(0), end_exclusive: hour(values[0].length) } }
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
const airSeries = page => page.getByRole('region', { name: 'История PM2,5' })
const stationButton = (page, name) => page.getByRole('button', { name, exact: true })
const stationMarker = (page, id) => page.locator(`.pa-map-station[data-station-id="${id}"]`)
const airRange = page => airSeries(page).getByRole('combobox', { name: 'Период графика PM2,5' })
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
    const sourceLink = page.getByRole('link', { name: source, exact: true })
    await expect(sourceLink).toBeVisible()
    await expect(sourceLink).toHaveAttribute('href', 'https://air.krasn.ru/')
    await expect(sourceLink).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(airSeries(page).getByText('Архив: 09.08.2026', { exact: true })).toBeVisible()
    const latest = airSeries(page).locator('.pa-air-latest')
    await expect(latest.locator('strong')).toHaveText('12 мкг/м³')
    await expect(latest.locator('time')).toHaveAttribute('datetime', hour(3).replace(' ', 'T'))
    await expect(latest.locator('time')).toContainText(displayedHour(3))
    const published = airSeries(page).locator('.pa-air-meta time')
    await expect(published).toHaveAttribute('datetime', history.last_success_at)
    await expect(published).toHaveText('04.11.2026, 07:00 (Красноярск)')
    await expect(published).toHaveAttribute('title', '04.11.2026, 00:00 UTC')
    await expect(page.locator('.pa-chart .pa-bar.is-zero')).toHaveCount(1)
    await expect(page.locator('.pa-chart [data-missing-reason] .pa-bar')).toHaveCount(0)
    const bins = page.locator('.pa-chart__bin')
    for (const [index, label] of ['0 мкг/м³', 'Пустое значение', 'Пропущен час', '12 мкг/м³'].entries()) {
        await bins.nth(index).hover({ position: { x: 5, y: 12 } })
        const reading = page.locator('.pa-chart__reading')
        await expect(reading.locator('time')).toHaveText(displayedHour(index))
        await expect(reading.locator('strong')).toHaveText(label)
    }
    await hourlyValues(page).click()
    for (const [index, value] of ['0', 'Пустое значение', 'Пропущен час'].entries()) {
        const time = displayedHour(index)
        const row = airSeries(page).getByRole('row').filter({ has: page.getByRole('cell', { name: time, exact: true }) })
        await expect(row.getByRole('cell')).toHaveText([time, value])
    }
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
    await expect(airSeries(page).locator('.pa-air-latest time')).toHaveAttribute('datetime', hour(1).replace(' ', 'T'))
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
            const result = original(bounds, options)
            const canvas = map.getCanvas()
            window.lastFit = {
                bounds: bounds.toArray().flat(),
                size: { width: canvas.clientWidth, height: canvas.clientHeight },
            }
            return result
        }
    })
    const fit = () => page.evaluate(() => window.lastFit?.bounds)
    const fittedSize = () => page.evaluate(() => window.lastFit?.size)
    const camera = () => page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        return [...map.getCenter().toArray(), map.getZoom()]
    })
    const viewport = page.locator('.pa-map')
    const mapHeight = () => viewport.evaluate(element => element.clientHeight)
    await choosePoint(page)
    await expect.poll(() => fit()).toEqual(circle)
    const initialCamera = await camera()
    await expect.poll(() => !!airRoute).toBe(true)
    await airRoute.fulfill({ json: analysisWithAir(airRoute.request().postDataJSON(), summary) })
    await expect(page.locator('.pa-map-station')).toHaveCount(2)
    expect(await camera()).toEqual(initialCamera)
    await openMapLayers(page)
    const toggleStations = page.locator('[data-layer-key="stations"] input[type=checkbox]')
    await toggleStations.uncheck()
    await expect(page.locator('.pa-map-station')).toHaveCount(0)
    await toggleStations.check()
    await expect(page.locator('.pa-map-station')).toHaveCount(2)
    const mobileControls = page.locator('.pa-map-settings-toggle')
    if (await mobileControls.isVisible()) await mobileControls.click()
    expect(await camera()).toEqual(initialCamera)

    await airTab(page).click()
    await expect(page.locator('.pa-station small')).toHaveText(['3,5 км по прямой', '4,4 км по прямой', 'Расстояние неизвестно'])
    await stationButton(page, 'Станция Альфа').click()
    await expect.poll(() => fit()).toEqual([circle[0], circle[1], first[0], first[1]])
    await expect(page.locator('#pa-panel [data-station-distance]')).toHaveText('· 3,5 км от выбранной точки')
    await expect(airSeries(page)).toBeVisible()
    await stationButton(page, 'Станция Бета').click()
    await expect(page.locator('.pa-map-station.is-selected .pa-map-station__name')).toHaveText('Станция Бета')
    const secondFit = [second[0], circle[1], circle[2], second[1]]
    await expect.poll(() => fit()).toEqual(secondFit)
    await expect(airSeries(page)).toBeVisible()

    const height = await mapHeight()
    await page.getByRole('button', { name: 'Открыть график внизу' }).click()
    const dock = page.locator('#pa-air-dock')
    await expect(dock.locator('.pa-history')).toBeVisible()
    await expect(dock.locator('[data-station-distance]')).toHaveText('· 4,4 км от выбранной точки')
    const plot = dock.locator('.pa-chart__plot')
    await expect(plot).toBeInViewport({ ratio: 0.99 })
    expect(await dock.evaluate(element => {
        const header = element.querySelector('.pa-station-detail__header').getBoundingClientRect()
        const scrollArea = element.querySelector('.pa-station-detail__body').getBoundingClientRect()
        return header.bottom <= scrollArea.top
    })).toBe(true)
    await dock.locator('.pa-chart__bin').nth(1).hover({ position: { x: 5, y: 12 } })
    await expect(dock.locator('.pa-chart__reading strong')).toHaveText('42 мкг/м³')
    const bars = dock.locator('.pa-chart__bars')
    const plotBounds = await bars.boundingBox()
    for (const [x, y] of [[plotBounds.x + 3, plotBounds.y + 3], [
        plotBounds.x + plotBounds.width - 3, plotBounds.y + plotBounds.height - 3,
    ]]) {
        await page.mouse.move(x, y)
        const reading = dock.locator('.pa-chart__reading')
        await expect(reading).toBeVisible()
        const tip = await reading.boundingBox()
        expect(tip.x).toBeGreaterThanOrEqual(plotBounds.x - 1)
        expect(tip.y).toBeGreaterThanOrEqual(plotBounds.y - 1)
        expect(tip.x + tip.width).toBeLessThanOrEqual(plotBounds.x + plotBounds.width + 1)
        expect(tip.y + tip.height).toBeLessThanOrEqual(plotBounds.y + plotBounds.height + 1)
        expect(Math.min(Math.abs(tip.x - x), Math.abs(tip.x + tip.width - x))).toBeLessThan(11)
        expect(Math.min(Math.abs(tip.y - y), Math.abs(tip.y + tip.height - y))).toBeLessThan(11)
    }
    await expect(page.locator('#pa-panel .pa-history')).toHaveCount(0)
    await expect(stationButton(page, 'Станция Бета')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Вернуть в боковую панель' })).toBeFocused()
    expect(historyRequests).toEqual(['1001', '1002'])
    const dockDivider = page.getByRole('separator', { name: 'Высота панели графика' })
    const initialDockHeight = Number(await dockDivider.getAttribute('aria-valuenow'))
    const initialPlotHeight = await plot.evaluate(element => element.clientHeight)
    await dockDivider.press('ArrowDown')
    await expect(dockDivider).toHaveAttribute('aria-valuenow', String(initialDockHeight - 16))
    await expect.poll(() => plot.evaluate(element => element.clientHeight)).toBeLessThan(initialPlotHeight)
    await dockDivider.press('Home')
    await expect(dockDivider).toHaveAttribute('aria-valuenow', await dockDivider.getAttribute('aria-valuemin'))
    await dockDivider.press('End')
    await expect(dockDivider).toHaveAttribute('aria-valuenow', await dockDivider.getAttribute('aria-valuemax'))
    const dockMax = Number(await dockDivider.getAttribute('aria-valuenow'))
    const dockMin = Number(await dockDivider.getAttribute('aria-valuemin'))
    const dragTarget = Math.max(dockMin, Math.min(initialDockHeight, dockMax - 32))
    await dockDivider.scrollIntoViewIfNeeded()
    const dockHandle = await dockDivider.boundingBox()
    const startX = dockHandle.x + dockHandle.width / 2
    const startY = dockHandle.y + dockHandle.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    const direction = testInfo.project.name.includes('desktop') ? 1 : -1
    await page.mouse.move(startX, startY + (dockMax - dragTarget) * direction, { steps: 4 })
    await page.mouse.up()
    await expect(dockDivider).toHaveAttribute('aria-valuenow', String(dragTarget))
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
    const contextFits = () => page.evaluate(([bounds, station]) => {
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
    }, [circle, second])
    await expect.poll(contextFits).toBe(true)
    await page.getByRole('button', { name: 'Вернуть в боковую панель' }).click()
    await expect(page.locator('#pa-panel .pa-history')).toBeVisible()
    await expect(dock).toBeHidden()
    await expect(page.getByRole('button', { name: 'Открыть график внизу' })).toBeFocused()
    expect(historyRequests).toEqual(['1001', '1002'])

    await expect.poll(mapHeight).toBe(height)
    const restoredWidth = await viewport.evaluate(element => element.clientWidth)
    // The container can reach its final size before ResizeObserver resizes and refits the map.
    await expect.poll(fittedSize).toEqual({ width: restoredWidth, height })
    expect(await fit()).toEqual(secondFit)
    await expect.poll(contextFits).toBe(true)
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
    await page.getByRole('tab', { name: 'Снимки и NDVI', exact: true }).click()
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

test.describe('one hour for all stations', () => {
    test.use({ hasTouch: true })

    test('mouse, keyboard and touch share one hour and keep the map and analysis state', async ({ page }, testInfo) => {
        if (testInfo.project.name === 'phone-320') await page.setViewportSize({ width: 320, height: 500 })
        const old = airFixture(airSnapshot.snapshot_version, 0, [[0, 91, undefined, 12], [undefined, 42, null, undefined], [7, 8, 9, 10]])
        const next = airFixture('a'.repeat(64), 18, [[18, 13, 14, 88], [8, 42, null, 23], [7, 8, 9, 11]])
        let current = old, delayed, newHourAttempts = 0
        const analysisCalls = [], hourCalls = []
        for (const fixture of [old, next]) {
            fixture.summary.stations[2].name = 'Станция без координат'
            for (const [index, station] of fixture.summary.stations.slice(0, 2).entries()) {
                Object.assign(station, { lon: 92.90 + index * 0.007, lat: 56.024, crs: 'EPSG:4326',
                    coordinate_reason: 'A11_OPERATOR_MAP_INTERPRETATION',
                    coordinate_provenance: { raw_file: 'raw/air-project9-api.json', source_id: station.id } })
            }
            for (const history of fixture.histories) {
                await page.route(`**${historyPath(history.snapshot_version, history.station_id)}`, route => route.fulfill({ json: history }))
            }
        }
        const hourPayload = (fixture, index) => {
            const { stations, counts, missing_selected_ids, ...metadata } = fixture.summary
            return { ...metadata, observed_at_raw: hour(index), source,
                rows: fixture.histories.map(history => ({ ...history.rows[index], station_id: history.station_id })) }
        }
        await ignoreHistoryAbort(page)
        await page.route('**/api/v1/air/snapshots/*/hour?*', route => {
            const url = new URL(route.request().url())
            const version = url.pathname.split('/')[5]
            const index = [0, 1, 2, 3].find(i => hour(i) === url.searchParams.get('observed_at_raw'))
            hourCalls.push([version, index])
            if (version === old.summary.snapshot_version && index === 1) { delayed = route; return }
            if (version === old.summary.snapshot_version && index === 3) {
                return route.fulfill({ status: 409, json: { code: 'AIR_SNAPSHOT_CHANGED' } })
            }
            if (version === next.summary.snapshot_version && index === 0 && ++newHourAttempts === 1) {
                return route.fulfill({ status: 503, json: { code: 'AIR_SOURCE_UNAVAILABLE' } })
            }
            return route.fulfill({ json: hourPayload(version === old.summary.snapshot_version ? old : next, index) })
        })
        await page.route('**/api/v1/place-analysis', route => {
            const request = route.request().postDataJSON()
            analysisCalls.push(request)
            return route.fulfill({ json: analysisWithAir(request, current.summary) })
        })
        await page.route('**/api/v1/satellite/**/*.png', route => route.abort())

        await openPointAir(page)
        await page.getByRole('tab', { name: 'Снимки и NDVI', exact: true }).click()
        await page.getByLabel('Дата снимка', { exact: true }).selectOption('2024-05-07')
        await expect(page.locator('[data-satellite-coverage]')).toBeVisible()
        await airTab(page).click()
        await stationButton(page, 'Станция Альфа').click()
        await expect(airSeries(page)).toBeVisible()
        const hourButtons = page.getByRole('group', { name: 'Выбор часа PM2,5' }).getByRole('button')
        const legend = page.getByRole('region', { name: 'Выбранный час PM2,5' })
        const selectedReading = name => stationButton(page, name).locator('.pa-station__hour')
        const markerReading = id => stationMarker(page, id).locator('.pa-map-station__hour')
        const camera = () => page.evaluate(() => {
            const map = window.__smokeMapIn('.pa-map')
            return [...map.getCenter().toArray(), map.getZoom(), ...map.getBounds().toArray().flat()]
                .map(value => Number(value.toFixed(8)))
        })
        await expect(page.locator('.pa-map-station')).toHaveCount(2)
        await page.evaluate(() => {
            const map = window.__smokeMapIn('.pa-map')
            map.setZoom(map.getZoom() - 0.35)
            map.panBy([36, 20], { duration: 0 })
        })
        const originalCamera = await camera()
        const initialAnalysisCalls = analysisCalls.length
        const radius = await page.locator('#pa-radius-number').inputValue()

        await hourButtons.nth(0).hover()
        await expect(page.locator('.pa-chart__reading')).toBeVisible()
        expect(hourCalls).toHaveLength(0)
        await hourButtons.nth(0).click()
        await expect(legend.locator('time')).toHaveText(displayedHour(0))
        await expect(markerReading('1001')).toHaveText('0')
        await expect(stationMarker(page, '1001')).toHaveAccessibleName(/PM2,5 · 0 мкг\/м³/)
        await expect(markerReading('1002')).toHaveText('—')
        await expect(legend).not.toContainText(/часовой пояс неизвестен|∅ пустое значение/)
        await expect(selectedReading('Станция без координат')).toHaveText('7 мкг/м³')
        await expect(stationMarker(page, '1003')).toHaveCount(0)
        const rasterAlert = page.locator('.pa-map-alert')
        await expect(rasterAlert).toBeVisible()
        expect(await page.locator('.pa-map-notices').evaluate(element => {
            const hour = element.querySelector('.pa-air-map-hour').getBoundingClientRect()
            const alert = element.querySelector('.pa-map-alert').getBoundingClientRect()
            return hour.bottom <= alert.top
        })).toBe(true)

        await hourButtons.nth(0).press('ArrowRight')
        await expect(hourButtons.nth(1)).toBeFocused()
        await hourButtons.nth(1).press('Enter')
        await expect.poll(() => !!delayed).toBe(true)
        await expect(legend.getByRole('status')).toHaveText('Загрузка значений за час…')
        await expect(markerReading('1001')).toBeHidden()

        await hourButtons.nth(2).tap()
        await expect(hourButtons.nth(2)).toHaveAttribute('aria-pressed', 'true')
        await expect(legend.locator('time')).toHaveText(displayedHour(2))
        await expect(markerReading('1001')).toHaveText('—')
        await expect(markerReading('1002')).toHaveText('∅')
        await expect(selectedReading('Станция Альфа')).toHaveText('Пропущен час')
        await expect(selectedReading('Станция Бета')).toHaveText('Пустое значение')
        expect(analysisCalls).toHaveLength(initialAnalysisCalls)
        expect(await camera()).toEqual(originalCamera)

        await hourButtons.nth(3).click()
        await expect(legend.getByRole('status')).toContainText('Выпуск изменился')
        expect(analysisCalls).toHaveLength(initialAnalysisCalls)
        current = next
        await stationButton(page, 'Обновить').click()
        await expect(legend.locator('time')).toHaveText(displayedHour(3))
        await expect(markerReading('1001')).toHaveText('88')
        const path = new URL(delayed.request().url())
        await delayed.fulfill({ json: hourPayload(old, 1) })
        await expect(page.locator('html')).toHaveAttribute('data-last-history-body', path.pathname + path.search)
        await expect(markerReading('1001')).toHaveText('88')

        await hourButtons.nth(0).click()
        await expect(legend.getByRole('status')).toHaveText('Не удалось загрузить значения за час.')
        await expect(markerReading('1001')).toBeHidden()
        await legend.getByRole('button', { name: 'Повторить', exact: true }).click()
        await expect(markerReading('1001')).toHaveText('18')
        expect(hourCalls).toEqual([[old.summary.snapshot_version, 0], [old.summary.snapshot_version, 1],
            [old.summary.snapshot_version, 2], [old.summary.snapshot_version, 3], [next.summary.snapshot_version, 3],
            [next.summary.snapshot_version, 0], [next.summary.snapshot_version, 0]])
        expect(analysisCalls).toHaveLength(initialAnalysisCalls + 1)
        expect(analysisCalls.at(-1).blocks).toEqual(['air'])
        expect(analysisCalls.at(-1).place).toEqual(analysisCalls[0].place)
        expect(await page.locator('#pa-radius-number').inputValue()).toBe(radius)
        expect(await camera()).toEqual(originalCamera)

        await legend.getByRole('button', { name: 'Снять выбор часа' }).click()
        await expect(legend).toHaveCount(0)
        await expect(page.locator('.pa-map')).toBeFocused()
        await expect(markerReading('1001')).toBeHidden()
        await page.getByRole('tab', { name: 'Снимки и NDVI', exact: true }).click()
        await expect(page.getByLabel('Дата снимка', { exact: true })).toHaveValue('2024-05-07')
        await expect(page.locator('[data-satellite-coverage]')).toBeVisible()
        await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
        await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    })
})

test('station markers default to the last numeric hour and restore it after a manual choice', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'phone-320') await page.setViewportSize({ width: 320, height: 500 })
    const observed = airFixture(airSnapshot.snapshot_version, 0, [[18.6, 0, null], [7, undefined, null], [null, null, null]])
    const empty = airFixture('a'.repeat(64), 0, [[null, null, null], [null, null, null], [null, null, null]])
    for (const fixture of [observed, empty]) {
        fixture.summary.stations[2].name = 'Станция Гамма'
        for (const [index, station] of fixture.summary.stations.entries()) {
            Object.assign(station, { lon: 92.90 + index * 0.007, lat: 56.024, crs: 'EPSG:4326',
                coordinate_reason: 'A11_OPERATOR_MAP_INTERPRETATION',
                coordinate_provenance: { raw_file: 'raw/air-project9-api.json', source_id: station.id } })
        }
    }
    observed.summary.last_numeric_observed_at_raw = hour(1)
    empty.summary.last_numeric_observed_at_raw = null
    let current = observed, historyCalls = 0
    const hourCalls = []
    await page.route('**/api/v1/place-analysis', route =>
        route.fulfill({ json: analysisWithAir(route.request().postDataJSON(), current.summary) }))
    await page.route(`**${historyPath(observed.summary.snapshot_version, '1001')}`, route => {
        historyCalls++
        return route.fulfill({ json: observed.histories[0] })
    })
    await page.route(`**${historyPath(empty.summary.snapshot_version, '1001')}`, route => route.fulfill({ json: empty.histories[0] }))
    await page.route('**/api/v1/air/snapshots/*/hour?*', route => {
        const url = new URL(route.request().url())
        const version = url.pathname.split('/').at(-2)
        const selected = url.searchParams.get('observed_at_raw')
        hourCalls.push([version, selected])
        expect(version).toBe(observed.summary.snapshot_version)
        const { station_id, rows, ...metadata } = observed.histories[0]
        return route.fulfill({ json: { ...metadata, observed_at_raw: selected,
            rows: observed.histories.map(history => ({
                ...history.rows.find(row => row.observed_at_raw === selected), station_id: history.station_id,
            })),
        } })
    })

    await page.goto('/')
    await choosePoint(page)
    const automatic = page.getByRole('region', { name: 'Последний час PM2,5' })
    await expect(automatic.locator('time')).toHaveText(displayedHour(1))
    const marker = stationMarker(page, '1001')
    await expect(marker).toHaveText('0')
    await expect(marker).toHaveAccessibleName(/PM2,5 · 0 мкг\/м³/)
    await expect(stationMarker(page, '1002')).toHaveText('—')
    await expect(stationMarker(page, '1003')).toHaveText('∅')
    expect(historyCalls).toBe(0)

    await airTab(page).click()
    await expect(stationButton(page, 'Станция Альфа').locator('.pa-station__hour')).toHaveText('0 мкг/м³')
    await expect(stationButton(page, 'Станция Бета').locator('.pa-station__hour')).toHaveText('Пропущен час')
    await expect(stationButton(page, 'Станция Гамма').locator('.pa-station__hour')).toHaveText('Пустое значение')
    await stationButton(page, 'Станция Альфа').click()
    const hours = page.getByRole('group', { name: 'Выбор часа PM2,5' }).getByRole('button')
    await expect(hours.nth(1)).toHaveAttribute('aria-pressed', 'true')
    await hours.first().click()
    const manual = page.getByRole('region', { name: 'Выбранный час PM2,5' })
    await expect(manual.locator('time')).toHaveText(displayedHour(0))
    await expect(marker).toHaveText('18,6')
    await manual.getByRole('button', { name: 'Вернуться к последнему часу' }).click()
    await expect(automatic.locator('time')).toHaveText(displayedHour(1))
    await expect(marker).toHaveText('0')
    expect(hourCalls).toEqual([1, 0, 1].map(index => [observed.summary.snapshot_version, hour(index)]))

    current = empty
    await stationButton(page, 'Обновить').click()
    await expect(automatic.getByRole('status')).toHaveText('В выпуске нет числовых наблюдений.')
    await expect(automatic.locator('time')).toHaveCount(0)
    await expect(marker.locator('.pa-map-station__hour')).toBeHidden()
    expect(hourCalls).toHaveLength(3)
})

test('station history compares both particle concentrations on one hourly scale', async ({ page }, testInfo) => {
    if (testInfo.project.name === 'phone-320') await page.setViewportSize({ width: 320, height: 500 })
    const { summary, histories: [history] } = airFixture()
    const pm10 = [30, null, null, 0]
    history.pm10_rows = history.rows.map((row, index) => ({
        ...row, value: pm10[index], missing_reason: pm10[index] === null ? row.missing_reason : null,
    }))
    await page.route(`**${historyPath(history.snapshot_version, history.station_id)}`, route => route.fulfill({ json: history }))
    await page.route('**/api/v1/place-analysis', route =>
        route.fulfill({ json: analysisWithAir(route.request().postDataJSON(), summary) }))
    await page.route('**/api/v1/air/snapshots/*/hour?*', route => {
        const selected = new URL(route.request().url()).searchParams.get('observed_at_raw')
        const { station_id, rows, pm10_rows, ...metadata } = history
        return route.fulfill({ json: { ...metadata, observed_at_raw: selected, rows: [
            { ...rows.find(row => row.observed_at_raw === selected), station_id },
            { ...rows.find(row => row.observed_at_raw === selected), station_id: '1002', value: null,
                row_present: false, missing_reason: 'SOURCE_ROW_MISSING', qc_reason: 'SOURCE_ROW_MISSING' },
        ] } })
    })
    await openPointAir(page)
    await stationButton(page, 'Станция Альфа').click()
    const metrics = page.getByRole('group', { name: 'Показатель графика' })
    await metrics.getByRole('button', { name: 'PM₁₀', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'История PM₁₀' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Выбор часа PM₁₀' }).getByRole('button').first()).toHaveAccessibleName(/30 мкг/)
    await metrics.getByRole('button', { name: 'Вместе' }).click()
    const compare = page.getByRole('group', { name: 'Выбор часа PM2,5 и PM₁₀' })
    await expect(compare.getByRole('button').first()).toHaveAccessibleName(/PM2,5 ·? ?0 мкг.*PM₁₀.*30 мкг/)
    await expect(compare.getByRole('button').first().locator('.pa-bar')).toHaveCount(2)
    await expect(compare.getByRole('button').first().locator('.pa-bar--pm10')).toHaveCSS('height', /.+px/)
    await expect(page.locator('.pa-chart__scale').getByText('30', { exact: true })).toHaveCount(1)
    await expect(compare.getByRole('button').nth(2)).toHaveAccessibleName(/Пропущен час.*Пропущен час/)
    await compare.getByRole('button').first().click()
    await expect(page.getByRole('region', { name: 'Выбранный час PM2,5' }).locator('time')).toHaveText(displayedHour(0))
    await metrics.getByRole('button', { name: 'PM2,5', exact: true }).click()
    await expect(airSeries(page)).toBeVisible()
})

test('archive ranges preserve station history across panels and count numeric hours', async ({ page }, testInfo) => {
    const readings = Array(72).fill(12)
    readings.splice(69, 3, 0, null, undefined)
    const empty = Array(72).fill(undefined)
    empty[70] = null
    const { summary, histories } = airFixture(airSnapshot.snapshot_version, 0, [readings, empty])
    const historyRequests = []
    for (const history of histories) {
        await page.route(`**${historyPath(history.snapshot_version, history.station_id)}`, route => {
            historyRequests.push(history.station_id)
            return route.fulfill({ json: history })
        })
    }
    await page.route('**/api/v1/place-analysis', route => route.fulfill({ json: analysisWithAir(route.request().postDataJSON(), summary) }))

    await openPointAir(page)
    const alpha = stationButton(page, 'Станция Альфа')
    await alpha.click()
    const side = page.locator('#pa-panel-air')
    const range = airRange(page)
    const bins = page.locator('.pa-chart__bin')
    const latest = page.locator('.pa-air-latest')
    await expect(side.locator('.pa-air-latest strong')).toHaveText('0 мкг/м³')
    await expect(latest.locator('time')).toHaveAttribute('datetime', hour(69).replace(' ', 'T'))
    await expect(airSeries(page).getByText('Архив: 09.08 — 11.08.2026', { exact: true })).toBeVisible()
    await expect(range).toHaveValue('recent')
    await expect(airSeries(page).getByText('График: 10.08, 00:00 — 11.08, 23:00', { exact: true })).toBeVisible()
    await expect(airSeries(page).getByText('46 из 48 часов со значениями')).toBeVisible()
    await expect(bins).toHaveCount(48)
    await expect(bins.nth(46)).toHaveAttribute('data-missing-reason', 'SOURCE_VALUE_NULL_OR_ABSENT')
    await expect(bins.nth(47)).toHaveAttribute('data-missing-reason', 'SOURCE_ROW_MISSING')
    await hourlyValues(page).click()
    await expect(airSeries(page).getByRole('row')).toHaveCount(49)

    await range.selectOption({ label: 'Весь архив' })
    await expect(airSeries(page).getByText('70 из 72 часов со значениями')).toBeVisible()
    await expect(bins).toHaveCount(72)
    await expect(airSeries(page).getByRole('row')).toHaveCount(73)
    await hourlyValues(page).click()
    await page.getByRole('button', { name: 'Открыть график внизу' }).click()
    const dock = page.locator('#pa-air-dock')
    if (testInfo.project.name === 'short-desktop') {
        await page.setViewportSize({ width: 2200, height: 900 })
        await expect.poll(() => dock.evaluate(element => {
            const header = element.querySelector('.pa-station-detail__header').getBoundingClientRect()
            const body = element.querySelector('.pa-station-detail__body')
            const overview = element.querySelector('.pa-history__overview')
            const chart = element.querySelector('.pa-chart').getBoundingClientRect()
            const plot = element.querySelector('.pa-chart__series').getBoundingClientRect()
            const labels = element.querySelector('.pa-chart__labels').getBoundingClientRect()
            const summary = element.querySelector('.pa-air-latest').getBoundingClientRect()
            const metadata = element.querySelector('.pa-air-meta').getBoundingClientRect()
            const panel = element.getBoundingClientRect()
            const { paddingLeft, paddingRight } = getComputedStyle(element)
            const originalChartWidth = 1440 - 224 - parseFloat(getComputedStyle(overview).columnGap)
                - (body.offsetWidth - body.clientWidth)
            return Math.abs(header.left - panel.left - parseFloat(paddingLeft)) < 1
                && Math.abs(panel.right - header.right - parseFloat(paddingRight)) < 1
                && Math.abs(chart.width - originalChartWidth) < 1
                && summary.left > chart.right && metadata.left > summary.right && Math.abs(summary.top - metadata.top) < 1
                && plot.height >= 180 && labels.bottom <= body.getBoundingClientRect().bottom
        })).toBe(true)
        await expect(dock.locator('.pa-chart__tick').first()).toBeVisible()
    }
    await expect(dock.locator('.pa-air-latest strong')).toHaveText('0 мкг/м³')
    await expect(range).toHaveValue('archive')
    await range.selectOption({ label: '48 часов' })
    await expect(bins).toHaveCount(48)
    await expect(alpha).toHaveAttribute('aria-pressed', 'true')
    for (const panel of [dock, side]) {
        if (panel === side) await page.getByRole('button', { name: 'Вернуть в боковую панель' }).click()
        const coverage = panel.getByText('46 из 48 часов со значениями')
        await coverage.scrollIntoViewIfNeeded()
        await expect(coverage).toBeInViewport()
        expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(historyRequests).toEqual(['1001'])

    await stationButton(page, 'Станция Бета').click()
    await expect(latest).toContainText('У станции нет числовых значений в архиве.')
    await expect(latest.locator('time')).toHaveCount(0)
    await expect(airSeries(page).getByText('0 из 48 часов со значениями')).toBeVisible()
    await expect(bins).toHaveCount(48)
    await expect(bins.locator('.pa-bar')).toHaveCount(0)
    await hourlyValues(page).click()
    await expect(airSeries(page).getByRole('row', { name: `${displayedHour(70)} Пустое значение` })).toBeVisible()
    await expect(airSeries(page).getByRole('row', { name: `${displayedHour(71)} Пропущен час` })).toBeVisible()
    expect(historyRequests).toEqual(['1001', '1002'])
})

test('short screen can scroll through the graph and hourly values', async ({ page, viewport }) => {
    await page.setViewportSize(viewport.width > 820 ? { width: 1280, height: 560 } : { width: 320, height: 500 })
    const { summary, histories: [history] } = airFixture(airSnapshot.snapshot_version, 0, [Array(168).fill(12)])
    await page.route(`**${historyPath(history.snapshot_version, history.station_id)}`, route => route.fulfill({ json: history }))
    await page.route('**/api/v1/place-analysis', route => route.fulfill({ json: analysisWithAir(route.request().postDataJSON(), summary) }))
    await openPointAir(page)
    await stationButton(page, 'Станция Альфа').click()
    await expect(page.locator('.pa-chart')).toBeVisible()
    const values = hourlyValues(page)
    await values.scrollIntoViewIfNeeded()
    await values.click()
    const last = airSeries(page).getByRole('cell', { name: '12', exact: true }).last()
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    const horizontalOverflow = await page.locator('.pa-panel__scroll').evaluate(panel =>
        panel.scrollWidth > panel.clientWidth || document.documentElement.scrollWidth > window.innerWidth)
    expect(horizontalOverflow).toBe(false)
    await page.getByRole('button', { name: 'Открыть график внизу' }).click()
    await expect(page.locator('#pa-air-dock [data-station-distance]')).toHaveText('Расстояние до выбранного места неизвестно')
    await expect(page.locator('#pa-air-dock .pa-chart__plot')).toBeInViewport({ ratio: 0.99 })
    await airRange(page).selectOption('archive')
    await expect(airSeries(page).getByText('168 из 168 часов со значениями')).toBeVisible()
    await expect(page.locator('#pa-air-dock .pa-chart__labels')).toBeInViewport({ ratio: 0.99 })
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
    await page.getByRole('tab', { name: 'Снимки и NDVI', exact: true }).click()
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
        await expect(page.locator('.pa-chart .pa-chart__bin')).toHaveCount(48)
        await airRange(page).selectOption('archive')
        await expect(page.locator('.pa-chart .pa-chart__bin')).toHaveCount(168)
        await airRange(page).selectOption('recent')
        expect(historyRequests.at(-1)).toBe(historyPath(air.snapshot_version, id))
    }

    const history = histories[0]
    const station = data.stations.find(item => item.id === history.station_id)
    await stationButton(page, station.name).click()
    await expect(stationMarker(page, station.id)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Местоположение по данным источника', { exact: true })).toBeVisible()
    await expect(airSeries(page).getByText('Архив: 09.08 — 15.08.2026', { exact: true })).toBeVisible()
    await airRange(page).selectOption('archive')
    await expect(page.locator('.pa-chart .pa-chart__bin')).toHaveCount(168)
    await hourlyValues(page).click()
    const zero = history.rows.find(row => row.value === 0)
    const [date, time] = zero.observed_at_raw.split(' ')
    const hourLabel = `${date.split('-').reverse().join('.')}, ${time.slice(0, 5)}`
    const zeroRow = airSeries(page).getByRole('row').filter({ has: page.getByRole('cell', { name: hourLabel, exact: true }) })
    await expect(zeroRow.getByRole('cell')).toHaveText([hourLabel, '0'])
    expect(historyRequests).toEqual([...histories, history].map(row => historyPath(air.snapshot_version, row.station_id)))
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(card(page, 'poi').getByRole('status')).toHaveText('Готово')
    await expect(card(page, 'satellite').getByRole('status')).toHaveText('Наблюдение готово')
    expect(requests.sort()).toEqual(['air', 'poi', 'satellite', 'satellite'])
})
