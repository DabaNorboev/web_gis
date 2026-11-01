import { test, expect, homeScreen } from './support.mjs'
import { ambiguousGroup, places } from './fixtures.mjs'

const point = { lon: 92.9, lat: 56.01 }

test('home uses contextual point, inline sharing and header theme controls', async ({ page, api }, testInfo) => {
    let transportRequests = 0
    await page.route('**/api/v1/transport/analysis?*', route => { transportRequests++; return route.abort() })
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: {
        data: { match: 'NEARBY', requires_choice: false, candidates: [{ id: 'osm:way:1', label: 'Тестовая, 1', object_type: 'building', geometry_type: 'POLYGON', distance_m: 25 }] },
        meta: { source: 'OpenStreetMap', dataset_import_id: 3, observed_at: null, source_updated_at: null, calculated_at: '2026-11-01T00:00:00Z', nearby_radius_m: 100, coverage: { status: 'UNKNOWN', reason: 'Синтетический снимок' }, quality: { method: 'DERIVED', availability: 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Вход неизвестен' } },
    } }))
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedHomeLink = text } } }) })
    await page.goto('/')
    await expect(page.locator('.city-map-legend')).toHaveCount(0)
    const mobile = testInfo.project.name.startsWith('phone')
    const sidebar = page.locator('#home-panel')
    await expect(sidebar.getByRole('button', { name: 'Остановки', exact: true })).toHaveCount(0)
    await expect(sidebar.locator('.home-search-panel')).toHaveCount(0)
    await expect(sidebar.getByRole('combobox')).not.toBeVisible()
    await sidebar.getByRole('button', { name: 'Добавить адрес А', exact: true }).click()
    const search = page.getByRole('dialog', { name: 'Найти адрес А', exact: true })
    await expect(search.getByRole('combobox')).toBeFocused()
    await search.press('Escape')
    await expect(search).not.toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Добавить адрес А', exact: true })).toBeFocused()
    await sidebar.getByRole('button', { name: 'Поделиться', exact: true }).click()
    await expect(sidebar.getByRole('status')).toContainText('Ссылка скопирована')
    expect(await page.evaluate(() => window.__copiedHomeLink)).toMatch(/^http:\/\/127\.0\.0\.1:4173\/$/)
    await sidebar.getByRole('button', { name: 'Добавить место', exact: true }).click()
    await expect(sidebar.getByLabel('Название места', { exact: true }).first()).toHaveValue('Место 1')
    await page.goto(`/?lon=${point.lon}&lat=${point.lat}`)
    if (mobile) await page.getByRole('tab', { name: 'Карта', exact: true }).click()
    await expect(page.locator('.home-point-label')).toContainText('Рядом с Тестовая, 1')
    await expect(page.locator('.transport-results')).toHaveCount(0)
    await expect(page.locator('.city-map-overview')).toHaveCount(0)
    await expect(page.locator('.city-map-legend summary')).toHaveCount(0)
    await expect(page.locator('.city-map-legend')).not.toContainText('Радиус')
    await expect(page.locator('.city-map .map-theme-control')).toHaveCount(0)
    await page.locator('.home-theme-menu summary').click()
    await page.locator('.home-theme-menu').getByRole('button', { name: 'Тёмная', exact: true }).click()
    await expect(page.locator('.city-map')).toHaveAttribute('data-map-theme', 'dark')
    await expect(page.locator('.home-theme-menu')).not.toHaveAttribute('open')
    await expect(page.locator('#home-map-title')).toHaveClass('sr-only')
    await expect(page.getByRole('button', { name: 'Выбрать центр карты', exact: true })).toHaveCount(0)
    await expect(page.locator('.city-map-toolbar')).toHaveCount(0)
    await expect(page.locator('.home-theme-menu summary')).toBeInViewport()
    await expect(page.locator('.maplibregl-ctrl-scale')).toHaveCount(1)
    const callout = await page.locator('.city-point-callout').boundingBox()
    const navigation = await page.locator('.maplibregl-ctrl-bottom-right').boundingBox()
    expect(callout.y + callout.height).toBeLessThanOrEqual(navigation.y - 8)
    expect(transportRequests).toBe(0)
    if (!mobile) expect((await page.locator('#home-map-screen').boundingBox()).height).toBe(960)
    await page.screenshot({ path: testInfo.outputPath('home-interface.png'), fullPage: true })
})

const startGroup = { ...ambiguousGroup, bounds: [92.8698, 56.0098, 92.8722, 56.0107], object_count: 3,
    objects: ambiguousGroup.objects.slice(0, 3).map((object, index) => {
        const lon = 92.87 + index * .001, lat = 56.01 + (index === 1 ? .0005 : 0)
        return { ...object, lon, lat, geometry: { type: 'Polygon', coordinates: [[[lon - .00008, lat - .00005], [lon + .00008, lat - .00005], [lon + .00008, lat + .00005], [lon - .00008, lat + .00005], [lon - .00008, lat - .00005]]] } }
    }) }
