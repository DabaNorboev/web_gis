import { test, expect } from '@playwright/test'
import { fixtures, point } from './support/geocoding.mjs'
import { candidate, envelope } from '../frontend/fixtures/geocoding.mjs'

for (const reason of ['NO_RESULTS', 'OUTSIDE_SCOPE', 'NO_NEARBY_RESULTS']) {
    test(`${reason}: explicit empty reverse preserves point and ready analysis`, async ({ page }) => {
        const f = await fixtures(page)
        await page.route('**/api/v1/geocoding/reverse', route => {
            const r = route.request().postDataJSON()
            return route.fulfill({ json: envelope(r, { status: 'EMPTY', reason, point: { lon: r.lon, lat: r.lat }, candidates: [] }, null, 'NONE') })
        })
        await page.goto('/'); await point(page)
        await expect.poll(() => f.requests.length).toBe(3)
        await page.getByRole('button', { name: 'Найти адрес поблизости', exact: true }).click()
        await expect(page.getByText('Адреса не найдены. Можно выбрать точку на карте.', { exact: true })).toBeVisible()
        await expect(page.locator('[data-analysis-block="poi"]').getByRole('status')).toHaveText('Готово')
        expect(f.requests.every(r => r.place.kind === 'point' && !r.place.address_id)).toBe(true)
        expect(f.requests).toHaveLength(3)
    })
}
test('reverse failure and confirm failure preserve the point without exposing private error bodies', async ({ page }) => {
    const f = await fixtures(page, { confirmError: 'INVALID_SELECTION' }); await page.goto('/'); await point(page)
    await page.getByRole('button', { name: 'Найти адрес поблизости', exact: true }).click()
    await page.getByRole('option').first().click()
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect(page.getByText('Адресный поиск недоступен. Можно выбрать точку на карте.', { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('PRIVATE_CANARY')
    await expect(page.locator('[data-analysis-block="poi"]').getByRole('status')).toHaveText('Готово')
    expect(f.requests).toHaveLength(3)
})
test('late reverse for the previous point cannot show an old address or move the new point', async ({ page }) => {
    const f = await fixtures(page); let stale
    await page.route('**/api/v1/geocoding/reverse', route => { stale = route })
    await page.goto('/'); await point(page)
    await page.getByRole('button', { name: 'Найти адрес поблизости', exact: true }).click()
    await expect.poll(() => !!stale).toBe(true)
    await page.evaluate(() => window.__smokeMapIn('.pa-map').jumpTo({ center: [1, 1] }))
    await point(page)
    const r = stale.request().postDataJSON()
    try { await stale.fulfill({ json: envelope(r, { status: 'OK', reason: null, point: { lon: r.lon, lat: r.lat }, candidates: [{ ...candidate({ label: 'STALE REFERENCE' }), reference_distance_m: 1 }] }) }) } catch { /* aborted */ }
    await expect(page.locator('body')).not.toContainText('STALE REFERENCE')
    await expect.poll(() => f.requests.length).toBe(6)
    expect(f.requests[3].place).not.toEqual(f.requests[0].place)
    expect(f.requests.slice(3).every(r => JSON.stringify(r.place) === JSON.stringify(f.requests[3].place))).toBe(true)
})
