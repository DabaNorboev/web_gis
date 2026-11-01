import { test, expect, homeScreen } from './support.mjs'
import { places } from './fixtures.mjs'
import { carResponse } from './fixtures/home-trips.mjs'
const selection = { version: 1, mode: 'driving', places: [
    { id: 'same-one', label: 'Работа и дополнительные занятия — одинаковое длинное название', point: { lon: 92.89, lat: 56.02 } },
    { id: 'same-two', label: 'Работа и дополнительные занятия — одинаковое длинное название', point: { lon: 92.90, lat: 56.03 } },
    { id: 'third', label: 'Работа и дополнительные занятия — похожее длинное название', point: { lon: 92.91, lat: 56.04 } },
], roads: {} }
const root = value => '/?' + new URLSearchParams({ left: places.a.id, right: places.b.id, radius_m: '500' }) + '#' + new URLSearchParams({ places: JSON.stringify(value ?? selection) })
const row = (page, id = 'same-two') => page.locator(`.home-result-table [data-goal-id="${id}"]`)
const tools = page => page.getByLabel('Показ целей', { exact: true })
const map = page => page.locator('.placelens-map')
async function setup(page, { error = false, held = false } = {}) {
    await page.addInitScript(() => localStorage.setItem('placelens:interface:v1', 'workspace'))
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} } } }))
    const calls = []; let release
    const wait = new Promise(resolve => { release = resolve })
    await page.route('**/api/v1/trips/analyze', async route => {
        const value = route.request().postDataJSON(); calls.push(value)
        if (held && value.start.lon === places.b.lon) await wait
        if (error && value.start.lon === places.b.lon) return route.fulfill({ status: 503, json: { message: 'Синтетический отказ Б' } })
        const response = carResponse(value)
        response.results.forEach(result => { result.route.duration_s = value.start.lon === places.a.lon ? 960 : 1380 })
        await route.fulfill({ json: response })
    })
    return { calls, release, failB(value) { error = value } }
}
async function state(page) { return page.evaluate(async () => {
    const m = window.__smokeMapIn('.placelens-map')
    return { center: m.getCenter().toArray(), zoom: m.getZoom(), data: await m.getSource('trips')?.getData(), size: [m.getCanvas().clientWidth, m.getCanvas().clientHeight] }
}) }
async function showMap(page) {
    const switcher = page.getByRole('tablist', { name: 'Рабочая область', exact: true }).getByRole('tab', { name: 'Карта', exact: true })
    if (await switcher.isVisible()) await switcher.press('Enter')
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.placelens-map')?.getSource('trips'))).toBe(true)
}
async function routes(page) { return (await state(page)).data.features.filter(f => f.properties.kind === 'route') }

test('stable row → one goal → details → exact row, display scope and threshold do not calculate or move camera', async ({ page, api }) => {
    const h = await setup(page); await page.goto(root())
    const origin = row(page).locator('[data-side=right]').getByRole('button', { name: 'Показать маршрут', exact: true })
    await expect(origin).toBeVisible(); await origin.press('Enter'); await showMap(page)
    await expect(tools(page).getByRole('button', { name: 'Одна цель', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await routes(page)).length).toBe(2)
    expect((await routes(page)).every(f => JSON.parse(f.properties.entity)[0].placeId === 'same-two')).toBe(true)
    const count = h.calls.length, originalUrl = page.url()
    await page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); window.__v1fits = []; const fit = m.fitBounds.bind(m); m.fitBounds = (...args) => { window.__v1fits.push(args[0]); return fit(...args) } })
    await expect(tools(page).getByRole('button', { name: 'Все цели', exact: true })).toHaveCount(1)
    await expect(tools(page).getByRole('button', { name: /Вместить|Подробности/ })).toHaveCount(0)
    await tools(page).getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
    await expect.poll(async () => (await routes(page)).length).toBe(6)
    await expect.poll(() => page.evaluate(() => window.__v1fits.length)).toBe(1)
    expect(await page.evaluate(() => window.__v1fits[0][1][1])).toBeGreaterThanOrEqual(56.04)
    expect(h.calls).toHaveLength(count); expect(page.url()).toBe(originalUrl)
    const before = await state(page), history = await page.evaluate(() => history.length), url = page.url()
    await map(page).locator('.city-trip-marker.is-goal').nth(1).press('Enter')
    const details = page.getByRole('dialog', { name: 'Результат на карте', exact: true })
    await expect(details).toContainText('Б →'); await details.getByRole('button', { name: 'К строке', exact: true }).press('Enter')
    await homeScreen(page, 'Сравнение')
    await expect(origin).toBeFocused(); await expect(row(page).locator('[data-side=right]')).toHaveAttribute('data-map-selected', 'true')
    const orientation = row(page).getByRole('button', { name: /^Изменить цель/ })
    await orientation.press('Enter')
    await page.getByRole('region', { name: 'Редактор поездок', exact: true }).getByRole('textbox', { name: /Ориентировочное время/ }).nth(1).fill('20')
    await showMap(page)
    await expect(map(page).locator('.city-trip-marker.is-goal').filter({ hasText: 'А ✓ · Б ↑' })).toHaveCount(1)
    await expect(row(page).locator('[data-orientation-status=within]')).toHaveCount(1)
    await expect(row(page).locator('[data-orientation-status=over]')).toHaveCount(1)
    const after = await state(page)
    expect(after.center).toEqual(before.center); expect(after.zoom).toBe(before.zoom); expect(after.data).toEqual(before.data)
    expect(h.calls).toHaveLength(2); expect(await page.evaluate(() => history.length)).toBe(history); expect(page.url()).toBe(url)
    // Same visible names are resolved through entity IDs, never text/position.
    const second = map(page).locator('.city-trip-marker.is-goal').filter({ hasText: 'А ✓ · Б ↑' })
    await second.press('Enter'); await details.getByRole('button', { name: 'Поездка А', exact: true }).press('Enter'); await expect(details).toContainText('А →')
    await details.getByRole('button', { name: 'Закрыть', exact: true }).press('Enter'); await expect(second).toBeFocused()
    await second.press('Enter'); await details.getByRole('button', { name: 'К строке', exact: true }).press('Enter')
    await homeScreen(page, 'Сравнение')
    await expect(row(page).locator('[data-side=left] [data-home-map-action]')).toBeFocused()
})

