import { test, expect } from './support.mjs'
import { places } from './fixtures.mjs'
import { carResponse } from './fixtures/home-trips.mjs'

// G4.1 desktop acceptance. Run this file in short-desktop; each case sets and
// records its actual viewport. Other home suites retain all four projects.
for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1280, height: 560 }]) {
    test(`desktop editor and filled A/B remain usable at ${viewport.width}x${viewport.height}`, async ({ page, api }) => {
        await page.setViewportSize(viewport)
        await page.addInitScript(() => localStorage.setItem('placelens:interface:v1', 'workspace'))
        const calls = []
        await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} } } }))
        await page.route('**/api/v1/trips/analyze', route => {
            const value = route.request().postDataJSON(); calls.push(value)
            return route.fulfill({ json: carResponse(value) })
        })
        await page.goto('/')
        await expect(page.getByRole('heading', { name: 'Места и цели', exact: true })).toBeVisible()
        await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.placelens-map')?.loaded())).toBe(true)
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: test.info().outputPath('empty.png'), fullPage: true })
        const selection = { version: 1, mode: 'driving', places: [
            { id: 'work', label: 'Работа', point: { lon: 92.91, lat: 56.03 } },
            { id: 'family', label: 'Семья', point: { lon: 92.90, lat: 56.02 } },
            { id: 'study', label: 'Учёба', point: { lon: 92.89, lat: 56.04 } },
        ], roads: {} }
        await page.goto('/?' + new URLSearchParams({ left: places.a.id, right: places.b.id, radius_m: '500' }) + '#' + new URLSearchParams({ places: JSON.stringify(selection) }))
        const editor = page.getByRole('region', { name: 'Редактор поездок', exact: true })
        const results = page.getByRole('region', { name: 'Поездки единого пространства', exact: true })
        await expect(results.getByRole('button', { name: 'Показать маршрут', exact: true })).toHaveCount(6)
        expect(calls).toHaveLength(2)
        expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([viewport.width, viewport.height])
        await expect(editor.locator('.trip-result')).toHaveCount(0)
        await expect(page.locator('.placelens-map canvas')).toHaveCount(1)
        await expect(page.locator('.placelens-map')).toBeVisible()
        const area = await page.locator('.home-results-area').boundingBox(), map = await page.locator('.placelens-map').boundingBox()
        expect(area.x).toBeGreaterThan(0); expect(area.y).toBeGreaterThanOrEqual(map.y + map.height - 1)
        expect(area.y + area.height).toBeLessThanOrEqual(viewport.height + 1)
        await expect(editor.getByRole('button', { name: 'Добавить общую цель', exact: true })).toHaveCount(0)
        const name = editor.getByLabel('Название общей цели', { exact: true }).first()
        await name.fill('Работа · черновик')
        const url = page.url(), historyLength = await page.evaluate(() => history.length)
        await page.getByRole('group', { name: 'Интерфейс', exact: true }).getByRole('button', { name: 'Текущий', exact: true }).press('Enter')
        await page.getByRole('group', { name: 'Интерфейс', exact: true }).getByRole('button', { name: 'Новый', exact: true }).press('Enter')
        await expect(name).toHaveValue('Работа · черновик')
        expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(historyLength); expect(calls).toHaveLength(2)
        const run = editor.getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true })
        await run.focus(); await expect(run).toBeInViewport()
        await page.screenshot({ path: test.info().outputPath('editor-run.png'), fullPage: true })
        await run.press('Enter')
        await expect.poll(() => calls.length).toBe(4)
        await expect(results.getByRole('button', { name: 'Показать маршрут', exact: true })).toHaveCount(6)
        // Return the editor to its beginning for a readable simultaneous A/B,
        // map and result capture. The run was reached through its own scroller.
        await page.locator('#home-panel').evaluate(node => { node.scrollTop = 0 })
        await expect.poll(() => page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return m?.loaded() && !m.isMoving() })).toBe(true)
        await page.evaluate(() => document.fonts.ready)
        const surface = await page.locator('.city-map-surface').boundingBox()
        for (const label of ['Приблизить', 'Отдалить']) {
            const control = page.getByRole('button', { name: label, exact: true })
            const rect = await control.boundingBox()
            expect(rect.y).toBeGreaterThanOrEqual(surface.y); expect(rect.y + rect.height).toBeLessThanOrEqual(surface.y + surface.height)
            await control.click()
        }
        const layers = page.getByRole('region', { name: 'Слои карты', exact: true })
        await layers.getByRole('button', { name: /^Слои/ }).click()
        await layers.getByRole('checkbox', { name: /Парки/ }).check()
        await layers.getByRole('button', { name: /^Слои/ }).press('Escape')
        await page.screenshot({ path: test.info().outputPath('filled-trips.png'), fullPage: true })
        await page.getByRole('tablist', { name: 'Раздел результатов', exact: true }).getByRole('tab', { name: 'Окружение', exact: true }).press('Enter')
        await expect(page.getByRole('heading', { name: 'Сравнение А/Б', exact: true })).toBeVisible()
        await expect.poll(() => page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return m?.loaded() && !m.isMoving() })).toBe(true)
        await page.screenshot({ path: test.info().outputPath('filled-pair.png'), fullPage: true })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect(calls).toHaveLength(4)
    })
}
