import { test, expect } from '@playwright/test'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

function retailResponse(request, pharmacyStatus = 'READY') {
    const response = responseFor(request, { poi: 'READY' })
    if (!response.blocks.poi) return response
    const block = response.blocks.poi, point = response.place.point
    const polygon = { type: 'Polygon', coordinates: [[[point.lon-.0002,point.lat-.0002],[point.lon+.0002,point.lat-.0002],[point.lon+.0002,point.lat+.0002],[point.lon-.0002,point.lat+.0002],[point.lon-.0002,point.lat-.0002]]] }
    const common = { name: null, address: null, access: null, source: 'OpenStreetMap', observed_at: null, source_updated_at: null, point, distance_m: 0 }
    block.data.items = [{ ...common, id: 'osm:node:100', category: 'grocery', name: 'Fixture grocery', dataset_import_id: 10, geometry: { type: 'Point', coordinates: [point.lon,point.lat] } }]
    if (pharmacyStatus === 'READY') block.data.items.push({ ...common, id: 'osm:way:200', category: 'pharmacy', name: 'Fixture pharmacy', dataset_import_id: 20, geometry: polygon, identity_note: 'Fixture possible duplicate; separate record' })
    block.data.count = null
    block.data.counts_by_category = { grocery: 1, pharmacy: pharmacyStatus === 'READY' ? 1 : null, official_stop: null, park: null }
    block.availability_by_category = {}
    for (const c of ['grocery','pharmacy','official_stop','park']) {
        const status = c === 'grocery' ? 'READY' : c === 'pharmacy' ? pharmacyStatus : 'UNAVAILABLE'
        block.availability_by_category[c] = { status, code: status === 'READY' ? null : status === 'ERROR' ? 'CATEGORY_CALCULATION_FAILED' : 'CATEGORY_PROVIDER_UNAVAILABLE', message: `Fixture ${c} ${status}` }
        block.coverage.by_category[c] = { status: status === 'READY' ? 'COVERED' : 'UNKNOWN', reason: `Fixture ${c} ${status}`, available_radius_m: null }
        block.completeness.by_category[c] = { status: 'UNKNOWN', reason: 'Fixture unknown completeness' }
    }
    return response
}

for (const pharmacyStatus of ['READY','UNAVAILABLE','ERROR']) {
    test(`pharmacy ${pharmacyStatus} preserves grocery and linked category map/list`, async ({ page }) => {
        await page.route('**/api/v1/place-analysis', route => route.fulfill({ json: retailResponse(route.request().postDataJSON(), pharmacyStatus) }))
        await page.goto('/analysis')
        await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
        await page.getByRole('button', { name: 'Точка на карте', exact: true }).focus()
        await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
        await page.getByRole('button', { name: 'Анализировать', exact: true }).click()
        await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Готово')
        await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Продукты (1)', exact: true })).toBeVisible()
        await page.getByRole('button', { name: pharmacyStatus === 'READY' ? 'Аптеки (1)' : 'Аптеки (—)', exact: true }).click()
        if (pharmacyStatus === 'READY') {
            const row = page.locator('.pa-objects [data-poi-id="osm:way:200"] > button')
            await row.click(); await expect(page.locator('.pa-map-marker[data-poi-id="osm:way:200"]')).toHaveAttribute('aria-pressed','true')
            await expect(page.getByText('Fixture possible duplicate; separate record')).toBeVisible()
            await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
            await page.locator('.pa-map-marker[data-poi-id="osm:way:200"]').click()
            await expect(row).toHaveAttribute('aria-pressed','true')
            await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map').getSource('pa-poi').serialize().data.features.some(f=>f.properties.id==='osm:way:200'))).toBe(true)
        } else {
            await expect(page.getByRole('status').filter({ hasText: pharmacyStatus === 'ERROR' ? 'Ошибка категории:' : 'Категория недоступна:' })).toBeVisible()
            await expect(page.locator('.pa-map-marker')).toHaveCount(0)
        }
        await page.getByRole('button', { name: 'Продукты (1)', exact: true }).click()
        await expect(page.locator('.pa-objects [data-poi-id="osm:node:100"]')).toBeVisible()
        await expect(page.locator('.pa-map-marker[data-poi-id="osm:node:100"]')).toHaveCount(1)
    })
}