test('pending and failed B keep accepted A only; removal/mode clear their own geometry; expansion/resize are camera neutral', async ({ page, api }) => {
    const h = await setup(page, { held: true, error: true }); await page.goto(root()); await showMap(page)
    await expect.poll(() => h.calls.length).toBe(2)
    await expect.poll(async () => (await routes(page)).length).toBe(3)
    const unfitted = await state(page)
    await tools(page).getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
    // The explicit command can wait for map readiness; baseline it only once applied.
    await expect.poll(async () => { const fitted = await state(page); return JSON.stringify([fitted.center, fitted.zoom]) !== JSON.stringify([unfitted.center, unfitted.zoom]) }).toBe(true)
    await expect.poll(() => page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return m.loaded() && !m.isMoving() })).toBe(true)
    if (page.viewportSize().width >= 768) await map(page).getByRole('button', { name: 'Развернуть карту', exact: true }).press('Enter')
    const before = await state(page); h.release()
    await expect(map(page).locator('.city-trip-marker.is-goal').first()).toContainText('Б !')
    expect((await routes(page)).every(f => JSON.parse(f.properties.entity)[0].side === 'left')).toBe(true)
    if (page.viewportSize().width >= 768) await map(page).getByRole('button', { name: 'Свернуть карту', exact: true }).press('Enter')
    const after = await state(page); expect(after.center).toEqual(before.center); expect(after.zoom).toBe(before.zoom)
    expect(after.size[1]).toBeLessThanOrEqual(before.size[1]); expect(h.calls).toHaveLength(2)
    await map(page).locator('.city-trip-marker.is-goal').first().press('Enter')
    await page.getByRole('dialog', { name: 'Результат на карте', exact: true }).getByRole('button', { name: 'К строке', exact: true }).press('Enter')
    const editor = page.getByRole('region', { name: 'Редактор поездок', exact: true })
    await homeScreen(page, 'Настройки')
    await editor.getByRole('button', { name: /^Удалить общую цель/ }).first().press('Enter')
    await showMap(page); await expect.poll(async () => (await routes(page)).length).toBe(2)
    await expect(tools(page).getByRole('button', { name: 'Одна цель', exact: true })).toBeDisabled()
    const resultSwitcher = page.getByRole('tablist', { name: 'Рабочая область', exact: true }).getByRole('tab', { name: 'Сравнение', exact: true })
    if (await resultSwitcher.isVisible()) await resultSwitcher.press('Enter')
    await homeScreen(page, 'Настройки')
    await editor.getByRole('radio', { name: 'Пешком', exact: true }).check()
    await showMap(page); expect(await routes(page)).toHaveLength(0); expect(h.calls).toHaveLength(2)
})

