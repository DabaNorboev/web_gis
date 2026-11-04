import { test as base, expect, chromium } from '@playwright/test'

// Optional prepared browser, as for storage checks: use only a disposable
// profile and loopback CDP endpoint, never the user's running browser.
const test = process.env.SEARCH_SHELL_CDP_URL ? base.extend({ browser: [async ({}, use) => {
    const browser = await chromium.connectOverCDP(process.env.SEARCH_SHELL_CDP_URL)
    try { await use(browser) } finally { await browser.close() }
}, { scope: 'worker' }] }) : base

test('P4.1 shell opens and reloads without analytics or persistence', async ({ page }, testInfo) => {
    const calls = [], errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', route => { calls.push(route.request().url()); return route.abort() })
    await page.goto('/search')
    await expect(page.getByRole('heading', { name: 'Условия', exact: true })).toBeVisible()
    await expect(page.getByRole('status')).toHaveText('Изменения пока не сохраняются')
    await expect(page.locator('.search-shell')).toHaveCSS('background-color', 'rgb(243, 245, 242)')
    await page.getByRole('button', { name: 'Уже есть варианты', exact: true }).press('Enter')
    await expect(page.getByRole('heading', { name: 'Адреса', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Адреса', exact: true })).toHaveAttribute('aria-current', 'page')
    await page.getByRole('button', { name: 'Условия', exact: true }).press('Enter')
    await expect(page.getByRole('heading', { name: 'Условия', exact: true })).toBeVisible()
    for (const name of ['Территория', 'Сравнение', 'Просмотр']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Рассчитать|Сохранить/ })).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Условия', exact: true })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'К содержимому' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('main')).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 })
    expect(calls).toEqual([])
    expect(errors).toEqual([])
    await testInfo.attach('search-shell', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
})
