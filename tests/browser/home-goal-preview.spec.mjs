import { test, expect, homeScreen } from './support.mjs'
import { ambiguousGroup, places } from './fixtures.mjs'

// Separated synthetic footprints make actual contours and map selection visible.
const previewGroup = { ...ambiguousGroup, bounds: [92.8698, 56.0098, 92.8722, 56.0107], object_count: 3,
    objects: ambiguousGroup.objects.slice(0, 3).map((object, index) => {
        const lon = 92.87 + index * .001, lat = 56.01 + (index === 1 ? .0005 : 0)
        return { ...object, lon, lat, geometry: { type: 'Polygon', coordinates: [[[lon - .00008, lat - .00005], [lon + .00008, lat - .00005], [lon + .00008, lat + .00005], [lon - .00008, lat + .00005], [lon - .00008, lat - .00005]]] } }
    }) }
const editor = page => page.getByRole('region', { name: 'Редактор поездок', exact: true })
const objects = page => page.evaluate(async () => (await window.__smokeMapIn('.placelens-map').getSource('transport-selection').getData()).features.filter(f => f.properties.kind === 'address-object'))
async function ready(page, pair = true) {
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} } } }))
    await page.route('**/api/v1/addresses/search?*', route => new URL(route.request().url()).searchParams.get('q')?.toLowerCase().includes('неоднознач')
        ? route.fulfill({ json: { data: [previewGroup], meta: { quality: {} } } }) : route.fallback())
    await page.goto(pair ? `/?left=${encodeURIComponent(places.a.id)}&right=${encodeURIComponent(places.b.id)}` : '/')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.placelens-map')?.loaded())).toBe(true)
    await homeScreen(page, 'Настройки')
}
async function add(page, name) {
    const index = await editor(page).locator('.goal-editor:visible').count()
    await editor(page).getByRole('button', { name: 'Добавить место', exact: true }).click()
    const card = editor(page).locator('.goal-editor:visible').nth(index)
    await card.getByLabel('Название места', { exact: true }).fill(name)
    return card
}
async function search(card) {
    const field = card.getByRole('combobox')
    await field.fill(ambiguousGroup.label)
    await expect(card.getByRole('option')).toHaveCount(1)
    await field.press('ArrowDown'); await field.press('Enter')
    return field
}
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`V2 goal geometry, keyboard highlight and explicit list/map selection ${viewport.width}`, async ({ page, api }) => {
        await page.setViewportSize(viewport)
        await ready(page)
        const originalUrl = page.url()
        const card = await add(page, 'Школа')
        await search(card)
        await expect(card).toContainText('Адрес не выбран')
        await expect.poll(async () => (await objects(page)).length).toBe(3)
        const feature = (await objects(page))[1]
        expect(feature.geometry).toEqual(previewGroup.objects[1].geometry)
        const first = card.getByRole('button', { name: /^Объект 1 ·/ })
        await page.mouse.move(0, 0); await first.focus(); await first.press('ArrowDown')
        await expect(card.getByRole('button', { name: /^Объект 2 ·/ })).toBeFocused()
        await expect.poll(async () => (await objects(page)).filter(f => f.properties.highlighted).map(f => f.properties.id)).toEqual([previewGroup.objects[1].id])
        expect((await objects(page)).some(f => f.properties.selected)).toBe(false)
        expect(page.url()).toBe(originalUrl)
        await page.keyboard.press('Enter')
        await expect(card.locator('.trip-confirmed')).toContainText('здание 2')
        await expect.poll(async () => (await objects(page)).find(f => f.properties.selected)?.properties.id).toBe(previewGroup.objects[1].id)
        // Clear the committed point, then choose a different actual polygon via the canvas.
        await card.getByRole('button', { name: 'Убрать точку', exact: true }).click()
        await card.getByRole('combobox').fill('Неоднозначная улица')
        await expect(card.getByRole('option')).toHaveCount(1)
        await card.getByRole('combobox').press('ArrowDown'); await card.getByRole('combobox').press('Enter')
        await homeScreen(page, 'Карта')
        await expect.poll(async () => (await objects(page)).length).toBe(3)
        const map = page.locator('.placelens-map canvas')
        // The fixture polygons overlap; object 3 has its own polygon.
        const target = await page.evaluate(() => {
            const m = window.__smokeMapIn('.placelens-map')
            m.jumpTo({ center: [92.872, 56.01], zoom: 18 })
            const p = m.project([92.872, 56.01]); return { x: p.x, y: p.y }
        })
        await expect.poll(() => page.evaluate(({ x, y }) => window.__smokeMapIn('.placelens-map').queryRenderedFeatures([x, y], { layers: ['address-contours'] }).map(f => f.properties.id), target)).toContain(previewGroup.objects[2].id)
        await map.click({ position: target })
        await homeScreen(page, 'Настройки')
        await expect(card.locator('.trip-confirmed')).toContainText('здание 3')
        await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.placelens-map').getCenter().toArray())).toEqual([previewGroup.objects[2].lon, previewGroup.objects[2].lat])
        expect(new URL(page.url()).searchParams.get('left')).toBe(places.a.id)
        expect(new URL(page.url()).searchParams.get('right')).toBe(places.b.id)
        expect(api.calls.filter(call => call.includes('/trips/'))).toHaveLength(0)
        if (viewport.width === 390) await homeScreen(page, 'Карта')
        await page.evaluate(() => window.__smokeMapIn('.placelens-map').fitBounds([[92.8698, 56.0098], [92.8722, 56.0107]], { padding: 80, maxZoom: 18, duration: 0 }))
        await expect.poll(async () => (await objects(page)).find(f => f.properties.selected)?.geometry.type).toBe('Polygon')
        await page.screenshot({ path: test.info().outputPath(`v2-selected-${viewport.width}.png`) })
        await homeScreen(page, 'Настройки')
        await card.getByRole('button', { name: 'Сохранить', exact: true }).click()
        await expect.poll(async () => (await objects(page)).length).toBe(0)
        await expect(page.locator('.home-address-slot').first()).toContainText('Адрес выбран')
        await expect(page.locator('.home-address-slot').nth(1)).toContainText('Адрес выбран')
    })
    test(`V2 goals before A/B and address editor takes preview ownership ${viewport.width}`, async ({ page, api }) => {
        await page.setViewportSize(viewport); await ready(page, false)
        const card = await add(page, 'Первая цель'); await search(card)
        await expect.poll(async () => (await objects(page)).length).toBe(3)
        await page.getByRole('button', { name: 'Добавить адрес А', exact: true }).click()
        const field = page.locator('.place-search').getByRole('combobox')
        await field.focus()
        await expect.poll(async () => (await objects(page)).length).toBe(0)
        await field.fill(places.a.label)
        await expect(page.locator('.place-search').getByRole('option')).toHaveCount(1)
        await field.press('ArrowDown'); await field.press('Enter')
        await homeScreen(page, 'Настройки')
        await expect(page.locator('.home-address-slot').first()).toContainText('Адрес выбран')
        await expect(card.getByRole('combobox')).toHaveValue(ambiguousGroup.label)
        await expect(card.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled()
        expect(api.calls.filter(call => call.includes('/trips/'))).toHaveLength(0)
    })
    test(`V2 preview owner, late answer, removal and scenario isolation ${viewport.width}`, async ({ page, api }) => {
        await page.setViewportSize(viewport); await ready(page)
        const card = await add(page, 'Первая'); await search(card)
        let started, release, finished
        const completed = new Promise(resolve => { finished = resolve })
        const requested = new Promise(resolve => { started = resolve })
        const gate = new Promise(resolve => { release = resolve })
        await page.route('**/api/v1/addresses/search?*', async route => {
            if (!new URL(route.request().url()).searchParams.get('q')?.includes('Поздний')) return route.fallback()
            started(); await gate; await route.fulfill({ json: { data: [previewGroup], meta: { quality: {} } } }); finished()
        })
        await card.getByRole('combobox').fill('Поздний ответ'); await requested
        const other = await add(page, 'Вторая')
        await expect.poll(async () => (await objects(page)).length).toBe(0)
        await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.placelens-map').isMoving())).toBe(false)
        const before = await page.evaluate(() => window.__smokeMapIn('.placelens-map').getCenter().toArray().map(n => +n.toFixed(8)))
        release(); await completed
        await expect.poll(async () => (await objects(page)).length).toBe(0)
        expect(await page.evaluate(() => window.__smokeMapIn('.placelens-map').getCenter().toArray().map(n => +n.toFixed(8)))).toEqual(before)
        await search(other); await expect.poll(async () => (await objects(page)).length).toBe(3)
        await other.getByRole('button', { name: 'Удалить общую цель Вторая', exact: true }).click()
        await expect.poll(async () => (await objects(page)).length).toBe(0)
        await search(card)
        await expect.poll(async () => (await objects(page)).length).toBe(3)
        await page.getByRole('button', { name: 'Рассчитать маршрут', exact: true }).click()
        await expect.poll(async () => (await objects(page)).length).toBe(0)
        const independent = editor(page).locator('.goal-editor:visible').first()
        await search(independent)
        await expect.poll(async () => (await objects(page)).length).toBe(3)
        await editor(page).getByRole('region', { name: 'Поиск и подпись: Точка старта', exact: true }).getByRole('combobox').focus()
        await expect.poll(async () => (await objects(page)).length).toBe(0)
        await page.getByRole('button', { name: 'Сравнение', exact: true }).click()
        await expect.poll(async () => (await objects(page)).length).toBe(0)
        expect(api.calls.filter(call => call.includes('/trips/'))).toHaveLength(0)
    })
}
