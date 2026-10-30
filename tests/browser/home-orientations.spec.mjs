import { test, expect } from './support.mjs'
import { places, profile } from './fixtures.mjs'
import { carResponse } from './fixtures/home-trips.mjs'
const selection = { version: 1, mode: 'driving', places: [
    { id: 'work', label: 'Работа', point: { lon: 92.91, lat: 56.03 } },
    { id: 'family', label: 'Семья', point: { lon: 92.90, lat: 56.04 } },
    { id: 'study', label: 'Учёба', point: { lon: 92.92, lat: 56.05 } },
], roads: {} }
const root = value => '/?' + new URLSearchParams({ left: places.a.id, right: places.b.id, radius_m: '500' }) + '#' + new URLSearchParams({ places: JSON.stringify(value ?? selection) })
const row = (page, id = 'work') => page.locator(`.home-result-table [data-goal-id="${id}"]`)
const editor = page => page.getByRole('region', { name: 'Редактор поездок', exact: true })
const dialog = page => page.getByRole('dialog', { name: /Личный ориентир/ })
const input = page => dialog(page).getByRole('textbox', { name: 'Модельное время, минуты' })
async function setup(page, { held = false, unknown = false } = {}) {
    await page.addInitScript(() => localStorage.setItem('placelens:interface:v1', 'workspace'))
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} } } }))
    const calls = []; let release
    const wait = new Promise(resolve => { release = resolve })
    await page.route('**/api/v1/trips/analyze', async route => {
        const value = route.request().postDataJSON(); calls.push(value)
        if (held) await wait
        const response = carResponse(value)
        response.results.forEach((result, index) => {
            result.route.duration_s = value.start.lon === places.a.lon ? 960 : 1380
            if (unknown && index === 2 && value.start.lon === places.b.lon) Object.assign(result, { status: 'UNKNOWN', route: null, snaps: null, reason: 'Данные о пути неизвестны.', metrics: { distance: { value: null }, duration: { value: null } } })
        })
        await route.fulfill({ json: response })
    })
    return { calls, release }
}
async function edit(page, locator, value) {
    await locator.press('Enter'); await expect(dialog(page)).toBeVisible(); await input(page).fill(value)
}
async function mapState(page) {
    return page.evaluate(async () => {
        const map = window.__smokeMapIn('.placelens-map')
        const overlays = []
        for (const [id, source] of Object.entries(map?.getStyle().sources ?? {})) if (id.includes('trip')) overlays.push([id, await map.getSource(id).getData()])
        return { overlays, center: map?.getCenter().toArray(), zoom: map?.getZoom() }
    })
}