// The single project verifies six actual sizes and saves reviewable rendering.
test('visual overview: three long goals, compact/expanded/one goal/error at exact viewports', async ({ page, api }, testInfo) => {
    test.skip(testInfo.project.name !== 'short-desktop', 'one sequential visual run')
    test.setTimeout(120_000)
    const h = await setup(page)
    for (const [width, height] of [[1440,900],[1280,720],[1280,560],[390,844],[320,740],[390,480]]) {
        await page.setViewportSize({ width, height }); await page.goto(root()); await page.reload()
        for (const goal of selection.places) {
            await homeScreen(page, 'Сравнение')
            await row(page, goal.id).getByRole('button', { name: /^Изменить цель/ }).press('Enter')
            await page.getByRole('region', { name: 'Редактор поездок', exact: true }).getByRole('textbox', { name: /Ориентировочное время/ }).nth(selection.places.indexOf(goal)).fill('20')
        }
        await showMap(page)
        await tools(page).getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
        expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([width,height])
        await expect.poll(async () => (await routes(page)).length).toBe(6)
        await tools(page).getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
        await expect(map(page).locator('.city-trip-marker.is-goal')).toHaveCount(3)
        await expect(map(page).locator('.city-trip-marker')).toHaveCount(5)
        const overlaps = await map(page).evaluate(node => {
            const markers = [...node.querySelectorAll('.city-trip-marker')].map(el => el.getBoundingClientRect())
            const controls = [...node.querySelectorAll('.maplibregl-ctrl, .city-map-legend, .map-theme-control')].map(el => el.getBoundingClientRect()).filter(r => r.width && r.height)
            return markers.some((r, i) => [...markers.slice(i + 1), ...controls].some(s => r.left < s.right && r.right > s.left && r.top < s.bottom && r.bottom > s.top))
        })
        expect(overlaps).toBe(false)
        expect(await map(page).evaluate(node => {
            const scale = node.querySelector('.maplibregl-ctrl-scale').getBoundingClientRect(), attribution = node.querySelector('.maplibregl-ctrl-attrib').getBoundingClientRect()
            return !(scale.left < attribution.right && scale.right > attribution.left && scale.top < attribution.bottom && scale.bottom > attribution.top)
        })).toBe(true)
        await page.evaluate(async () => { await document.fonts.ready; for (const selector of ['#home-panel', '#home-results-screen']) { const node = document.querySelector(selector); if (node) node.scrollTop = 0 } })
        await page.screenshot({ path: testInfo.outputPath(`overview-${width}x${height}-compact.png`) })
        if (width === 1440 || width === 390 && height === 844) await page.screenshot({ path: `experiments/placelens-visual/screenshots/v1-filled-${width}x${height}.png` })
        if (page.viewportSize().width >= 768) await map(page).getByRole('button', { name: 'Развернуть карту', exact: true }).press('Enter')
        if (width >= 768) await expect(map(page).getByRole('button', { name: 'Свернуть карту', exact: true })).toBeVisible()
        else { await expect(map(page)).toBeVisible(); await expect(page.locator('#home-results-screen')).toBeHidden() }
        await page.screenshot({ path: testInfo.outputPath(`overview-${width}x${height}-expanded.png`) })
        await map(page).locator('.city-trip-marker.is-goal').nth(1).press('Enter')
        await page.getByRole('dialog', { name: 'Результат на карте', exact: true }).getByRole('button', { name: 'Закрыть', exact: true }).press('Enter')
        await tools(page).getByRole('button', { name: 'Одна цель', exact: true }).press('Enter')
        await expect.poll(async () => (await routes(page)).length).toBe(2)
        await page.screenshot({ path: testInfo.outputPath(`overview-${width}x${height}-one.png`) })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await expect(map(page).getByRole('button', { name: 'Приблизить', exact: true })).toBeVisible()
        h.failB(true); await page.reload(); await showMap(page)
        await expect.poll(async () => (await routes(page)).length).toBe(3)
        await tools(page).getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
        await expect(map(page).locator('.city-trip-marker.is-goal')).toHaveCount(3)
        await page.screenshot({ path: testInfo.outputPath(`overview-${width}x${height}-error.png`) })
        if (height <= 480) {
            await expect.poll(() => page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return m.loaded() && !m.isMoving() })).toBe(true)
            const camera = await state(page), count = h.calls.length
            for (const name of ['Приблизить', 'Отдалить']) {
                const control = map(page).getByRole('button', { name, exact: true })
                await control.focus(); await expect(control).toBeInViewport({ ratio: 1 })
            }
            for (const selector of ['.maplibregl-ctrl-scale', '.maplibregl-ctrl-attrib']) {
                const control = map(page).locator(selector)
                await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport({ ratio: 1 })
            }
            expect(await page.locator('#home-map-screen').evaluate(node => node.scrollHeight <= node.clientHeight || node.scrollTop > 0)).toBe(true)
            await page.screenshot({ path: testInfo.outputPath(`overview-${width}x${height}-scrolled.png`) })
            const theme = map(page).getByRole('button', { name: 'Светлая', exact: true })
            await theme.focus(); await expect(theme).toBeInViewport({ ratio: 1 })
            const after = await state(page)
            expect(after.center).toEqual(camera.center); expect(after.zoom).toBe(camera.zoom); expect(after.data).toEqual(camera.data)
            expect(h.calls).toHaveLength(count)
        }
        h.failB(false)
    }
})

