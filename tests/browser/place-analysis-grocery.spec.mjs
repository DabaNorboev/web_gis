import { test, expect } from '@playwright/test'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

async function choosePoint(page) {
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).focus()
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click()
}
function groceryResponse(request, mode = 'objects') {
    const response = responseFor(request, { poi: mode === 'error' ? 'ERROR' : 'READY' })
    if (!response.blocks.poi || mode === 'error') return response
    const block = response.blocks.poi, p = response.place.point
    block.method_version = 'synthetic-grocery-provider-fixture'
    block.coverage.status = mode === 'partial' ? 'PARTIAL' : 'UNKNOWN'
    block.coverage.by_category.grocery.status = mode === 'partial' ? 'PARTIAL' : 'COVERED'
    block.coverage.by_category.grocery.reason = mode === 'partial' ? 'Synthetic partial extraction coverage' : 'Synthetic covered extraction'
    for (const c of ['pharmacy', 'official_stop', 'park']) {
        block.coverage.by_category[c].status = 'UNKNOWN'
        block.coverage.by_category[c].reason = `Provider категории ${c} ещё не подключён (А8).`
    }
    block.completeness.status = 'UNKNOWN'
    for (const c of ['grocery', 'pharmacy', 'official_stop', 'park']) block.completeness.by_category[c] = { status: 'UNKNOWN', reason: 'Synthetic unknown completeness' }
    const common = { category: 'grocery', address: null, access: null, source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: null }
    const geometry = { type: 'Polygon', coordinates: [[[p.lon+.0005,p.lat-.0002],[p.lon+.025,p.lat-.0002],[p.lon+.025,p.lat+.0002],[p.lon+.0005,p.lat+.0002],[p.lon+.0005,p.lat-.0002]]] }
    block.data.items = mode === 'zero' ? [] : [
        { ...common, id: 'osm:node:100', name: 'Synthetic grocery point', geometry: { type: 'Point', coordinates: [p.lon,p.lat] }, point: p, distance_m: 0 },
        { ...common, id: 'osm:way:200', name: 'Synthetic grocery polygon', geometry, point: { lon: p.lon+.01275, lat: p.lat }, distance_m: 31 },
    ]
    block.data.count = null
    block.data.counts_by_category = { grocery: mode === 'partial' ? null : block.data.items.length, pharmacy: null, official_stop: null, park: null }
    return response
}

test('grocery source polygons and points share list/map selection; missing categories are not zeros', async ({ page }) => {
    let response
    await page.route('**/api/v1/place-analysis', route => { const r = groceryResponse(route.request().postDataJSON()); if (r.blocks.poi) response = r; return route.fulfill({ json: r }) })
    await page.goto('/analysis'); await choosePoint(page)
    await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Готово')
    await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Продукты (2)', exact: true })).toHaveClass(/is-active/)
    const row = page.getByRole('button', { name: 'Synthetic grocery polygon 31 м по прямой', exact: true })
    await row.click(); await expect(row).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.pa-map-marker[data-poi-id="osm:way:200"]')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map').getSource('pa-poi').serialize().data.features[0].geometry)).toEqual(response.blocks.poi.data.items[1].geometry)
    await expect.poll(() => page.locator('.pa-map-marker[data-poi-id="osm:way:200"]').evaluate(el => el.style.display)).not.toBe('none')
    await expect(page.locator('.pa-object-details')).toHaveCount(0)
    await page.getByRole('button', { name: 'Аптеки (—)', exact: true }).click()
    await expect(page.locator('.pa-found-summary').filter({ hasText: 'Показано объектов: 0. Данные загружены частично.' })).toBeVisible()
    await expect(page.getByText('Объектов рядом: 0', { exact: true })).toHaveCount(0)
    await expect(page.locator('.pa-map-marker')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map').getSource('pa-poi').serialize().data.features.length)).toBe(0)
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await page.locator('.pa-map').scrollIntoViewIfNeeded()
    await page.locator('.pa-map-marker[data-poi-id="osm:node:100"]').click()
    await expect(page.getByRole('button', { name: 'Synthetic grocery point 0 м по прямой', exact: true })).toHaveAttribute('aria-pressed', 'true')
    // Select the actual full source polygon through the map canvas, not its distant marker.
    await page.locator('.pa-map').scrollIntoViewIfNeeded()
    const hit = await page.evaluate(p => { const q = window.__smokeMapIn('.pa-map').project([p.lon+.003,p.lat]); return { x: q.x, y: q.y } }, response.place.point)
    await page.locator('.pa-map .maplibregl-canvas').click({ position: hit })
    await expect(row).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('dialog', { name: 'Выбранная точка' })).toHaveCount(0)
})

for (const mode of ['zero','partial','error']) {
    test(`grocery ${mode} state is distinct from unavailable categories`, async ({ page }) => {
        await page.route('**/api/v1/place-analysis', route => route.fulfill({ json: groceryResponse(route.request().postDataJSON(), mode) }))
        await page.goto('/analysis'); await choosePoint(page)
        await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
        if (mode === 'zero') {
            await expect(page.getByText('Объектов рядом: 0', { exact: true })).toBeVisible()
            await expect(page.getByRole('button', { name: 'Продукты (0)', exact: true })).toBeVisible()
        } else if (mode === 'partial') {
            await expect(page.getByRole('status').filter({ hasText: 'Показано объектов: 2. Данные загружены частично.' })).toBeVisible()
            await expect(page.getByRole('button', { name: 'Продукты (—)', exact: true })).toBeVisible()
            await expect(page.locator('.pa-objects > li')).toHaveCount(2)
        } else {
            await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Ошибка загрузки блока')
            await expect(page.locator('.pa-map-marker')).toHaveCount(0)
        }
    })
}
