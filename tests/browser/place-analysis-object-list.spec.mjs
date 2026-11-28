import { openMapLayers } from './support/map-controls.mjs'
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
    await page.getByRole('button', { name: 'Анализировать точку', exact: true }).click()
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
    const panel = page.getByRole('tabpanel', { name: 'Объекты', exact: true })
    const settings = panel.getByRole('button', { name: 'Настроить категории', exact: true })
    await settings.press('Enter')
    await expect(settings).toHaveAttribute('aria-expanded', 'true')
    const categories = panel.getByRole('group', { name: 'Показывать категории POI' })
    const pharmacy = categories.getByRole('checkbox', { name: 'Аптеки', exact: true })
    const grocery = categories.getByRole('checkbox', { name: 'Продукты', exact: true })
    const stops = categories.getByRole('checkbox', { name: /Остановки/ })
    const parks = categories.getByRole('checkbox', { name: /Парки/ })
    await expect(settings).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(grocery).toBeFocused()
    await expect(categories.getByRole('checkbox', { checked: true })).toHaveCount(4)
    await page.locator('.pa-map-marker[data-poi-id="osm:node:102"]').evaluate(el => el.click())
    await pharmacy.uncheck()
    await parks.uncheck()
    await expect(rows).toHaveCount(2)
    await expect(rows.getByText('Аптека', { exact: true })).toHaveCount(0)
    await expect(page.locator('.pa-map-marker')).toHaveCount(2)
    await expect(rows.getByRole('button', { pressed: true })).toHaveCount(0)
    await page.getByRole('tab', { name: 'Обзор', exact: true }).click()
    await expect(page.locator('.pa-map-marker')).toHaveCount(2)
    await expect(categories).toHaveCount(0)
    await openMapLayers(page)
    await page.getByRole('button', { name: 'Категории POI', exact: true }).press('Enter')
    await expect(page.getByRole('region', { name: 'Легенда объектов' }).getByRole('checkbox')).toHaveCount(0)
    await expect(page.locator('.pa-card__counts')).toContainText('Аптеки')
    await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
    await expect(pharmacy).not.toBeChecked()
    await grocery.uncheck()
    await stops.uncheck()
    await expect(page.locator('.pa-found-summary')).toContainText('Все категории POI скрыты')
    await expect(page.locator('.pa-map-marker')).toHaveCount(0)
    await pharmacy.check()
    await expect(rows).toHaveCount(1)
    await expect(page.locator('.pa-map-marker[data-poi-id="osm:node:102"]')).toHaveCount(1)
    expect(calls).toBe(3) // Filtering and selecting never reload blocks.
})

test('schools and kindergartens appear in overview, list and map with independent filters', async ({ page }) => {
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: pointReference() }))
    await page.route('**/api/v1/place-analysis', route => {
        const result = responseFor(route.request().postDataJSON(), { poi: 'READY' })
        const block = result.blocks.poi
        if (block) {
            block.method_version = 'poi-v4-geography-source-geometry-education'
            const { data } = block
            for (const [category, name, id] of [
                ['school', 'Тестовая школа', 'osm:node:115'],
                ['kindergarten', 'Тестовый детский сад', 'osm:node:116'],
            ]) {
                data.items.push({ ...data.items[0], id, category, name })
                block.coverage.by_category[category] = block.coverage.by_category.park
                block.completeness.by_category[category] = block.completeness.by_category.park
                data.counts_by_category[category] = 1
                data.count++
            }
        }
        return route.fulfill({ json: result })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).press('Enter')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Анализировать точку', exact: true }).click()
    const overview = page.locator('.pa-card__counts')
    await expect(overview.getByText('Школы', { exact: true })).toBeVisible()
    await expect(overview.getByText('Детские сады', { exact: true })).toBeVisible()
    const school = page.locator('.pa-map-marker--school')
    const kindergarten = page.locator('.pa-map-marker--kindergarten')
    await expect(school).toHaveCount(1)
    await expect(kindergarten).toHaveCount(1)
    await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
    await page.getByRole('button', { name: 'Все', exact: true }).click()
    await expect(page.locator('.pa-objects')).toContainText('Тестовая школа')
    await expect(page.locator('.pa-objects')).toContainText('Тестовый детский сад')
    await page.getByRole('button', { name: 'Настроить категории', exact: true }).press('Enter')
    await page.getByRole('checkbox', { name: 'Школы', exact: true }).uncheck()
    await expect(school).toHaveCount(0)
    await expect(kindergarten).toHaveCount(1)
    await expect(page.locator('.pa-objects')).not.toContainText('Тестовая школа')
})
