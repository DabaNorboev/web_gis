import { test, expect } from '@playwright/test'
import { candidate, selection, envelope, iso, id } from '../frontend/fixtures/geocoding.mjs'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

import { fixtures, point, preview } from './support/geocoding.mjs'

test('address preview is separate from selection; confirm uses v2 and shows attribution', async ({ page }, info) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    const f = await fixtures(page); await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click()
    const notice = 'Поиск через интернет (API Geoapify). Текст запроса передаётся сервису.'
    await expect(page.getByText(notice, { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Поиск адреса' })).toHaveAccessibleDescription(notice)
    await preview(page)
    expect(f.requests).toHaveLength(0)
    await expect(page.locator('.pa-map-pending')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect.poll(() => f.requests.length).toBe(3)
    expect(f.requests.every(r => r.analysis_version === 2 && r.place.selection_token && !r.place.address_id && !r.place.lon)).toBe(true)
    await expect(page.locator('[data-analysis-block="poi"]').getByRole('status')).toHaveText('Готово')
    const credit = { name: 'Powered by Geoapify', exact: true }
    await expect(page.getByRole('region', { name: 'Карта анализа' }).getByRole('link', credit)).toBeVisible()
    await expect(page.locator('.pa-sidebar-search').getByRole('link', credit)).toHaveCount(0)
    const inputBox = await page.getByRole('combobox', { name: 'Поиск адреса' }).boundingBox()
    const searchBox = await page.locator('.pa-sidebar-search').boundingBox()
    expect(inputBox.y).toBeGreaterThanOrEqual(searchBox.y)
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(searchBox.y + searchBox.height)
    const clearBox = await page.getByRole('button', { name: 'Очистить поиск', exact: true }).boundingBox()
    expect(clearBox.y).toBeGreaterThanOrEqual(inputBox.y)
    expect(clearBox.y + clearBox.height).toBeLessThanOrEqual(inputBox.y + inputBox.height)
    expect(await page.evaluate(() => [location.hash, Object.keys(localStorage).filter(k => /geocod|selection/i.test(k)), Object.keys(sessionStorage)])).toEqual(['', [], []])
    await expect(page.locator('body')).not.toContainText('SYNTHETIC_SELECTION')
    expect(errors).toEqual([])
    await page.screenshot({ path: info.outputPath('geocoding-selected.png'), fullPage: true })
})
test('a point uses v1; reverse is explicit and switching to address requires confirm', async ({ page }) => {
    const f = await fixtures(page); await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click(); await point(page)
    await expect.poll(() => f.requests.length).toBe(3); expect(f.calls).toHaveLength(0)
    const original = f.requests[0].place
    await page.getByRole('button', { name: 'Найти адрес поблизости', exact: true }).click()
    await page.getByRole('listbox').getByRole('option').first().click()
    await expect(page.getByText(/^Адрес поблизости:/)).toBeVisible()
    expect(f.requests).toHaveLength(3); expect(f.requests.every(r => r.place.lon === original.lon && r.analysis_version === undefined)).toBe(true)
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect.poll(() => f.requests.length).toBe(6)
})
test('street/number mismatch cannot confirm; failure keeps point analysis available', async ({ page }) => {
    const f = await fixtures(page, { candidateOverrides: { precision: { level: 'street', reason: null, accuracy_m: null, accuracy_reason: 'NOT_VALIDATED' },
        source: { ...candidate().source, provider_result_type: 'street' }, can_confirm: false, restrictions: ['HOUSE_REQUIRED'], candidate_token: null, expires_at: null } })
    await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click(); await preview(page)
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getZoom())).toBeGreaterThanOrEqual(15)
    const addressPreview = page.getByRole('region', { name: 'Подтверждение адреса' })
    await expect(addressPreview.getByText('Улица', { exact: true })).toBeVisible()
    await expect(addressPreview).not.toContainText('Синтетическая улица, 10')
    await expect(page.getByRole('button', { name: 'Подтвердить положение', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Уточнить свободную точку', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Выбранная точка' })).toContainText('Координаты:')
    await page.getByRole('button', { name: 'Анализировать точку', exact: true }).click()
    await expect.poll(() => f.requests.length).toBe(3); expect(f.requests.every(r => r.place.kind === 'point')).toBe(true)
})
test('provider unavailable is safe and never blocks independent point analysis', async ({ page }) => {
    const f = await fixtures(page, { lookupError: 'GEOCODING_UNAVAILABLE' }); await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click()
    await page.getByRole('combobox', { name: 'Поиск адреса' }).fill('Синтетическая')
    await expect(page.getByText('Адресный поиск недоступен.', { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('PRIVATE_CANARY')
    await point(page); await expect.poll(() => f.requests.length).toBe(3)
})
test('expired selection requires explicit reconfirm and does not repeat geocoding', async ({ page }) => {
    const f = await fixtures(page, { expired: true }); await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click(); await preview(page)
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Переподтвердить положение', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Переподтвердить положение', exact: true }).click()
    await expect.poll(() => f.calls.filter(c => c.op === 'reconfirm').length).toBe(1)
    await expect(page.locator('[data-analysis-block="poi"]').getByRole('status')).toHaveText('Готово')
    expect(f.calls.filter(c => c.op === 'search')).toHaveLength(1)
})
test('absolute seven-day expiry preserves ready results and requires a new choice without automatic exchange', async ({ page }) => {
    const f = await fixtures(page); await page.clock.install({ time: Date.now() }); await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click(); await preview(page)
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect(page.locator('[data-analysis-block="poi"]').getByRole('status')).toHaveText('Готово')
    await page.clock.fastForward(7 * 86400000 + 2000)
    await expect(page.getByText('Срок снимка истёк. Найдите и выберите адрес заново. Полученные результаты сохранены.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
    await expect(page.locator('[data-analysis-block="poi"]').getByRole('status')).toHaveText('Готово')
    expect(f.calls.filter(c => c.op === 'reconfirm')).toHaveLength(0)
})
test('absolute expiry during an in-flight block clears loading and rejects its late response', async ({ page }) => {
    const f = await fixtures(page, { expiresSoon: true }); await page.clock.install({ time: Date.now() }); await page.goto('/'); await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click(); await preview(page)
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    const poi = page.locator('[data-analysis-block="poi"]')
    await expect(poi.getByRole('status')).toHaveText('Готово')
    let pending
    await page.route('**/api/v1/place-analysis', route => { pending = route })
    await page.getByRole('button', { name: 'Обновить объекты', exact: true }).click()
    await expect.poll(() => !!pending).toBe(true)
    await page.clock.fastForward(10000)
    await expect(poi.getByRole('status')).toHaveText('Ошибка загрузки блока')
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
    const req = pending.request().postDataJSON(), response = responseFor({ ...req, place: { kind: 'point', ...f.selected.place.point } }, { poi: 'READY' })
    try { await pending.fulfill({ json: { ...response, analysis_version: 2, place: f.selected.place } }) } catch { /* aborted */ }
    await expect(poi.getByRole('status')).toHaveText('Ошибка загрузки блока')
})

test('empty Geoapify search offers focused recovery without replacing the analyzed point', async ({ page }) => {
    const f = await fixtures(page)
    let lookups = 0
    await page.route('**/api/v1/geocoding/search', route => {
        lookups++
        return route.fulfill({ json: envelope(route.request().postDataJSON(), { status: 'EMPTY', reason: 'NO_RESULTS', candidates: [] }) })
    })
    await page.goto('/')
    await point(page)
    const ready = page.locator('[data-analysis-block="poi"]').getByRole('status')
    await expect(ready).toHaveText('Готово')
    await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click()
    const query = page.getByRole('combobox', { name: 'Поиск адреса' })
    await query.fill('Несуществующая улица 5')
    const feedback = page.locator('.pa-search-feedback')
    await expect(feedback.getByRole('status')).toHaveText('Адреса не найдены.')
    await expect(feedback.getByRole('button', { name: 'Выбрать точку', exact: true })).toBeInViewport({ ratio: 0.98 })
    await feedback.getByRole('button', { name: 'Уточнить адрес' }).press('Enter')
    await expect(query).toBeFocused()
    await expect(query).toHaveValue('Несуществующая улица 5')
    await feedback.getByRole('button', { name: 'Выбрать точку', exact: true }).press('Enter')
    await expect(page.locator('.pa-map')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(ready).toHaveText('Готово')
    await expect(query).toHaveValue('Несуществующая улица 5')
    expect(f.requests).toHaveLength(3)
    expect(lookups).toBe(1)
})

test('Geoapify retry reopens suggestions and distinguishes a weak duplicate', async ({ page }) => {
    await fixtures(page)
    const house = candidate()
    const weak = { ...house, candidate_id: '12345678-1234-4234-8234-123456789013', provider_id: 'weak-house',
        point: { lon: .45, lat: .55 }, number_match: 'MISMATCH', can_confirm: false, restrictions: ['NUMBER_MISMATCH'],
        candidate_token: null, expires_at: null }
    let lookups = 0
    await page.route('**/api/v1/geocoding/search', route => {
        const request = route.request().postDataJSON()
        if (++lookups === 1) return route.fulfill({ status: 504, json: { code: 'PROVIDER_TIMEOUT', request_id: request.request_id, retry_after_s: null } })
        return route.fulfill({ json: envelope(request, { status: 'OK', reason: null, candidates: [house, weak] }) })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Поиск: локальный', exact: true }).click()
    const query = page.getByRole('combobox', { name: 'Поиск адреса' })
    await query.fill('Синтетическая улица 10')
    await expect(page.getByText('Время ожидания истекло.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Повторить поиск', exact: true }).press('Enter')
    await expect(query).toBeFocused()
    await expect(page.getByRole('listbox').getByRole('option', { name: /Вариант 1/ })).toContainText('Дом')
    await expect(page.getByRole('listbox').getByRole('option', { name: /Вариант 2/ })).toContainText('Номер отличается')
    await expect(page.getByRole('listbox').getByRole('option', { name: /Вариант 2/ })).toContainText('0.5500, 0.4500')
    expect(lookups).toBe(2)
})