test('overview keeps active profile layers functional and themes/camera/request count independent', async ({ page, api }) => {
    const h = await setup(page); await page.goto(root()); await showMap(page)
    await expect.poll(async () => (await routes(page)).length).toBe(6)
    const before = await state(page)
    const layers = page.getByRole('region', { name: 'Слои карты', exact: true })
    await layers.getByRole('button', { name: /^Слои/ }).press('Enter')
    await layers.getByRole('checkbox', { name: /Парки/ }).check()
    await layers.getByRole('checkbox', { name: /Остановки/ }).check()
    await expect.poll(() => page.evaluate(() => {
        const m = window.__smokeMapIn('.placelens-map')
        return [m.getLayoutProperty('area-parks-fill', 'visibility'), m.getLayoutProperty('nearby-stops', 'visibility')]
    })).toEqual(['visible', 'visible'])
    await expect.poll(() => page.evaluate(async () => (await window.__smokeMapIn('.placelens-map').getSource('area-parks').getData()).features.length)).toBeGreaterThan(0)
    await layers.getByRole('button', { name: /^Слои/ }).press('Escape')
    for (const name of ['Тёмная', 'Улицы', 'Светлая']) {
        await map(page).getByRole('button', { name, exact: true }).press('Enter')
        const current = await state(page)
        expect(current.center).toEqual(before.center); expect(current.zoom).toBe(before.zoom); expect(current.data).toEqual(before.data)
    }
    expect(h.calls).toHaveLength(2)
})

test('early overview focus without goals is cancelled by address history before ready', async ({ page, api }) => {
    const h = await setup(page)
    let release; const wait = new Promise(resolve => { release = resolve })
    await page.route('**/smoke-background.json', async route => { await wait; await route.fulfill({ json: { type: 'FeatureCollection', features: [] } }) })
    try {
        await page.goto(root({ ...selection, places: [] }))
        const switcher = page.getByRole('tablist', { name: 'Рабочая область', exact: true }).getByRole('tab', { name: 'Карта', exact: true })
        if (await switcher.isVisible()) await switcher.press('Enter')
        await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.placelens-map'))).toBe(true)
        await expect(page.locator('.home-result-table thead')).toContainText(places.b.label)
        const before = await page.evaluate(() => {
            const m = window.__smokeMapIn('.placelens-map'), fit = m.fitBounds.bind(m)
            window.__overviewFits = []; m.fitBounds = (...args) => { window.__overviewFits.push(args); return fit(...args) }
            return { center: m.getCenter().toArray(), zoom: m.getZoom() }
        })
        await tools(page).getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
        await page.evaluate(({ left, right }) => {
            history.pushState({}, '', '/?' + new URLSearchParams({ left, right, radius_m: '500' }))
            dispatchEvent(new PopStateEvent('popstate'))
        }, { left: places.c.id, right: places.b.id })
        await expect(page.locator('.home-result-table thead')).toContainText(places.c.label)
        release()
        await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.placelens-map').loaded())).toBe(true)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const after = await state(page)
        expect(after.center).toEqual(before.center); expect(after.zoom).toBe(before.zoom)
        expect(await page.evaluate(() => window.__overviewFits)).toEqual([]); expect(h.calls).toHaveLength(0)
    } finally { release() }
})

for (const remove of [false, true]) test(`all goals before ready: ${remove ? 'removal cancels stale bounds' : 'fits current overlay once'}`, async ({ page, api }) => {
    const h = await setup(page)
    let release; const wait = new Promise(resolve => { release = resolve })
    await page.route('**/smoke-background.json', async route => { await wait; await route.fulfill({ json: { type: 'FeatureCollection', features: [] } }) })
    try {
        await page.goto(root()); await homeScreen(page, 'Карта')
        await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.placelens-map'))).toBe(true)
        await page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'), fit = m.fitBounds.bind(m); window.__readyFits = []; m.fitBounds = (...args) => { window.__readyFits.push(args[0]); return fit(...args) } })
        await tools(page).getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
        expect(await page.evaluate(() => window.__readyFits)).toEqual([])
        if (remove) {
            await homeScreen(page, 'Настройки')
            await page.getByRole('region', { name: 'Редактор поездок', exact: true }).getByRole('button', { name: /^Удалить общую цель/ }).last().press('Enter')
            await homeScreen(page, 'Карта')
        }
        release()
        if (remove) {
            await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.placelens-map').loaded())).toBe(true)
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            expect(await page.evaluate(() => window.__readyFits)).toEqual([])
            await tools(page).getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
        }
        await expect.poll(() => page.evaluate(() => window.__readyFits.length)).toBe(1)
        expect(await page.evaluate(() => window.__readyFits[0][1][1])).toBe(remove ? 56.03 : 56.04)
        expect(h.calls).toHaveLength(2)
    } finally { release() }
})
