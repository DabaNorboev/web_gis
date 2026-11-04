import { test, expect } from '@playwright/test'

test('A6 first page keeps one shell and exposes the four states', async ({ page }, testInfo) => {
    const calls = [], errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', route => {
        calls.push(route.request().url())
        return route.abort()
    })

    await page.goto('/analysis')
    await expect(page.getByRole('heading', { name: 'Обзор', exact: true })).toBeVisible()
    await expect(page.locator('.pa-demo-badge')).toHaveText('Макет • условные данные')
    await expect(page.locator('.pa-map')).toBeVisible()
    await expect(page.locator('.pa-layers')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Обзор', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('R = 500 м')).toBeVisible()
    await expect(page.locator('.pa-map-marker')).toHaveCount(19)

    await page.getByRole('tab', { name: 'Объекты', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Объекты в радиусе 500 м', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Аптеки (3)', exact: true })).toBeVisible()
    await expect(page.locator('.pa-map-marker')).toHaveCount(3)
    await page.getByRole('button', { name: /Аптека «Пример»/ }).click()
    await expect(page.getByText('Часы работы: не указаны')).toBeVisible()

    await page.getByRole('tab', { name: 'Спутник', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Спутниковый анализ (NDVI)', exact: true })).toBeVisible()
    await expect(page.getByText('Пригодные данные: 72% круга')).toBeVisible()
    await expect(page.getByText('Штриховка показывает пропуски внутри анализируемого круга').or(page.getByText('Нет данных'))).toBeVisible()

    await page.getByRole('tab', { name: 'Воздух', exact: true }).click()
    await expect(page.getByText('Не удалось загрузить наблюдения')).toBeVisible()
    await page.getByRole('button', { name: /Повторить/ }).click()
    await expect(page.getByRole('heading', { name: 'Станция «Центр»', exact: true })).toBeVisible({ timeout: 5_000 })

    await page.locator('.pa-radius__number').fill('1000')
    await page.locator('.pa-radius__number').press('Tab')
    await expect(page.getByText('R = 1000 м')).toBeVisible()

    const canvas = page.locator('.pa-map .maplibregl-canvas')
    await expect(canvas).toBeVisible()
    await canvas.click({ position: { x: 420, y: 260 } })
    await expect(page.getByRole('dialog', { name: 'Выбранная точка' })).toBeVisible()
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click()
    await expect(page.locator('.pa-search__input')).toHaveValue('Точка на карте')

    expect(calls).toEqual([])
    expect(errors).toEqual([])
    await testInfo.attach('place-analysis', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
})
