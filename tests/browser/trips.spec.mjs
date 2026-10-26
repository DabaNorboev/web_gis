import { test, expect } from './support.mjs'
import { places } from './fixtures.mjs'
const initial = { version: 1, mode: 'driving', start: { lon: 92.870000123456, lat: 56.010000123456 }, places: [{ lon: 92.89, lat: 56.02, label: 'Работа' }, { lon: 92.91, lat: 56.03, label: 'Учёба' }] }
const link = value => '/trips#trip=' + new URLSearchParams({ trip: JSON.stringify(value) }).toString().slice(5)
const alternatives = [{ point: { lon: 92.9101, lat: 56.03 }, distance_m: 6, name: 'Проезд A' }, { point: { lon: 92.9099, lat: 56.03 }, distance_m: 6.2, name: 'Проезд Б' }]
function row(value, index, location, category = 'obstacle') {
    const target = value.places[index], start = value.start
    const matched = point => point.road ?? { lon: point.lon + .00001, lat: point.lat }
    return { index, label: target.label, start, target, status: location ? category === 'ambiguity' ? 'NEEDS_REFINEMENT' : 'UNKNOWN' : 'AVAILABLE',
        reason: 'Сырой текст специально называет другой конец — старт. Не использовать для локализации.', checks: [],
        diagnostics: { version: 1, issues: location ? [{ code: category === 'ambiguity' ? 'SNAP_CHOICE_REQUIRED' : 'SYNTHETIC', category, stage: location === 'route' ? 'geometry' : 'snap', location, target_index: ['target', 'both_endpoints'].includes(location) ? index : null }] : [] },
        route: location ? null : { geometry: { type: 'LineString', coordinates: [[matched(start).lon, start.lat], [matched(target).lon, target.lat]] }, distance_m: 1234 + index, duration_s: 480 },
        snaps: location ? null : { start: { original: start, matched: matched(start), distance_m: 1 }, target: { original: target, matched: matched(target), distance_m: 1 } },
        road_choices: { start: { status: 'SELECTED', point: matched(start), candidates: [] }, target: { status: category === 'ambiguity' && !target.road ? 'CHOOSE' : 'SELECTED', point: category === 'ambiguity' && !target.road ? null : matched(target), candidates: category === 'ambiguity' ? alternatives : [] } },
        metrics: { distance: { value: location ? null : 1234 }, duration: { value: location ? null : 480 } } }
}
function response(value, location = null, category) { return { mode: 'driving', start: value.start, results: value.places.map((_, i) => row(value, i, i === 1 ? location : null, category)), source: null, limitation: 'Синтетический граф, не натурные данные.' } }
async function install(page) {
    const calls = [], labels = []
    let reply = value => response(value)
    let labelIds = [1]
    await page.route('**/api/v1/addresses/resolve-point', route => {
        const request = route.request(); labels.push({ point: request.postDataJSON(), url: request.url(), headers: request.headers() })
        return route.fulfill({ json: { data: { match: labelIds.length ? 'CONTAINING' : 'NONE', requires_choice: labelIds.length > 1, candidates: labelIds.map(id => ({ id: `osm:way:${id}`, label: `Подпись ${id}`, object_type: 'building', geometry_type: 'POLYGON', distance_m: 0 })) }, meta: { source: 'OpenStreetMap', dataset_import_id: 3, quality: { reason: 'Дата неизвестна', availability: 'AVAILABLE' }, coverage: { reason: 'Полнота неизвестна' } } } })
    })
    await page.route('**/api/v1/trips/analyze', async route => {
        const request = route.request(), value = request.postDataJSON(); calls.push({ value, url: request.url(), headers: request.headers() })
        const result = await reply(value)
        if (result === 'error') return route.fulfill({ status: 503, json: { message: 'Синтетический технический отказ' } })
        return route.fulfill({ json: result })
    })
    return { calls, labels, respond(value) { reply = value }, labelIds(value) { labelIds = value } }
}
const mapData = page => page.evaluate(async () => await window.__smokeMapIn('#trip-map').getSource('trips').getData())
async function loaded(page) { await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('#trip-map')?.getSource('trips'))).toBe(true) }
const submit = page => page.locator('#trip-form').getByRole('button', { name: 'Рассчитать поездки', exact: true }).press('Enter')
const overflow = async page => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

