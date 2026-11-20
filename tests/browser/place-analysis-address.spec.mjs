import { test, expect } from '@playwright/test'
import { fixtures, preview } from './support/geocoding.mjs'
import { candidate, envelope, id } from '../frontend/fixtures/geocoding.mjs'

test('keyboard candidate preview never selects a first result; Enter confirms only explicit position', async ({ page }) => {
    const f = await fixtures(page); await page.goto('/')
    const input = page.getByRole('combobox', { name: 'Поиск адреса' })
    await input.fill('Синтетическая 10')
    await expect(page.getByRole('option')).toHaveCount(1)
    expect(f.requests).toHaveLength(0)
    await input.press('ArrowDown'); await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Подтвердить положение', exact: true })).toBeFocused()
    expect(f.requests).toHaveLength(0)
    await page.keyboard.press('Enter')
    await expect.poll(() => f.requests.length).toBe(3)
    expect(f.requests.every(r => r.analysis_version === 2)).toBe(true)
})
test('editing cancels candidate confirmation and clear removes preview without changing selected results', async ({ page }) => {
    const f = await fixtures(page); await page.goto('/'); await preview(page)
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect.poll(() => f.requests.length).toBe(3)
    await preview(page)
    await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click()
    await expect(page.locator('.pa-map-pending')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Подтверждение адреса' })).toHaveCount(0)
    await expect(page.locator('[data-analysis-block="poi"]').getByRole('status')).toHaveText('Готово')
    expect(f.requests).toHaveLength(3)
})
test('late confirm from A cannot replace the selected point after draft changes', async ({ page }) => {
    const f = await fixtures(page); let stale
    await page.route('**/api/v1/geocoding/confirm', route => { stale = route })
    await page.goto('/'); await preview(page)
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect.poll(() => !!stale).toBe(true)
    await page.getByRole('combobox', { name: 'Поиск адреса' }).fill('Другой адрес')
    try { await stale.fulfill({ json: envelope(stale.request().postDataJSON(), f.selected) }) } catch { /* aborted transport */ }
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
    expect(f.requests).toHaveLength(0)
})
