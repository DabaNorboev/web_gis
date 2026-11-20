import { test, expect } from '@playwright/test'
import { fixtures, preview } from './support/geocoding.mjs'
import { candidate, envelope } from '../frontend/fixtures/geocoding.mjs'

test('keyboard candidate preview never selects a first result; Enter confirms only explicit position', async ({ page }) => {
    const f = await fixtures(page); await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click()
    const input = page.getByRole('combobox', { name: 'Поиск адреса' })
    await input.fill('Синтетическая 10')
    await expect(page.getByRole('option')).toHaveCount(1)
    expect(f.requests).toHaveLength(0)
    await input.press('ArrowDown'); await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Подтвердить положение', exact: true })).toBeFocused()
    expect(f.calls.map(({ op, req }) => [op, req.mode])).toEqual([['search', 'autocomplete']])
    expect(f.requests).toHaveLength(0)
    await page.keyboard.press('Enter')
    await expect.poll(() => f.requests.length).toBe(3)
    expect(f.requests.every(r => r.analysis_version === 2)).toBe(true)
})
test('Geoapify Enter searches the preserved query once after cancelling keyboard preview', async ({ page }) => {
    const f = await fixtures(page)
    await page.clock.install()
    await page.goto('/')
    await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click()
    const input = page.getByRole('combobox', { name: 'Поиск адреса' })
    const query = 'Синтетическая 10'
    await input.fill(query)
    await expect(page.getByRole('option')).toHaveCount(1)
    await input.press('ArrowDown')
    await input.press('Enter')
    await expect(page.getByRole('region', { name: 'Подтверждение адреса' })).toBeVisible()
    await page.getByRole('button', { name: 'Отмена выбора адреса' }).click()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(query)
    await expect(page.getByRole('option')).toHaveCount(0)
    await input.press('ArrowDown')
    await page.clock.fastForward(500)
    expect(f.calls).toHaveLength(1)
    await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/)

    await input.press('Enter')
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.clock.fastForward(500)
    expect(f.calls.map(({ op, req }) => [op, req.mode, req.q])).toEqual([
        ['search', 'autocomplete', query],
        ['search', 'search', query],
    ])
    await expect(page.getByRole('option', { selected: true })).toHaveCount(0)
})
test('editing cancels candidate confirmation and clear removes preview without changing selected results', async ({ page }) => {
    const f = await fixtures(page); await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click(); await preview(page)
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
    await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click(); await preview(page)
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect.poll(() => !!stale).toBe(true)
    await page.getByRole('combobox', { name: 'Поиск адреса' }).fill('Другой адрес')
    try { await stale.fulfill({ json: envelope(stale.request().postDataJSON(), f.selected) }) } catch { /* aborted transport */ }
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
    expect(f.requests).toHaveLength(0)
})

test('Geoapify keeps full numbers and distinguishes duplicate labels through keyboard preview and confirm', async ({ page }) => {
    const viewport = page.viewportSize()
    if (viewport.width <= 390) await page.setViewportSize({ width: viewport.width, height: viewport.width === 320 ? 568 : 640 })
    const base = candidate()
    const c = candidate({
        label: '660000, Синтетическая улица, 10/2А к3 стр4, Красноярск, Россия',
        components: { ...base.components, district: 'Условный район',
            number: { ...base.components.number, raw: '10/2А к3 стр4', key: '10/2а к3 стр4', fraction: '2', letter: 'А', corpus: '3', structure: '4' } },
    })
    const duplicate = { ...c, candidate_id: 'a2345678-1234-4234-8234-123456789012', candidate_token: 'SYNTHETIC_OTHER', point: { lon: .6, lat: .7 } }
    const f = await fixtures(page, { candidateOverrides: c })
    await page.route('**/api/v1/geocoding/search', route => route.fulfill({
        json: envelope(route.request().postDataJSON(), { status: 'OK', reason: null, candidates: [duplicate, c] }),
    }))
    await page.goto('/')
    await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click()
    const input = page.getByRole('combobox', { name: 'Поиск адреса' })
    const label = 'Синтетическая улица, 10/2А к3 стр4, Условный район'
    await input.fill('Синтетическая 10')
    await expect(page.getByRole('option')).toHaveText([label + ' · Вариант 1', label + ' · Вариант 2'])
    await input.press('ArrowUp')
    await input.press('Enter')
    const region = page.getByRole('region', { name: 'Подтверждение адреса' })
    await expect(region).toContainText(label + ' · Вариант 2')
    await expect(region).not.toContainText('0.5, 0.4')
    const confirm = region.getByRole('button', { name: 'Подтвердить положение', exact: true })
    await expect(confirm).toBeFocused()
    await expect(confirm).toBeInViewport()
    expect(await page.locator('.pa-sidebar-search').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    const help = page.getByText('Точность адреса', { exact: true })
    await expect(page.getByText(/Точность координат не измерена/)).toBeHidden()
    await help.click()
    await expect(page.getByText(/Точность координат не измерена/)).toBeVisible()
    await confirm.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('region', { name: 'Выбранный адрес' })).toHaveText(label)
    await expect(page.getByText(label, { exact: true })).toHaveCount(1)
    expect(f.calls.find(call => call.op === 'confirm').req.candidate_token).toBe(c.candidate_token)
    await expect.poll(() => f.requests.length).toBe(3)
})
