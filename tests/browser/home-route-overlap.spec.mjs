import { test, expect, homeScreen } from './support.mjs'
import { places } from './fixtures.mjs'
import { carResponse } from './fixtures/home-trips.mjs'
const goals = ['one', 'two', 'three'].map((id, i) => ({ id, label: `Цель ${i + 1}`, point: { lon: 92.91 + i * .003, lat: 56.04 } }))
const root = '/?' + new URLSearchParams({ left: places.a.id, right: places.b.id, radius_m: '500' }) + '#' + new URLSearchParams({ places: JSON.stringify({ version: 1, mode: 'driving', places: goals, roads: {} }) })
const common = [[92.88,56.02],[92.89,56.025],[92.9,56.03]]
async function state(page) { return page.evaluate(async () => { const m = window.__smokeMapIn('.placelens-map'); return { data: await m.getSource('trips').getData(), center: m.getCenter().toArray(), zoom: m.getZoom() } }) }
test('V3 full/partial/reversed overlap, three goals, both sides, zoom/themes and accessible controls', async ({ page, api }, info) => {
    test.skip(info.project.name !== 'short-desktop', 'exact viewport matrix in one run')
    test.setTimeout(120_000)
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} } } }))
    const calls = []; let reverse = true
    await page.route('**/api/v1/trips/analyze', route => {
        const value = route.request().postDataJSON(); calls.push(value)
        const response = carResponse(value)
        response.results.forEach((r, i) => { const coords = i === 0 ? common : [...common, [goals[i].point.lon, goals[i].point.lat]]; r.route.geometry.coordinates = reverse && value.start.lon === places.b.lon ? [...coords].reverse() : coords })
        return route.fulfill({ json: response })
    })
    for (const [width,height] of [[1440,900],[390,844],[320,740]]) {
        reverse = width !== 390
        await page.setViewportSize({ width,height }); await page.goto(root); await page.reload()
        await homeScreen(page, 'Карта')
        const map = page.locator('.placelens-map'), tools = page.getByLabel('Показ целей', { exact: true })
        await expect.poll(async () => { try { return (await state(page)).data.features.filter(f => f.properties.kind === 'route').length } catch { return 0 } }).toBe(6)
        await tools.getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
        await expect.poll(() => page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return m.loaded() && !m.isMoving() })).toBe(true)
        const before = await state(page), count = calls.length
        const routes = before.data.features.filter(f => f.properties.kind === 'route')
        expect(routes.filter(f => f.properties.routeSide === 'left')).toHaveLength(3)
        expect(routes.filter(f => f.properties.routeSide === 'right')).toHaveLength(3)
        const rightCoordinates = routes.find(f => f.properties.routeSide === 'right').geometry.coordinates
        expect(routes.find(f => f.properties.routeSide === 'left').geometry.coordinates).toEqual(reverse ? [...rightCoordinates].reverse() : rightCoordinates)
        for (const zoom of [12,13]) {
            await page.evaluate(zoom => window.__smokeMapIn('.placelens-map').jumpTo({ center: [92.895,56.03], zoom }), zoom)
            await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.placelens-map').loaded())).toBe(true)
            // Real canvas hit on the shared section, all six identities must remain available.
            const hits = await page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return m.queryRenderedFeatures(m.project([92.895,56.0275]), { layers: ['trip-path-casing'] }).map(f => f.properties.routeKey) })
            expect(new Set(hits).size).toBe(6)
            if (width !== 320) await page.screenshot({ path: `experiments/placelens-visual/screenshots/v3-overlap-${width}-z${zoom}.png` })
        }
        const picked = new Set()
        for (let i = 0; i < 6; i++) {
            const point = await page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'), p = m.project([92.895,56.0275]), r = m.getCanvas().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y } })
            await page.mouse.click(point.x, point.y)
            const dialog = page.getByRole('dialog', { name: 'Результат на карте', exact: true })
            await expect(dialog).toBeVisible()
            const selectedRoutes = (await state(page)).data.features.filter(f => f.properties.kind === 'route' && f.properties.selected)
            expect(selectedRoutes).toHaveLength(1); picked.add(selectedRoutes[0].properties.routeKey)
            await dialog.getByRole('button', { name: 'Закрыть', exact: true }).press('Enter')
        }
        expect(picked.size).toBe(6)
        await tools.getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
        await expect(map.locator('.city-trip-marker.is-goal')).toHaveCount(3)
        for (let i = 0; i < 3; i++) {
            await map.locator('.city-trip-marker.is-goal').nth(i).press('Enter')
            const dialog = page.getByRole('dialog', { name: 'Результат на карте', exact: true })
            for (const side of ['А','Б']) { await dialog.getByRole('button', { name: `Поездка ${side}`, exact: true }).press('Enter'); await expect(dialog).toContainText(`${side} →`) }
            await dialog.getByRole('button', { name: 'Закрыть', exact: true }).press('Enter')
        }
        await tools.getByRole('button', { name: 'Одна цель', exact: true }).press('Enter')
        await expect.poll(async () => (await state(page)).data.features.filter(f => f.properties.kind === 'route').length).toBe(2)
        const selected = await state(page)
        for (const theme of ['Тёмная','Светлая']) {
            await map.getByRole('button', { name: theme, exact: true }).press('Enter')
            await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.placelens-map').getLayer('trip-paths-right'))).toBe(true)
            expect(await state(page)).toEqual(selected)
        }
        if (width !== 320) await page.screenshot({ path: `experiments/placelens-visual/screenshots/v3-selected-${width}.png` })
        for (const name of ['Приблизить','Отдалить','Светлая']) { const button = map.getByRole('button', { name, exact: true }); await button.focus(); await expect(button).toBeInViewport({ ratio: 1 }) }
        expect(calls).toHaveLength(count)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
})