test('live orientation, raw values, validation, removal, delayed accent and exact focus without requests/history/camera changes', async ({ page, api }) => {
    const h = await setup(page); await page.goto(root())
    await expect(row(page).locator('.home-cell-value').first()).toHaveText('около 16 мин')
    await expect(page.locator('[data-orientation-status]')).toHaveCount(0)
    const open = row(page).getByRole('button', { name: 'Личный ориентир: Работа', exact: true })
    await edit(page, open, '20')
    const preview = dialog(page).getByRole('region', { name: 'Живая сводка' })
    await expect(preview).toContainText('А · около 16 мин'); await expect(preview).toContainText('Б · около 23 мин')
    await expect(preview.locator('[data-orientation-status=within]')).toHaveCount(1)
    await expect(preview.locator('[data-orientation-status=over]')).toHaveCount(1)
    await expect(dialog(page)).toContainText('Ориентиры действуют в этом сеансе и не входят в ссылку')
    await page.keyboard.press('Escape'); await expect(open).toBeFocused()
    // First prepare an accepted baseline, then cross the boundary during a long edit.
    await open.press('Enter')
    const url = page.url(), history = await page.evaluate(() => history.length), state = await mapState(page)
    const originals = await row(page).locator('.home-cell-value').allTextContents()
    await input(page).fill('25')
    await expect(preview.locator('[data-orientation-status=within]')).toHaveCount(2)
    await input(page).fill('-5'); await expect(input(page)).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog(page).getByRole('alert')).toContainText('положительное')
    await expect(preview).toContainText('Ориентир 25 мин')
    await input(page).fill('25')
    await page.waitForTimeout(6800)
    await expect(page.locator('.home-orientation-changed')).toHaveCount(0)
    await page.keyboard.press('Escape'); await expect(open).toBeFocused()
    await expect(row(page).locator('td[data-side=right] .home-orientation-changed')).toHaveCount(1)
    await expect(row(page).locator('td[data-side=left] .home-orientation-changed')).toHaveCount(0)
    await expect(page.locator('p[aria-live=polite][aria-atomic=true]')).toContainText('Б: ✓ В ориентире')
    expect(h.calls).toHaveLength(2); expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(history)
    expect(await mapState(page)).toEqual(state); expect(await row(page).locator('.home-cell-value').allTextContents()).toEqual(originals)
    await edit(page, open, '26'); await dialog(page).getByRole('button', { name: 'Готово', exact: true }).press('Enter')
    await expect(page.locator('.home-orientation-changed')).toHaveCount(0)
    await open.press('Enter'); await dialog(page).getByRole('button', { name: 'Снять ориентир', exact: true }).press('Enter')
    await expect(input(page)).toHaveValue(''); await expect(preview).toContainText('Ориентир не задан')
    await page.keyboard.press('Escape'); await expect(row(page).locator('[data-orientation-status]')).toHaveCount(0)
})

test('controlled request completes into new threshold with no false first-result accent', async ({ page, api }) => {
    const h = await setup(page, { held: true }); await page.goto(root())
    await expect.poll(() => h.calls.length).toBe(2)
    const open = editor(page).getByRole('button', { name: 'Личный ориентир: Работа', exact: true })
    await edit(page, open, '15')
    await expect(dialog(page).getByRole('region', { name: 'Живая сводка' })).toContainText('Расчёт выполняется')
    await input(page).fill('20'); h.release()
    await expect(dialog(page).locator('[data-orientation-status=within]')).toHaveCount(1)
    await expect(dialog(page).locator('[data-orientation-status=over]')).toHaveCount(1)
    await page.keyboard.press('Escape'); await expect(open).toBeFocused()
    await expect(page.locator('.home-orientation-changed')).toHaveCount(0)
    await expect(page.locator('p[aria-live=polite][aria-atomic=true]')).toBeEmpty()
    expect(h.calls).toHaveLength(2)
})