test('trips search, explicit address objects, point labels and sequential steps preserve originals', async ({ page, api }) => {
    const service = await install(page); service.labelIds([1, 2])
    await page.goto('/trips'); await loaded(page)
    await expect(page.getByRole('spinbutton')).toHaveCount(0)
    const input = page.getByRole('combobox', { name: 'Адрес в Красноярске' })
    await input.fill('Неоднозначная')
    await expect(page.getByRole('option')).toHaveCount(1)
    await input.press('ArrowDown'); await input.press('Enter')
    await expect(page.locator('.trip-address-objects button')).toHaveCount(10)
    expect(service.labels).toHaveLength(0)
    await page.locator('.trip-address-objects button').nth(3).press('Enter')
    await expect(page.locator('.trip-point-label input[type=radio]')).toHaveCount(2)
    const selected = service.labels.at(-1).point
    await page.locator('.trip-point-label input').first().press('Space')
    await expect.poll(async () => (await mapData(page)).features.find(f => f.properties.label === 'Старт')?.geometry.coordinates).toEqual([selected.lon, selected.lat])
    await page.getByRole('button', { name: 'Далее: место 1', exact: true }).press('Enter')
    await expect(page.locator('.trip-map-controls')).toContainText('Место 1 — исходная точка')
    await page.getByRole('combobox').fill(places.b.label)
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.getByRole('combobox').press('ArrowDown'); await page.getByRole('combobox').press('Enter')
    await page.locator('.trip-step-actions').getByRole('button', { name: 'Рассчитать поездки', exact: true }).press('Enter')
    await expect(page.locator('.trip-values')).toHaveCount(1)
    expect(service.calls.at(-1).value.start.lon).toBe(selected.lon)
    expect(service.calls.at(-1).value.mode).toBe('driving')
    expect(new URL(page.url()).search).toBe('')
    for (const request of [...service.calls, ...service.labels]) { expect(new URL(request.url).search).toBe(''); expect(request.headers.referer).toBeUndefined() }
    await overflow(page)
})

test('trips full and partial results, themes, summary close, fragment reload and history', async ({ page, api }, testInfo) => {
    const service = await install(page)
    service.respond(value => response(value, value.places[1].road && Math.abs(value.places[1].road.lon - alternatives[1].point.lon) < 1e-8 ? null : 'target', 'ambiguity'))
    await page.goto(link(initial)); await loaded(page)
    const second = page.locator('#trip-result-1')
    await expect(page.locator('.trip-values')).toHaveCount(1)
    await expect(second).toContainText('Выберите дорожную точку места 2')
    const count = service.calls.length
    await second.locator('[data-candidate-id="2-1"]').focus()
    expect(service.calls).toHaveLength(count)
    await second.locator('[data-candidate-id="2-1"]').press('Enter')
    await expect(page.locator('.trip-values')).toHaveCount(2)
    await expect(second.locator('details.trip-candidates')).not.toHaveAttribute('open')
    const url = page.url(), before = await mapData(page), calls = service.calls.length
    for (const name of ['Тёмная', 'Улицы', 'Светлая']) {
        await page.getByRole('button', { name, exact: true }).click()
        expect(await mapData(page)).toEqual(before)
        expect(service.calls).toHaveLength(calls)
    }
    expect(before.features.filter(f => f.properties.kind === 'connector')).toHaveLength(3)
    await page.getByRole('button', { name: 'Скрыть уведомление', exact: true }).click()
    await expect(page.locator('.trip-action-summary')).toHaveCount(0)
    await expect(page.locator('.trip-values')).toHaveCount(2)
    await page.getByLabel('Название для себя').first().fill('Переименовано')
    await page.getByLabel('Название для себя').first().press('Tab')
    await expect(page.locator('.trip-values')).toHaveCount(2)
    expect(service.calls).toHaveLength(calls)
    await page.goBack(); await expect(page.locator('.trip-values')).toHaveCount(2)
    await page.goBack(); await expect(second).toContainText('Выберите дорожную точку места 2')
    await page.goForward(); await expect(page.locator('.trip-values')).toHaveCount(2)
    await page.reload(); await expect(page.locator('.trip-values')).toHaveCount(2)
    expect(new URL(page.url()).search).toBe(''); expect(url).toContain('#trip=')
    await overflow(page)
    await loaded(page)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('#trip-map').queryRenderedFeatures({ layers: ['trip-paths'] }).length), { message: 'accepted route is rendered on the real map' }).toBeGreaterThan(0)
    if (page.viewportSize().width > 900 && page.viewportSize().height <= 560) {
        await expect.poll(() => page.evaluate(async () => {
            const map = window.__smokeMapIn('#trip-map'), data = await map.getSource('trips').getData()
            const pixels = data.features.filter(feature => feature.properties.kind === 'route').flatMap(feature => feature.geometry.coordinates.map(point => map.project(point).y))
            return (Math.max(...pixels) - Math.min(...pixels)) / map.getCanvas().clientHeight
        }), { message: 'short-screen route occupies a readable part of the canvas' }).toBeGreaterThan(.4)
    }
    await page.screenshot({ path: testInfo.outputPath('trips-final.png'), fullPage: true })
})

