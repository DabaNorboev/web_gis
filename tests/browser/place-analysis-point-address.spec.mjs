import { test, expect } from '@playwright/test'
import { pointReference } from '../frontend/fixtures/point-address-reference.mjs'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

async function pickPoint(page, center) {
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    if (center) await page.evaluate(center => window.__smokeMapIn('.pa-map').jumpTo({ center }), center)
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).focus()
    await page.keyboard.press('Enter'); await expect(page.locator('.pa-map')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Выбранная точка' })).toBeVisible()
}
async function confirmPoint(page) {
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Выбранная точка' })).toHaveCount(0)
}
async function analysisApi(page) {
    const calls = []
    await page.route('**/api/v1/place-analysis', route => {
        const request = route.request().postDataJSON(); calls.push(request)
        return route.fulfill({ json: responseFor(request) })
    })
    return calls
}
const reference = page => page.getByRole('region', { name: 'Адрес-ориентир выбранной точки' })

test('nearest address is a bounded reference; precise point persists until explicit resolver-backed transition', async ({ page }) => {
    const calls = await analysisApi(page), lookups = [], resolutions = []
    await page.route('**/api/v1/addresses/resolve-point', route => {
        const request = route.request()
        lookups.push({ url: request.url(), method: request.method(), headers: request.headers(), point: request.postDataJSON() })
        return route.fulfill({ json: pointReference() })
    })
    const address = responseFor({ place: { kind: 'address', address_id: 'osm:way:1' } }).place.address
    await page.route(/\/api\/v1\/addresses\/osm(?:%3A|:)/, route => {
        resolutions.push(route.request().url())
        return route.fulfill({ json: { address, capabilities: { resolver_version: 1, selected_profile_version: 1 } } })
    })
    await page.goto('/analysis'); await pickPoint(page)
    await expect(reference(page)).toContainText('Ближайший адрес: Synthetic reference 1')
    const card = page.getByRole('dialog', { name: 'Выбранная точка' })
    await expect(card).not.toContainText('по прямой')
    await expect(card).not.toContainText('По доступным объектам')
    await expect(card).not.toContainText('Это ориентир, а не адрес')
    await expect(card).not.toContainText('Подтверждённая область')
    await expect(card).not.toContainText('Радиус:')
    expect(calls).toHaveLength(0); expect(resolutions).toHaveLength(0)
    await confirmPoint(page)
    await expect(reference(page)).toContainText('Ближайший адрес: Synthetic reference 1')
    await expect(reference(page)).not.toContainText('по прямой')
    await expect(reference(page)).not.toContainText('По доступным объектам')
    await expect(reference(page)).not.toContainText('Это ориентир, а не адрес')
    await expect(reference(page)).not.toContainText('Подтверждённая область')
    await expect.poll(() => calls.length).toBe(3)
    expect(lookups).toHaveLength(1)
    expect(lookups[0].method).toBe('POST'); expect(lookups[0].url).not.toContain('?')
    expect(lookups[0].headers.referer).toBeUndefined()
    expect(calls.every(r => r.place.kind === 'point' && r.place.lon === lookups[0].point.lon && r.place.lat === lookups[0].point.lat && !('address_id' in r.place))).toBe(true)
    await expect(page.locator('.pa-search__input')).toHaveValue('Точка на карте')
    await reference(page).getByRole('button', { name: 'Анализировать этот адрес', exact: true }).click()
    await expect.poll(() => resolutions.length).toBe(1)
    await expect.poll(() => calls.length).toBe(6)
    expect(calls.slice(3).every(r => r.place.kind === 'address' && r.place.address_id === 'osm:way:1' && !('lon' in r.place))).toBe(true)
    await expect(page.locator('.pa-search__input')).toHaveValue(address.label)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map').getSource('pa-radius').serialize().data)).toEqual({ type: 'Feature', properties: {}, geometry: responseFor(calls[3]).analysis_area })
    await expect(reference(page)).toHaveCount(0)
})

for (const scenario of ['none', 'outside', 'failure']) {
    test(`${scenario}: missing reference preserves point analysis and its generic label`, async ({ page }) => {
        const calls = await analysisApi(page)
        await page.route('**/api/v1/addresses/resolve-point', route => {
            if (scenario === 'failure') return route.fulfill({ status: 500, json: { message: 'PRIVATE_CANARY' } })
            const response = pointReference('NONE', [])
            if (scenario === 'outside') response.meta.coverage.status = 'OUTSIDE_SERVICE_AREA'
            return route.fulfill({ json: response })
        })
        await page.goto('/analysis'); await pickPoint(page); await confirmPoint(page)
        await expect.poll(() => calls.length).toBe(3)
        await expect(reference(page)).toContainText('Точка на карте')
        await expect(reference(page).getByRole('button', { name: 'Анализировать этот адрес', exact: true })).toHaveCount(0)
        expect(calls.every(r => r.place.kind === 'point' && !('address_id' in r.place))).toBe(true)
        await expect(page.locator('.pa-search__input')).toHaveValue('Точка на карте')
        await expect(page.locator('[data-analysis-block="poi"]')).toContainText('Данные недоступны')
        await expect(page.locator('body')).not.toContainText('PRIVATE_CANARY')
    })
}

test('a late label cannot replace the reference or analysis of another point', async ({ page }) => {
    const calls = await analysisApi(page); let first; const lookups = []
    await page.route('**/api/v1/addresses/resolve-point', route => {
        lookups.push(route.request().postDataJSON())
        if (lookups.length === 1) { first = route; return }
        const response = pointReference('NEARBY', ['osm:node:2']); response.data.candidates[0].label = 'Synthetic new point reference'
        return route.fulfill({ json: response })
    })
    await page.goto('/analysis'); await pickPoint(page); await confirmPoint(page)
    await expect.poll(() => calls.length).toBe(3)
    await pickPoint(page, [1, 1]); await confirmPoint(page)
    await expect(reference(page)).toContainText('Synthetic new point reference')
    try { await first.fulfill({ json: pointReference() }) } catch { /* Previous transport may already be aborted. */ }
    await expect(reference(page)).not.toContainText('Synthetic reference 1')
    await expect.poll(() => calls.length).toBe(6)
    expect(lookups).toHaveLength(2)
    expect(lookups[1]).not.toEqual(lookups[0])
    expect(calls.slice(3).every(r => r.place.kind === 'point' && r.place.lon === lookups[1].lon && r.place.lat === lookups[1].lat)).toBe(true)
    await expect(page.locator('.pa-search__input')).toHaveValue('Точка на карте')
})

test('resolver failure keeps the selected point and ready analysis independent', async ({ page }) => {
    const calls = await analysisApi(page)
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: pointReference() }))
    await page.route(/\/api\/v1\/addresses\/osm(?:%3A|:)/, route => route.fulfill({ status: 503, json: { code: 'ADDRESS_SOURCE_UNAVAILABLE', message: 'PRIVATE_CANARY' } }))
    await page.goto('/analysis'); await pickPoint(page); await confirmPoint(page)
    await expect.poll(() => calls.length).toBe(3)
    await reference(page).getByRole('button', { name: 'Анализировать этот адрес', exact: true }).click()
    await expect(reference(page)).toContainText('Анализ выбранной точки сохранён')
    await expect(page.locator('.pa-search__input')).toHaveValue('Точка на карте')
    expect(calls).toHaveLength(3)
    await expect(page.locator('body')).not.toContainText('PRIVATE_CANARY')
})
