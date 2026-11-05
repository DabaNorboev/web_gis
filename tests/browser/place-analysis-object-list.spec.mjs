import { test, expect } from '@playwright/test'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'
import { pointReference } from '../frontend/fixtures/point-address-reference.mjs'

test('all categories, icons, numbered summaries and linked map selection', async ({ page }) => {
    let calls = 0
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: pointReference() }))
    await page.route('**/api/v1/place-analysis', route => {
        calls++
        const result = responseFor(route.request().postDataJSON(), { poi: 'READY' })
        if (result.blocks.poi) {
            const data = result.blocks.poi.data, original = data.items[0]
            data.items = [
                { ...original, id: 'osm:node:101', category: 'grocery', name: 'Магазин', address: 'улица Тестовая, 3', distance_m: 163.3972705 },
                { ...original, id: 'osm:node:102', name: 'Аптека', address: null, distance_m: 197.6636655 },
            ]
            data.items.push({ ...original, id: 'official-stop:3', category: 'official_stop', name: 'Остановка', distance_m: 240 })
            data.official_stop_summary = { found_count: 7, source_without_coordinates: 2 }
            result.blocks.poi.availability_by_category = Object.fromEntries(['grocery', 'pharmacy', 'official_stop', 'park'].map(c => [c, { status: 'READY', code: null, message: 'Fixture category ready' }]))
            result.blocks.poi.completeness.by_category.official_stop.status = 'PARTIAL'
            data.count = null
            data.counts_by_category = { grocery: 1, pharmacy: 1, official_stop: null, park: 0 }
        }
        return route.fulfill({ json: result })
    })
    await page.goto('/analysis')
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).focus()
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click()
    await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Готово')
    await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
    const filters = page.getByRole('group', { name: 'Категории объектов' })
    await expect(filters.locator('button svg')).toHaveCount(5)
    const all = filters.getByRole('button', { name: 'Все', exact: true })
    await all.click()
    await expect(all).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.pa-found-summary')).toHaveText('Объектов рядом: 9')
    await expect(page.locator('.pa-stop-found')).toHaveCount(0)
    await expect(page.getByText(/Покрытие категории:|Полнота категории:|Найдено записей в используемом наборе/)).toHaveCount(0)
    const rows = page.locator('.pa-objects > li')
    await expect(rows).toHaveCount(3)
    await expect(rows.locator('.pa-object__number')).toHaveText(['1', '2', '3'])
    await expect(rows.nth(0).locator('button small')).toHaveText('163 м по прямой · улица Тестовая, 3')
    await expect(rows.nth(1).locator('button small')).toHaveText('198 м по прямой')
    await expect(page.locator('.pa-map-marker')).toHaveCount(3)
    await rows.nth(0).getByRole('button').click()
    await expect(rows.nth(0).locator('button')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.pa-object-details')).toHaveCount(0)
    await expect(page.locator('.pa-map-marker[data-poi-id="osm:node:101"]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('.pa-map-marker[data-poi-id="osm:node:102"]').evaluate(el => el.click())
    await expect(all).toHaveAttribute('aria-pressed', 'true')
    await expect(rows.nth(1).locator('button')).toHaveAttribute('aria-pressed', 'true')
    await filters.getByRole('button', { name: 'Аптеки (1)', exact: true }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows.locator('.pa-object__number')).toHaveText('1')
    await expect(page.locator('.pa-map-marker')).toHaveCount(1)
    await all.click()
    await expect(rows).toHaveCount(3)
    expect(calls).toBe(3) // Filtering and selecting never reload blocks.
})