test('trips structured diagnostic locations have feasible primary actions and no reason guesses', async ({ page, api }) => {
    const service = await install(page)
    for (const [location, category, title, action] of [
        ['start', 'distance', 'Нужно уточнить старт', 'Уточнить старт'],
        ['target', 'obstacle', 'Нужно уточнить место 2', 'Уточнить место 2'],
        ['both_endpoints', 'access', 'Нужно уточнить обе привязки', 'Уточнить обе точки'],
        ['route', 'access', 'Ограничение на участке маршрута', 'Проверить точки'],
        ['unknown', 'insufficient_data', 'Положение проблемы неизвестно', 'Проверить точки'],
        ['unknown', 'service', 'Расчёт временно недоступен', 'Повторить расчёт'],
    ]) {
        service.respond(value => response(value, location, category))
        await page.goto(link(initial)); await loaded(page)
        const warning = page.locator('#trip-failure-1')
        await expect(warning).toContainText(title)
        await expect(warning).not.toContainText('Сырой текст')
        await expect(warning).not.toContainText('до этого участка')
        await warning.getByRole('button', { name: action, exact: true }).press('Enter')
        if (['start', 'target', 'both_endpoints'].includes(location)) await expect(page.locator('.trip-map-controls')).toContainText(location === 'target' ? 'Место 2 · Учёба — исходная точка' : 'Старт — исходная точка')
        if (category !== 'service') await expect(page.locator('#trip-result-0 .trip-values')).toHaveCount(1)
        await overflow(page)
    }
})

test('trips explicit submit reveals warning without taking focus or moving desktop map; editing suppresses late scroll', async ({ page, api }) => {
    const service = await install(page)
    service.respond(value => response(value, 'target', 'distance'))
    await page.goto(link(initial)); await loaded(page)
    const canvas = page.locator('#trip-map canvas')
    const before = await canvas.boundingBox()
    if (page.viewportSize().width > 900) {
        for (const selector of ['#trip-map canvas', '#trip-map .maplibregl-ctrl-zoom-in', '#trip-map .trip-step-actions']) {
            const rect = await page.locator(selector).boundingBox()
            expect(rect.y).toBeGreaterThan(70)
            expect(rect.y + rect.height).toBeLessThanOrEqual(page.viewportSize().height)
        }
        expect(before.height).toBeGreaterThanOrEqual(128) // 130 px frame, minus its two border pixels.
    }
    await submit(page)
    await expect(page.locator('#trip-failure-1')).toBeInViewport()
    await expect(page.locator('#trip-form button[type=submit]')).toBeFocused()
    if (page.viewportSize().width > 900) expect(await canvas.boundingBox()).toEqual(before)
    let release
    service.respond(value => new Promise(resolve => { release = () => resolve(response(value, 'unknown')) }))
    await submit(page)
    await expect.poll(() => !!release).toBe(true)
    const name = page.getByLabel('Название для себя').first()
    await name.fill('Продолжаю редактировать')
    const scroll = await page.evaluate(() => ({ left: document.querySelector('.trip-form-results').scrollTop, outer: document.querySelector('.trips-scroll').scrollTop }))
    release()
    await expect(page.locator('#trip-failure-1')).toContainText('Положение проблемы неизвестно')
    expect(await page.evaluate(() => ({ left: document.querySelector('.trip-form-results').scrollTop, outer: document.querySelector('.trips-scroll').scrollTop }))).toEqual(scroll)
    await expect(name).toBeFocused()
    // A slow, otherwise current answer also must not initiate a surprise scroll.
    release = undefined
    await submit(page)
    await expect.poll(() => !!release).toBe(true)
    const slowScroll = await page.evaluate(() => ({ left: document.querySelector('.trip-form-results').scrollTop, outer: document.querySelector('.trips-scroll').scrollTop }))
    await new Promise(resolve => setTimeout(resolve, 2700))
    release()
    await expect(page.locator('#trip-form button[type=submit]')).toHaveAttribute('aria-disabled', 'false')
    expect(await page.evaluate(() => ({ left: document.querySelector('.trip-form-results').scrollTop, outer: document.querySelector('.trips-scroll').scrollTop }))).toEqual(slowScroll)
})