const mapObjects = page => page.evaluate(async () => (await window.__smokeMapIn('.placelens-map').getSource('transport-selection').getData()).features.filter(f => f.properties.kind === 'address-object'))

test('route mode stays selected and start buildings highlight both ways before explicit selection', async ({ page, api }) => {
    let calculations = 0
    await page.route('**/api/v1/trips/analyze', route => { calculations++; return route.abort() })
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: {
        data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} },
    } }))
    await page.route('**/api/v1/addresses/search?*', route => route.fulfill({ json: { data: [startGroup], meta: { quality: {} } } }))
    await page.goto('/')
    const routeTab = page.getByRole('button', { name: 'Рассчитать маршрут', exact: true })
    await routeTab.click()
    const editor = page.locator('.home-trips-editor')
    for (const name of ['Пешком', 'Авто', 'Пешком']) {
        await editor.getByRole('radio', { name, exact: true }).check()
        await expect(routeTab).toHaveAttribute('aria-pressed', 'true')
        await expect(editor.getByRole('heading', { name: 'Точка старта', exact: true })).toBeVisible()
    }
    await expect(editor.getByText('Адреса из локального набора OpenStreetMap', { exact: true })).not.toBeVisible()
    await expect(editor.getByText('Пустое поле — без ориентира.', { exact: true })).toHaveCount(0)
    await expect(editor.getByLabel('Ориентировочное время · необязательно')).toBeVisible()
    await editor.getByText('Что увидит получатель ссылки', { exact: true }).click()
    await expect(editor.locator('.home-trip-privacy')).not.toContainText(/сценари/i)
    const start = editor.getByRole('region', { name: 'Поиск и подпись: Точка старта', exact: true })
    const input = start.getByRole('combobox')
    await input.fill(ambiguousGroup.label)
    await expect(start.getByRole('option')).toHaveCount(1)
    await input.press('ArrowDown'); await input.press('Enter')
    await expect.poll(async () => (await mapObjects(page)).length).toBe(3)
    const second = start.getByRole('button', { name: /^Объект 2 ·/ })
    await second.hover()
    await expect.poll(async () => (await mapObjects(page)).filter(f => f.properties.highlighted).map(f => f.properties.id)).toEqual([startGroup.objects[1].id])
    expect((await mapObjects(page)).some(f => f.properties.selected)).toBe(false)
    await homeScreen(page, 'Карта')
    const canvas = page.locator('.placelens-map canvas')
    await canvas.scrollIntoViewIfNeeded()
    const position = await page.evaluate(() => {
        const map = window.__smokeMapIn('.placelens-map')
        map.jumpTo({ center: [92.872, 56.01], zoom: 18 })
        const p = map.project([92.87206, 56.00997]); return { x: p.x, y: p.y }
    })
    await expect.poll(() => page.evaluate(p => window.__smokeMapIn('.placelens-map').queryRenderedFeatures([p.x,p.y], { layers: ['address-contours'] }).map(f => f.properties.id), position)).toContain(startGroup.objects[2].id)
    await page.locator(`.map-address-label[data-address-id="${startGroup.objects[2].id}"]`).hover()
    await expect.poll(async () => (await mapObjects(page)).filter(f => f.properties.highlighted).map(f => f.properties.id)).toEqual([startGroup.objects[2].id])
    const box = await canvas.boundingBox()
    await page.mouse.move(box.x + position.x, box.y + position.y)
    await expect.poll(async () => (await mapObjects(page)).filter(f => f.properties.highlighted).map(f => f.properties.id)).toEqual([startGroup.objects[2].id])
    await page.mouse.click(box.x + position.x, box.y + position.y)
    await expect.poll(async () => (await mapObjects(page)).find(f => f.properties.selected)?.properties.id).toBe(startGroup.objects[2].id)
    await homeScreen(page, 'Настройки')
    await expect(start.getByRole('button', { name: /^Объект 3 ·/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(routeTab).toHaveAttribute('aria-pressed', 'true')
    expect(calculations).toBe(0)
    await editor.getByRole('button', { name: 'Выбрать старт на карте', exact: true }).click()
    await homeScreen(page, 'Настройки')
    await expect(editor.getByRole('status').filter({ hasText: 'Выберите точку на общей карте.' })).toHaveText('Выберите точку на общей карте.')
    await page.screenshot({ path: test.info().outputPath('route-start.png'), fullPage: true })
})

async function selectBackground(page, offset = 0) {
    await homeScreen(page, 'Карта')
    const canvas = page.locator('.placelens-map canvas')
    await canvas.scrollIntoViewIfNeeded()
    const box = await canvas.boundingBox()
    await page.mouse.click(box.x + box.width * .76 + offset, box.y + Math.min(box.height * .42, 260))
    await expect(page.locator('.city-point-callout')).toBeVisible()
}

test('point callout offers available A/B sides, explicit replacements and route start; sidebar resizes', async ({ page, api }, info) => {
    let candidate = places.a, requests = 0, calculations = 0
    await page.route('**/api/v1/trips/analyze', route => { calculations++; return route.abort() })
    await page.route('**/api/v1/addresses/resolve-point', route => {
        requests++
        return route.fulfill({ json: { data: { match: candidate ? 'NEARBY' : 'NONE', requires_choice: false, candidates: candidate ? [{ id: candidate.id, label: candidate.label, object_type: 'building', geometry_type: 'POLYGON', distance_m: 25 }] : [] },
            meta: { source: 'OpenStreetMap', dataset_import_id: 3, observed_at: null, source_updated_at: null, calculated_at: '2026-11-01T00:00:00Z', nearby_radius_m: 100, coverage: { status: 'UNKNOWN', reason: 'Synthetic' }, quality: { method: 'DERIVED', availability: 'AVAILABLE', freshness: 'UNKNOWN', reason: 'Synthetic' } } } })
    })
    await page.goto('/')
    const mobile = info.project.name.startsWith('phone')
    const width = page.getByRole('separator', { name: 'Ширина боковой панели', exact: true })
    if (!mobile) {
        await expect(width).toHaveAttribute('aria-valuenow', '440')
        await width.press('ArrowRight'); await expect(width).toHaveAttribute('aria-valuenow', '456')
        expect(Math.round((await page.locator('#home-panel').boundingBox()).width)).toBe(456)
        const rail = await width.boundingBox()
        await page.mouse.move(rail.x + rail.width / 2, rail.y + 160); await page.mouse.down()
        await page.mouse.move(rail.x + rail.width / 2 + 30, rail.y + 160); await page.mouse.up()
        await expect(width).toHaveAttribute('aria-valuenow', '486')
        await page.reload(); await expect(width).toHaveAttribute('aria-valuenow', '486')
        await page.getByRole('button', { name: 'Вернуть исходную ширину панели', exact: true }).click()
        await expect(width).toHaveAttribute('aria-valuenow', '440')
    } else await expect(width).toHaveCount(0)
    await selectBackground(page)
    const popup = page.locator('.city-point-callout')
    await expect(page.locator('.home-map-heading .point-address')).toHaveCount(0)
    await expect(popup.getByRole('button', { name: 'Выбрать в качестве адреса А', exact: true })).toBeEnabled()
    await expect(popup.getByRole('button', { name: 'Выбрать в качестве адреса Б', exact: true })).toBeEnabled()
    await page.screenshot({ path: info.outputPath('point-callout.png'), fullPage: true })
    const count = requests
    await page.evaluate(() => window.__smokeMapIn('.placelens-map').panBy([5, 0], { duration: 0 }))
    await expect(popup).toBeVisible(); expect(requests).toBe(count)
    await popup.getByRole('button', { name: 'Выбрать в качестве адреса А', exact: true }).click()
    await homeScreen(page, 'Настройки')
    await expect(page.locator('.home-address-slot').first()).toContainText('Адрес выбран')
    candidate = places.b
    await selectBackground(page)
    await expect(popup.getByRole('button', { name: 'Выбрать в качестве адреса Б', exact: true })).toBeEnabled()
    await expect(popup.getByRole('button', { name: 'Выбрать в качестве адреса А', exact: true })).toHaveCount(0)
    await popup.getByRole('button', { name: 'Выбрать в качестве адреса Б', exact: true }).click()
    await homeScreen(page, 'Настройки')
    await expect(page.locator('.home-address-slot').nth(1)).toContainText('Адрес выбран')
    candidate = places.c
    await selectBackground(page)
    await expect(popup.getByRole('button', { name: 'Заменить адрес А', exact: true })).toBeEnabled()
    await expect(popup.getByRole('button', { name: 'Заменить адрес Б', exact: true })).toBeEnabled()
    candidate = null
    await selectBackground(page, 24)
    await expect(popup.getByRole('button', { name: 'Заменить адрес А', exact: true })).toBeDisabled()
    await expect(popup.getByRole('button', { name: 'Заменить адрес Б', exact: true })).toBeDisabled()
    await expect(popup.getByRole('button', { name: 'Найти адрес', exact: true })).toBeVisible()
    await homeScreen(page, 'Настройки')
    await page.getByRole('button', { name: 'Рассчитать маршрут', exact: true }).click()
    await selectBackground(page)
    const chosen = await page.evaluate(async () => (await window.__smokeMapIn('.placelens-map').getSource('transport-selection').getData()).features.find(f => f.properties.kind === 'point').geometry.coordinates)
    await popup.getByRole('button', { name: 'Выбрать в качестве точки старта', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Рассчитать маршрут', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.evaluate(async () => (await window.__smokeMapIn('.placelens-map').getSource('trips').getData()).features.find(f => f.properties.kind === 'original' && f.properties.label === 'Старт')?.geometry.coordinates)).toEqual(chosen)
    expect(calculations).toBe(0)
    await page.screenshot({ path: info.outputPath('marker-actions.png'), fullPage: true })
})
