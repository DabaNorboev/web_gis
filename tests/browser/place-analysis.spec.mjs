import { test, expect } from '@playwright/test'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'
import { pointReference } from '../frontend/fixtures/point-address-reference.mjs'

test('root is the only screen; retired URLs redirect, demo is gone and stored records are untouched', async ({ page }) => {
    await page.addInitScript(() => {
        if (!sessionStorage.getItem('single-ui-test-seeded')) {
            localStorage.setItem('synthetic-existing-record', 'SYNTHETIC_PRESERVE');
            sessionStorage.setItem('single-ui-test-seeded', 'yes');
        }
    })
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: pointReference() }))
    await page.route('**/api/v1/place-analysis', route => route.fulfill({ json: responseFor(route.request().postDataJSON(), { poi: 'READY' }) }))
    for (const url of ['/', '/analysis?demo=1', '/compare?left=osm:node:1', '/search', '/address/osm:node:1', '/trips?trip=SYNTHETIC_OLD#trip=SYNTHETIC_FRAGMENT', '/?demo=1']) {
        await page.goto(url)
        await expect(page.getByRole('heading', { name: 'Сначала выберите место', exact: true })).toBeVisible()
        expect(new URL(page.url()).pathname).toBe('/')
        await expect(page.locator('.pa-map-marker, .pa-map-station, .pa-map-pin')).toHaveCount(0)
        await expect(page.getByRole('link', { name: /демо/i })).toHaveCount(0)
        await expect(page.getByText('ДЕМО', { exact: false })).toHaveCount(0)
        expect(await page.evaluate(() => localStorage.getItem('synthetic-existing-record'))).toBe('SYNTHETIC_PRESERVE')
    }
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).focus()
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click()
    await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Готово')
    await page.getByRole('button', { name: 'Открыть объекты', exact: true }).click()
    await page.getByRole('button', { name: 'Все', exact: true }).click()
    await expect(page.locator('.pa-objects > li')).toHaveCount(1)
})

test('initial state explains selection and unlocks tabs only after a point is confirmed', async ({ page }) => {
    const requests = []
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: pointReference() }))
    await page.route('**/api/v1/place-analysis', route => {
        requests.push(route.request().postDataJSON())
        return route.fulfill({ json: responseFor(route.request().postDataJSON(), { poi: 'READY' }) })
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Сначала выберите место' })).toBeVisible()
    for (const tab of await page.getByRole('tab').all()) await expect(tab).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
    await expect(page.locator('[data-analysis-block]')).toHaveCount(0)
    expect(requests).toHaveLength(0)
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).focus()
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
    for (const tab of await page.getByRole('tab').all()) await expect(tab).toBeDisabled()
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Сначала выберите место' })).toHaveCount(0)
    for (const tab of await page.getByRole('tab').all()) await expect(tab).toBeEnabled()
    await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Объекты', exact: true })).toHaveAttribute('aria-selected', 'true')
})