test('trips common start, technical retry, map edits and late response cannot restore dependent routes', async ({ page, api }) => {
    const service = await install(page)
    service.respond(value => ({ ...response(value), results: value.places.map((_, index) => row(value, index, 'start', 'distance')) }))
    await page.goto(link(initial)); await loaded(page)
    await expect(page.locator('#trip-shared-start')).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'Нужно уточнить старт', exact: true })).toHaveCount(1)
    service.respond(value => response(value))
    await submit(page); await expect(page.locator('.trip-values')).toHaveCount(2)
    service.respond(() => 'error')
    await submit(page); await expect(page.locator('.trip-values')).toHaveCount(0)
    await submit(page); await expect(page.locator('.trip-values')).toHaveCount(0)
    service.respond(value => response(value))
    await page.locator('#trip-form').getByRole('button', { name: 'Рассчитать поездки', exact: true }).press('Enter')
    await expect(page.locator('.trip-values')).toHaveCount(2)
    service.labelIds([])
    await page.getByRole('button', { name: 'Изменить место 2', exact: true }).press('Enter')
    await page.locator('#trip-map canvas').click({ position: { x: 100, y: 80 } })
    await expect(page.locator('#trip-result-0 .trip-values')).toHaveCount(1)
    await expect(page.locator('#trip-result-1 .trip-values')).toHaveCount(0)
    await page.getByRole('button', { name: 'Изменить старт', exact: true }).press('Enter')
    const oldCenter = await page.evaluate(() => window.__smokeMapIn('#trip-map').getCenter().toArray())
    await page.locator('#trip-map canvas').press('ArrowRight')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('#trip-map').getCenter().toArray())).not.toEqual(oldCenter)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('#trip-map').isMoving())).toBe(false)
    await page.getByRole('button', { name: 'Выбрать центр карты', exact: true }).press('Enter')
    await expect(page.locator('.trip-values')).toHaveCount(0)
    await overflow(page)
})

test('trips simultaneous start and target ambiguity keeps each action at its own endpoint', async ({ page, api }) => {
    const service = await install(page)
    service.respond(value => {
        const result = response(value, 'target', 'ambiguity')
        result.results = result.results.map((item, index) => ({ ...item, status: 'NEEDS_REFINEMENT', route: null, snaps: null,
            diagnostics: { version: 1, issues: [
                { code: 'SNAP_CHOICE_REQUIRED', category: 'ambiguity', stage: 'snap', location: 'start', target_index: null },
                ...(index === 1 ? [{ code: 'SNAP_CHOICE_REQUIRED', category: 'ambiguity', stage: 'snap', location: 'target', target_index: 1 }] : []),
            ] },
            road_choices: { ...item.road_choices, start: { status: 'CHOOSE', point: null, candidates: alternatives } },
        }))
        return result
    })
    await page.goto(link(initial)); await loaded(page)
    await expect(page.locator('#trip-shared-start')).toHaveClass(/trip-choice-notice/)
    const targetNotice = page.locator('#trip-failure-1 > div').filter({ has: page.getByRole('heading', { name: 'Выберите дорожную точку места 2', exact: true }) })
    const count = service.calls.length
    await targetNotice.getByRole('button', { name: 'Выбрать вариант', exact: true }).press('Enter')
    await expect(page.locator('#trip-result-1 [data-candidate-id="2-0"]')).toBeFocused()
    expect(service.calls).toHaveLength(count)
    await page.locator('#trip-shared-start').getByRole('button', { name: 'Выбрать вариант', exact: true }).press('Enter')
    await expect(page.locator('#trip-result-0 [data-candidate-id="S-0"]')).toBeFocused()
    expect(service.calls).toHaveLength(count)
})