test('session settings survive tabs/interface/radius, links omit them, restore and reload reset goal settings', async ({ page, api }) => {
    const h = await setup(page); await page.goto(root())
    await expect(row(page).locator('.home-cell-value').first()).toHaveText('около 16 мин')
    const open = editor(page).getByRole('button', { name: 'Личный ориентир: Работа', exact: true })
    await edit(page, open, '20'); await page.keyboard.press('Escape')
    const stop = page.locator('[data-metric-id="transport:nearest_stop_distance"]')
    await stop.getByRole('button', { name: 'Личный ориентир: Ближайшая остановка', exact: true }).press('Enter')
    const meters = dialog(page).getByRole('textbox', { name: 'Прямое расстояние, метры' })
    await meters.fill('150'); await expect(dialog(page).locator('[data-orientation-status=within]')).toHaveCount(2)
    await page.keyboard.press('Escape')
    const tabs = page.getByRole('tablist', { name: 'Раздел результатов', exact: true })
    await tabs.getByRole('tab', { name: 'Данные', exact: true }).press('Enter')
    await open.press('Enter'); await expect(input(page)).toHaveValue('20'); await page.keyboard.press('Escape')
    await expect(tabs.getByRole('tab', { name: 'Данные', exact: true })).toHaveAttribute('aria-selected', 'true')
    await tabs.getByRole('tab', { name: 'Обзор', exact: true }).press('Enter')
    const ui = page.getByRole('group', { name: 'Интерфейс', exact: true })
    await ui.getByRole('button', { name: 'Текущий', exact: true }).press('Enter'); await ui.getByRole('button', { name: 'Новый', exact: true }).press('Enter')
    await expect(open).toContainText('20 мин')
    await page.getByRole('button', { name: '300 м', exact: true }).press('Enter')
    await expect(open).toContainText('20 мин'); await expect(stop.locator('[data-orientation-status=within]')).toHaveCount(2)
    expect(h.calls).toHaveLength(2); await expect(row(page).locator('.home-cell-value').first()).toHaveText('около 16 мин')
    await page.getByText('Поделиться', { exact: true }).press('Enter')
    await expect(page.getByLabel('Поделиться сравнением', { exact: true })).toContainText('Ориентиры действуют в этом сеансе и не входят в ссылку')
    expect(new URL(page.url()).hash).not.toContain('orientation')
    const foreign = structuredClone(selection); foreign.places[0].point.lon = 92.93
    await page.evaluate(url => { history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate')) }, root(foreign))
    await expect(open).toContainText('Задать ориентир')
    await page.goBack(); await expect(open).toContainText('Задать ориентир')
    await edit(page, open, '30'); await page.keyboard.press('Escape')
    await page.reload(); await expect(open).toContainText('Задать ориентир')
    await expect(stop.getByRole('button', { name: 'Личный ориентир: Ближайшая остановка', exact: true })).toContainText('Задать ориентир')
})

test('editor isolates modes and standalone scenario; rename and point edits keep the same goal setting', async ({ page, api }) => {
    const h = await setup(page); await page.goto(root())
    await expect(row(page).locator('.home-cell-value').first()).toHaveText('около 16 мин')
    const open = editor(page).getByRole('button', { name: 'Личный ориентир: Работа', exact: true })
    await edit(page, open, '20'); await page.keyboard.press('Escape')
    const mode = editor(page).getByRole('combobox', { name: 'Общий режим поездок' })
    await mode.selectOption('walking'); await open.press('Enter'); await expect(input(page)).toHaveValue('')
    await input(page).fill('9'); await page.keyboard.press('Escape')
    await mode.selectOption('driving'); await open.press('Enter'); await expect(input(page)).toHaveValue('20'); await page.keyboard.press('Escape')
    await editor(page).getByRole('textbox', { name: 'Название общей цели', exact: true }).first().fill('Работа рядом')
    const renamed = editor(page).getByRole('button', { name: 'Личный ориентир: Работа рядом', exact: true })
    await expect(renamed).toContainText('20 мин')
    const pointEditor = editor(page).locator('.goal-editor').first().locator('.goal-point-editor')
    await pointEditor.locator(':scope > summary').press('Enter'); await pointEditor.getByRole('button', { name: 'Убрать точку', exact: true }).press('Enter')
    await expect(renamed).toContainText('20 мин'); await expect(row(page)).toContainText('Нужен расчёт этой поездки')
    await page.getByRole('group', { name: 'Сценарий', exact: true }).getByRole('button', { name: 'Отдельная поездка', exact: true }).press('Enter')
    const standaloneOpen = editor(page).getByRole('button', { name: /^Личный ориентир:/ })
    await standaloneOpen.press('Enter'); await expect(input(page)).toHaveValue('')
    await input(page).fill('30'); await expect(dialog(page)).toContainText('Самостоятельный старт')
    await page.keyboard.press('Escape'); await expect(standaloneOpen).toBeFocused(); await expect(standaloneOpen).toContainText('30 мин')
    await page.getByRole('group', { name: 'Сценарий', exact: true }).getByRole('button', { name: 'Адреса', exact: true }).press('Enter')
    await expect(renamed).toContainText('20 мин'); expect(h.calls).toHaveLength(2)
})

test('unknown and profile limitations remain explicit in orientation summary', async ({ page, api }) => {
    await setup(page, { unknown: true })
    await page.route('**/api/v1/addresses/*/profile?*', route => {
        const place = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)) === places.b.id ? places.b : places.a
        const value = profile(place)
        if (place === places.b) { const metric = value.blocks.transport.data.metrics.nearest_stop_distance; metric.value = null; metric.quality = { ...metric.quality, availability: 'INSUFFICIENT_DATA', reason: 'Охват остановок неизвестен.' } }
        return route.fulfill({ json: value })
    })
    await page.goto(root()); await expect(row(page, 'study')).toContainText('Путь неизвестен')
    await edit(page, row(page, 'study').getByRole('button', { name: 'Личный ориентир: Учёба', exact: true }), '20')
    await expect(dialog(page)).toContainText('Данные о пути неизвестны.')
    await expect(dialog(page).locator('[data-orientation-status=unavailable]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await page.locator('[data-metric-id="transport:nearest_stop_distance"]').getByRole('button', { name: 'Личный ориентир: Ближайшая остановка', exact: true }).press('Enter')
    await dialog(page).getByRole('textbox', { name: 'Прямое расстояние, метры' }).fill('250')
    await expect(dialog(page)).toContainText('Охват остановок неизвестен.')
    await expect(dialog(page).locator('[data-orientation-status=unavailable]')).toHaveCount(1)
})

test('orientation filled examples and dialog fit exact desktop and short phone viewports', async ({ page, api }, testInfo) => {
    test.skip(testInfo.project.name !== 'short-desktop', 'Exact viewport visual pass uses one coordinated browser project')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await setup(page, { unknown: true }); await page.goto(root())
    await expect(row(page).locator('.home-cell-value').first()).toHaveText('около 16 мин')
    for (const id of ['work', 'family', 'study']) {
        await edit(page, row(page, id).getByRole('button', { name: `Личный ориентир: ${id === 'work' ? 'Работа' : id === 'family' ? 'Семья' : 'Учёба'}`, exact: true }), '20')
        await page.keyboard.press('Escape')
    }
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 390, height: 480 }, { width: 320, height: 740 }]) {
        await page.setViewportSize(viewport)
        await page.locator('.home-result-tools').scrollIntoViewIfNeeded()
        if (viewport.width < 768) await page.locator('.home-result-tools').evaluate(node => {
            const root = node.closest('.placelens-workspace'), dock = root.querySelector('.home-mobile-views')
            root.scrollTop += node.getBoundingClientRect().top - root.getBoundingClientRect().top - dock.getBoundingClientRect().height
        })
        await page.screenshot({ path: `data/reports/interface-g42a-2026-10-30/comparison-${viewport.width}x${viewport.height}.png` })
        const open = row(page).getByRole('button', { name: 'Личный ориентир: Работа', exact: true })
        await open.press('Enter'); await input(page).fill('21')
        await page.screenshot({ path: `data/reports/interface-g42a-2026-10-30/field-${viewport.width}x${viewport.height}.png` })
        const bounds = await dialog(page).boundingBox()
        expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await input(page).scrollIntoViewIfNeeded(); await expect(input(page)).toBeInViewport()
        const fieldBox = await input(page).boundingBox(), bodyBox = await dialog(page).locator('.home-orientation-body').boundingBox()
        expect(fieldBox.y).toBeGreaterThanOrEqual(bodyBox.y); expect(fieldBox.y + fieldBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height)
        await dialog(page).getByRole('region', { name: 'Живая сводка' }).scrollIntoViewIfNeeded()
        await expect(dialog(page).getByRole('button', { name: 'Готово', exact: true })).toBeInViewport()
        await page.screenshot({ path: `data/reports/interface-g42a-2026-10-30/dialog-${viewport.width}x${viewport.height}.png` })
        await page.keyboard.press('Escape'); await expect(open).toBeFocused()
    }
})
