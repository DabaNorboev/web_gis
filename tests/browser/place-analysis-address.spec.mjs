import { test, expect } from '@playwright/test'

const object = (id, lon, lat) => ({ id, lon, lat, object_type: 'building', point_method: 'point_on_surface', levels: '5',
    geometry: { type: 'Polygon', coordinates: [[[lon-.0002,lat-.0002],[lon+.0002,lat-.0002],[lon+.0002,lat+.0002],[lon-.0002,lat+.0002],[lon-.0002,lat-.0002]]] } })
const group = (name, lon, lat, ids) => ({ id: `address:${name}`, label: name, object_count: ids.length,
    bounds: [lon-.002, lat-.002, lon+.002, lat+.002], objects: ids.map((id, i) => object(id, lon+i*.001, lat)) })
const first = group('Синтетическая улица, 10', .4, .5, ['osm:way:1', 'osm:way:2'])
const second = group('Синтетическая улица, 12', 1.4, 1.5, ['osm:way:3'])
const map = page => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getSource('pa-address-preview')?.serialize().data)

test('address groups share a heading; typing pans to best result, hover and keyboard highlight exact buildings without selecting', async ({ page }) => {
    const calls = [], errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.route('**/api/v1/place-analysis', route => { calls.push(route.request().postDataJSON()); return route.abort() })
    await page.route('**/api/v1/addresses/search?**', route => route.fulfill({ json: { data: new URL(route.request().url()).searchParams.get('q')?.endsWith('12') ? [second] : [first, second] } }))
    await page.goto('/analysis')
    const search = page.getByRole('combobox', { name: 'Поиск адреса' })
    await search.focus()
    await expect(page.locator('.pa-suggestions')).toHaveCount(0)
    await expect(search).toHaveAttribute('aria-expanded', 'false')
    expect(await search.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none')
    await search.fill('Синтетическая 10')
    await expect(page.getByRole('option')).toHaveCount(3)
    await expect(page.getByText('Один адрес · 2 объекта', { exact: true })).toBeVisible()
    await expect(page.locator('.pa-address-group__title strong').first()).toHaveText(first.label)
    await expect.poll(async () => (await map(page))?.features.map(f => f.properties.id)).toEqual(['osm:way:1', 'osm:way:2'])
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getBounds().contains([.4, .5]))).toBe(true)
    await expect(page.locator('body')).not.toContainText('osm:way:')
    const titles = await page.locator('.pa-address-title').evaluateAll(elements => elements.map(el => {
        const css = getComputedStyle(el)
        return { size: css.fontSize, weight: css.fontWeight, color: css.color, x: el.getBoundingClientRect().x }
    }))
    expect(titles).toHaveLength(2)
    expect(titles[0]).toEqual(titles[1])
    const option = page.getByRole('option', { name: `${first.label} · Здание 2`, exact: true })
    await option.hover()
    await expect.poll(async () => (await map(page))?.features.filter(f => f.properties.highlighted).map(f => f.properties.id)).toEqual(['osm:way:2'])
    await expect(page.locator('.pa-address-marker[data-address-id="osm:way:2"]')).toHaveClass(/is-highlighted/)
    expect(calls).toEqual([])
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
    await search.focus(); await search.press('ArrowDown'); await search.press('ArrowDown')
    await page.mouse.move(0, 0)
    await expect.poll(async () => (await map(page))?.features.filter(f => f.properties.highlighted).map(f => f.properties.id)).toEqual(['osm:way:2'])
    await search.fill('Синтетическая 12')
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect.poll(async () => (await map(page))?.features.map(f => f.properties.id)).toEqual(['osm:way:3'])
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getBounds().contains([1.4, 1.5]))).toBe(true)
    expect(calls).toEqual([])
    await search.press('ArrowDown'); await search.press('Enter')
    await expect(search).toHaveValue(second.label)
    await expect(page.locator('.pa-address-marker')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeEnabled()
    await expect.poll(() => calls.length).toBe(3)
    expect(calls.every(r => r.place.address_id === 'osm:way:3')).toBe(true)
    expect(errors).toEqual([])
})

test('late address responses cannot restore a stale group preview; clear removes all previews', async ({ page }) => {
    let stale
    await page.route('**/api/v1/addresses/search?**', route => {
        if (route.request().url().includes('old')) { stale = route; return }
        return route.fulfill({ json: { data: [second] } })
    })
    await page.goto('/analysis')
    const search = page.getByRole('combobox', { name: 'Поиск адреса' })
    await search.fill('old'); await expect.poll(() => !!stale).toBe(true)
    await search.fill('new'); await expect(page.getByRole('option')).toHaveCount(1)
    try { await stale.fulfill({ json: { data: [first] } }) } catch { /* Old request may already be aborted. */ }
    await expect.poll(async () => (await map(page))?.features.map(f => f.properties.id)).toEqual(['osm:way:3'])
    await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click()
    await expect(page.locator('.pa-address-marker')).toHaveCount(0)
    await expect(page.locator('.pa-suggestions')).toHaveCount(0)
    await expect(search).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => (await map(page))?.features).toEqual([])
})

test('initial map has no selected pin; a singleton is a clickable address with optional floor subtitle and automatic analysis', async ({ page }) => {
    const calls = []
    const single = group('Синтетический проспект, 15', .4, .5, ['osm:way:15'])
    single.objects[0].levels = '15'
    const unknown = group('Синтетический проспект, 16', .41, .5, ['osm:way:16'])
    unknown.objects[0].levels = null
    await page.route('**/api/v1/addresses/search?**', route => route.fulfill({ json: { data: [single, unknown] } }))
    await page.route('**/api/v1/place-analysis', route => { calls.push(route.request().postDataJSON()); return route.abort() })
    await page.goto('/analysis')
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await expect(page.locator('.pa-map-pin, .pa-map-pending, .pa-map-radius-label')).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Поиск адреса' }).fill('Синтетический')
    const option = page.getByRole('option', { name: single.label, exact: true })
    await expect(option).toBeVisible()
    await expect(option.locator('small')).toHaveText('15 этажей')
    await expect(option.locator('.pa-address-number')).toHaveCount(0)
    await expect(page.getByRole('option', { name: unknown.label, exact: true }).locator('small')).toHaveCount(0)
    await expect(page.getByText('Один объект', { exact: true })).toHaveCount(0)
    for (const tab of await page.getByRole('tab').all()) await expect(tab).toBeDisabled()
    await option.click()
    for (const tab of await page.getByRole('tab').all()) await expect(tab).toBeEnabled()
    await expect.poll(() => calls.length).toBe(3)
    expect(calls.every(r => r.place.address_id === 'osm:way:15')).toBe(true)
    await expect(page.locator('.pa-map-pin')).toHaveCount(1)
    const gap = await page.locator('.pa-api-actions').evaluate(element => {
        const description = element.querySelector('p').getBoundingClientRect()
        const button = element.querySelector('.pa-api-actions__main > .pa-primary').getBoundingClientRect()
        return button.top - description.bottom
    })
    expect(gap).toBeGreaterThanOrEqual(8)
})
