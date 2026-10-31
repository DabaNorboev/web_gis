import { test, expect, homeScreen } from './support.mjs'
import { places } from './fixtures.mjs'
import { carResponse } from './fixtures/home-trips.mjs'
const selection = { version: 1, mode: 'driving', places: [
    { id: 'work', label: 'Работа и занятия — длинное название общей цели', point: { lon: 92.91, lat: 56.03 } },
    { id: 'family', label: 'Семья и дополнительные дела', point: { lon: 92.90, lat: 56.04 } },
    { id: 'study', label: 'Учёба', point: { lon: 92.92, lat: 56.05 } },
], roads: {} }
const root = '/' + '?' + new URLSearchParams({ left: places.a.id, right: places.b.id, radius_m: '500' })
const restored = root + '#' + new URLSearchParams({ places: JSON.stringify(selection) })
const nav = page => page.getByRole('tablist', { name: 'Рабочая область', exact: true })
const editor = page => page.getByRole('region', { name: 'Редактор поездок', exact: true })
const scroll = (page, selector) => page.locator(selector).evaluate(node => node.scrollTop)
async function setup(page) {
    await page.addInitScript(() => localStorage.setItem('placelens:interface:v1', 'workspace'))
    await page.route('**/api/v1/addresses/resolve-point', route => route.fulfill({ json: { data: { match: 'NONE', requires_choice: false, candidates: [] }, meta: { source: 'Synthetic', quality: {}, coverage: {} } } }))
    const calls = []; let held = false, failB = false, release
    const gate = new Promise(resolve => { release = resolve })
    await page.route('**/api/v1/trips/analyze', async route => {
        const value = route.request().postDataJSON(); calls.push(value)
        if (held) await gate
        return route.fulfill(failB && value.start.lon === places.b.lon ? { status: 503, json: {} } : { json: carResponse(value) })
    })
    return { calls, hold() { held = true }, fail() { failB = true }, release() { held = false; release() } }
}
async function stableMap(page) {
    await expect.poll(() => page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return m?.loaded() && !m.isMoving() })).toBe(true)
    return page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); window.__g44map ??= m; return { same: window.__g44map === m, center: m.getCenter().toArray(), zoom: m.getZoom() } })
}
async function assertFocusVisible(page) {
    expect(await page.evaluate(() => { const a = document.activeElement; return !!a?.getClientRects().length && !a.closest('[inert]') })).toBe(true)
}

test('empty settings, profile before trips, mobile roving tabs and restored URLs', async ({ page, api }) => {
    await page.setViewportSize({ width: 390, height: 844 }); const h = await setup(page)
    await page.goto('/')
    await expect(nav(page).getByRole('tab')).toHaveText(['Сравнение', 'Карта', 'Настройки'])
    const settings = nav(page).getByRole('tab', { name: 'Настройки', exact: true })
    await expect(settings).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#home-results-screen')).toBeHidden()
    await settings.focus(); await settings.press('Home')
    await expect(nav(page).getByRole('tab', { name: 'Сравнение', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowLeft'); await expect(settings).toBeFocused()
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('End'); await expect(settings).toBeFocused()
    await page.getByRole('button', { name: 'Добавить адрес А', exact: true }).press('Enter')
    const input = page.locator('#home-panel').getByRole('combobox', { name: 'Адрес в Красноярске', exact: true })
    await input.fill(places.a.label); await expect(page.getByRole('listbox', { name: 'Найденные адреса' }).getByRole('option')).toHaveCount(1); await input.press('ArrowDown'); await input.press('Enter')
    await expect(page.getByRole('heading', { name: 'Профиль А', exact: true })).toBeVisible()
    await expect(page.getByRole('table')).toContainText('150 м'); expect(h.calls).toHaveLength(0)
    await page.goto(restored)
    await expect(nav(page).getByRole('tab', { name: 'Сравнение', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(6)
    expect(h.calls).toHaveLength(2)
})

test('G46-01: empty settings → address profile → comparison without goals → add a goal at four exact viewports', async ({ page, api }, info) => {
    await page.addInitScript(() => localStorage.setItem('placelens:interface:v1', 'workspace'))
    const tripPosts = [], verifiedSizes = []
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/trips/analyze') tripPosts.push(request.url()) })
    const hintText = 'Для расчёта поездок добавьте общие цели. Профиль окружения уже доступен.'
    for (const [width, height] of [[390, 844], [320, 740], [390, 480], [1280, 720]]) {
        await page.setViewportSize({ width, height }); await page.goto('/')
        const actual = await page.evaluate(() => [innerWidth, innerHeight])
        expect(actual).toEqual([width, height]); verifiedSizes.push(actual)
        if (width < 768) await expect(nav(page).getByRole('tab', { name: 'Настройки', exact: true })).toHaveAttribute('aria-selected', 'true')
        await expect(editor(page).getByLabel('Название общей цели', { exact: true })).toHaveCount(0)
        await page.getByRole('button', { name: 'Добавить адрес А', exact: true }).press('Enter')
        const search = page.locator('#home-panel').getByRole('combobox', { name: 'Адрес в Красноярске', exact: true })
        await search.fill(places.a.label)
        await expect(page.getByRole('listbox', { name: 'Найденные адреса' }).getByRole('option')).toHaveCount(1)
        await search.press('ArrowDown'); await search.press('Enter')
        await expect(page.getByRole('heading', { name: 'Профиль А', exact: true })).toBeVisible()
        await expect(page.locator('[data-metric-id="transport:nearest_stop_distance"]')).toContainText('150 м')
        const hint = page.getByRole('cell', { name: hintText, exact: true })
        await expect(hint).toBeVisible()
        const add = editor(page).getByRole('button', { name: 'Добавить цель', exact: true })
        if (width < 768) {
            await expect(nav(page).getByRole('tab', { name: 'Сравнение', exact: true })).toHaveAttribute('aria-selected', 'true')
            await expect(add).toBeHidden()
        } else await expect(add).toBeVisible()
        await hint.scrollIntoViewIfNeeded(); await expect(hint).toBeInViewport({ ratio: 1 })
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: info.outputPath(`g46-01-profile-${width}x${height}.png`) })
        await homeScreen(page, 'Настройки')
        await add.focus(); await expect(add).toBeInViewport({ ratio: 1 }); await add.press('Enter')
        const goal = editor(page).getByLabel('Название общей цели', { exact: true })
        await expect(goal).toHaveCount(1); await goal.fill('Работа'); await expect(goal).toHaveValue('Работа')
        await page.screenshot({ path: info.outputPath(`g46-01-add-goal-${width}x${height}.png`) })
        await homeScreen(page, 'Сравнение'); await expect(hint).toHaveCount(0)
        expect(tripPosts).toHaveLength(0)
    }
    expect(api.calls.filter(url => url.includes('/profile?'))).toHaveLength(4)
    await info.attach('g46-01-verified-paths', { body: JSON.stringify({ viewports: verifiedSizes, profileGets: 4, tripPosts: tripPosts.length }), contentType: 'application/json' })
})

test('run reveals loading, independent partial error and retry; late reply leaves subsequent editing and focus intact', async ({ page, api }) => {
    await page.setViewportSize({ width: 390, height: 844 }); const h = await setup(page)
    await page.goto(restored); await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(6)
    await homeScreen(page, 'Настройки'); h.hold(); h.fail()
    await editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true }).press('Enter')
    await expect(nav(page).getByRole('tab', { name: 'Сравнение', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.home-trip-cell').first()).toHaveAttribute('aria-busy', 'true')
    expect(await scroll(page, '#home-workspace-results')).toBe(0)
    await homeScreen(page, 'Настройки')
    const field = editor(page).getByLabel('Название общей цели', { exact: true }).first()
    await field.fill('Длительное редактирование'); const position = await scroll(page, '#home-panel')
    h.release()
    await expect(page.locator('.home-result-table [data-home-trip]').filter({ hasText: 'Не удалось рассчитать' })).toHaveCount(3)
    await expect(field).toBeFocused(); await expect(field).toHaveValue('Длительное редактирование')
    expect(await scroll(page, '#home-panel')).toBe(position)
    await homeScreen(page, 'Сравнение'); await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(3)
    await page.locator('[data-goal-id=work] [data-side=right]').getByRole('button', { name: /^Подробности поездки:/ }).click()
    const retry = page.getByRole('dialog').getByRole('button', { name: 'Повторить эту поездку', exact: true })
    await retry.press('Enter'); await expect.poll(() => h.calls.length).toBe(5)
    await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(3)
})

test('independent scroll, one-shot exact row return, removal, breakpoint and interface preserve owners without fit or POST', async ({ page, api }) => {
    await page.setViewportSize({ width: 320, height: 740 }); const h = await setup(page)
    await page.goto(restored); await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(6)
    await page.setViewportSize({ width: 320, height: 360 })
    await homeScreen(page, 'Карта'); await stableMap(page)
    await page.locator('.home-map-heading').evaluate(node => { node.scrollTop = 20 })
    const shortMapScroll = await scroll(page, '.home-map-heading'); expect(shortMapScroll).toBeGreaterThan(0)
    await homeScreen(page, 'Настройки'); await homeScreen(page, 'Карта')
    expect(await scroll(page, '.home-map-heading')).toBe(shortMapScroll)
    await page.setViewportSize({ width: 320, height: 740 }); await stableMap(page)

    await page.evaluate(() => { const m = window.__g44map, fit = m.fitBounds.bind(m); window.__g44fits = 0; m.fitBounds = (...args) => { window.__g44fits++; return fit(...args) } })
    await homeScreen(page, 'Настройки'); await page.locator('#home-panel').evaluate(node => { node.scrollTop = 260 })
    const settingsScroll = await scroll(page, '#home-panel'); expect(settingsScroll).toBeGreaterThan(0)
    await homeScreen(page, 'Сравнение'); await page.locator('#home-workspace-results').evaluate(node => { node.scrollTop = 500 })
    const reading = await scroll(page, '#home-workspace-results'); expect(reading).toBeGreaterThan(0)
    await homeScreen(page, 'Карта'); await page.locator('.home-map-heading').evaluate(node => { node.scrollTop = 30 })
    const mapScroll = await scroll(page, '.home-map-heading')
    await homeScreen(page, 'Настройки'); expect(await scroll(page, '#home-panel')).toBe(settingsScroll)
    await homeScreen(page, 'Сравнение'); expect(await scroll(page, '#home-workspace-results')).toBe(reading)
    const action = page.locator('[data-goal-id=family] [data-side=right] [data-home-map-action]')
    await action.scrollIntoViewIfNeeded()
    const before = await action.evaluate(node => node.getBoundingClientRect().top)
    await action.press('Enter'); await stableMap(page)
    await page.getByLabel('Показ целей', { exact: true }).getByRole('button', { name: 'Подробности', exact: true }).press('Enter')
    await page.getByRole('dialog', { name: 'Результат на карте', exact: true }).getByRole('button', { name: 'К строке', exact: true }).press('Enter')
    await expect(action).toBeFocused()
    await expect(page.getByRole('tab', { name: 'Обзор', exact: true })).toHaveAttribute('aria-selected', 'true')
    expect(Math.abs(await action.evaluate(node => node.getBoundingClientRect().top) - before)).toBeLessThan(2)
    await page.locator('#home-workspace-results').evaluate(node => { node.scrollTop = 700 })
    const newReading = await scroll(page, '#home-workspace-results')
    await homeScreen(page, 'Карта'); expect(await scroll(page, '.home-map-heading')).toBe(mapScroll); await homeScreen(page, 'Сравнение')
    expect(await scroll(page, '#home-workspace-results')).toBe(newReading)
    await homeScreen(page, 'Настройки'); await editor(page).getByLabel('Название общей цели', { exact: true }).first().fill('Черновик сохраняется')
    await page.setViewportSize({ width: 1280, height: 560 }); await assertFocusVisible(page)
    await page.setViewportSize({ width: 390, height: 844 }); await expect(editor(page).getByLabel('Название общей цели', { exact: true }).first()).toHaveValue('Черновик сохраняется')
    const ui = page.getByRole('group', { name: 'Интерфейс', exact: true })
    await expect(page.getByRole('group', { name: 'Интерфейс', exact: true })).toHaveCount(0)
    await homeScreen(page, 'Карта'); const after = await stableMap(page)
    expect(after.same).toBe(true); expect(h.calls).toHaveLength(2)
    // One explicit row action fitted; all navigation/resize/interface changes were neutral.
    expect(await page.evaluate(() => window.__g44fits)).toBe(1)
    await homeScreen(page, 'Настройки'); await editor(page).getByRole('button', { name: /^Удалить общую цель Семья/ }).press('Enter')
    await homeScreen(page, 'Карта'); await expect(page.getByRole('button', { name: 'К строке', exact: true })).toHaveCount(0)
    await homeScreen(page, 'Сравнение'); await assertFocusVisible(page)
    expect(h.calls).toHaveLength(2)
})

test('newer navigation cancels deferred layer focus and address-editor focus', async ({ page, api }) => {
    await page.setViewportSize({ width: 390, height: 844 }); const h = await setup(page)
    await page.goto(root)
    await expect(page.getByLabel('Состояние А', { exact: true })).toHaveAttribute('aria-busy', 'false')
    await page.getByRole('button', { name: 'Подробности: Ближайшая остановка, А', exact: true }).press('Enter')
    const dialog = page.getByRole('dialog')
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Shift+Tab'); expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true) }
    // Deliberately queue two real UI actions in one task before Vue's nextTick.
    await page.evaluate(() => {
        [...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'На карте А').click()
        document.getElementById('home-mobile-settings').click()
    })
    await expect(nav(page).getByRole('tab', { name: 'Настройки', exact: true })).toBeFocused()
    await expect(page.locator('.placelens-map')).toBeHidden()
    await page.evaluate(() => {
        [...document.querySelectorAll('#home-panel button')].find(button => button.textContent === 'Заменить адрес А').click()
        document.getElementById('home-mobile-map').click()
    })
    await expect(nav(page).getByRole('tab', { name: 'Карта', exact: true })).toBeFocused()
    await expect(page.locator('#home-panel')).toBeHidden(); await assertFocusVisible(page)
    expect((await stableMap(page)).same).toBe(true); expect(h.calls).toHaveLength(0)
})

test('actual six viewports, short modal scroll, paired columns, keyboard and CSS zoom 200 percent', async ({ page, api }, info) => {
    test.skip(info.project.name !== 'short-desktop', 'one sequential visual pass')
    test.setTimeout(120_000); const h = await setup(page)
    await page.goto(restored)
    for (const [width, height] of [[1440,900],[1280,720],[1280,560],[390,844],[320,740],[390,480]]) {
        await page.setViewportSize({ width, height })
        await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(6)
        expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
        await page.evaluate(() => document.fonts.ready)
        await homeScreen(page, 'Настройки')
        await page.locator('#home-panel').evaluate(node => { node.scrollTop = 0 })
        const run = editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true })
        await run.focus(); await expect(run, `run fully visible at ${width}x${height}`).toBeInViewport({ ratio: 1 })
        await page.screenshot({ path: info.outputPath(`g44-settings-editor-${width}x${height}.png`) })
        await page.locator('#home-panel').evaluate(node => { node.scrollTop = 0 })
        await page.screenshot({ path: info.outputPath(`g44-settings-${width}x${height}.png`) })
        await homeScreen(page, 'Сравнение')
    const trigger = page.locator('.home-result-table').getByRole('button', { name: /^Подробности поездки:/ }).first()
        await trigger.press('Enter'); const dialog = page.getByRole('dialog', { name: /^А →/ })
        const summary = dialog.getByRole('button', { name: 'Показать маршрут', exact: true })
        await summary.scrollIntoViewIfNeeded(); await expect(summary).toBeInViewport()
        await expect(dialog.getByRole('button', { name: 'Закрыть', exact: true })).toBeInViewport()
        await dialog.getByRole('button', { name: 'Закрыть', exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: info.outputPath(`g44-dialog-summary-${width}x${height}.png`) })
        for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true) }
        await page.screenshot({ path: info.outputPath(`g44-dialog-${width}x${height}.png`) })
        await page.keyboard.press('Escape'); await expect(trigger).toBeFocused()
        await homeScreen(page, 'Сравнение')
        await page.locator('#home-workspace-results').evaluate(node => { node.scrollTop = 0 })
        await expect(page.locator('[data-goal-id=work] td')).toHaveCount(2)
        await page.screenshot({ path: info.outputPath(`g44-comparison-${width}x${height}.png`) })
        await homeScreen(page, 'Карта'); await stableMap(page)
        const fitCount = await page.evaluate(() => {
            const m = window.__smokeMapIn('.placelens-map')
            if (window.__g44visualFits === undefined) {
                window.__g44visualFits = 0
                const fit = m.fitBounds.bind(m)
                m.fitBounds = (...args) => { const result = fit(...args); window.__g44visualFits++; return result }
            }
            return window.__g44visualFits
        })
        await page.getByLabel('Показ целей', { exact: true }).getByRole('button', { name: 'Все цели', exact: true }).press('Enter')
        await expect.poll(() => page.evaluate(() => window.__g44visualFits)).toBe(fitCount + 1)
        await stableMap(page)
        await page.screenshot({ path: info.outputPath(`g44-map-${width}x${height}.png`) })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (width < 768) {
            await nav(page).getByRole('tab', { name: 'Карта', exact: true }).focus()
            await page.keyboard.press('Tab'); await assertFocusVisible(page)
        }
    }
    // Reflow at the CSS viewport of a 1280×720 desktop enlarged to 200%.
    await page.setViewportSize({ width: 640, height: 360 })
    await homeScreen(page, 'Настройки')
    const enlargedRun = editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true })
    await enlargedRun.focus(); await expect(enlargedRun).toBeInViewport({ ratio: 1 })
    await homeScreen(page, 'Сравнение'); await expect(page.locator('[data-goal-id=work] td')).toHaveCount(2)
    await homeScreen(page, 'Карта')
    const zoomIn = page.getByRole('button', { name: 'Приблизить', exact: true })
    await zoomIn.focus(); await expect(zoomIn).toBeInViewport({ ratio: 1 })
    const surfaceReading = await scroll(page, '#home-map-screen'); expect(surfaceReading).toBeGreaterThan(0)
    await homeScreen(page, 'Настройки'); await homeScreen(page, 'Карта')
    expect(await scroll(page, '#home-map-screen')).toBe(surfaceReading)
    await page.screenshot({ path: info.outputPath('g44-reflow-200.png') })
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.evaluate(() => { document.documentElement.style.zoom = '2' })
    await homeScreen(page, 'Настройки')
    await homeScreen(page, 'Сравнение')
    const trigger = page.locator('.home-result-table').getByRole('button', { name: /^Подробности поездки:/ }).first()
    await trigger.press('Enter')
    const dialog = page.getByRole('dialog', { name: /^А →/ })
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).scrollIntoViewIfNeeded()
    await expect(dialog.getByRole('button', { name: 'Закрыть', exact: true })).toBeInViewport()
    await page.screenshot({ path: info.outputPath('g44-zoom-200.png') })
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused()
    await homeScreen(page, 'Настройки')
    await page.evaluate(() => { document.documentElement.style.zoom = '' })
    // A table initiator can become hidden when settings are opened at the breakpoint.
    await page.setViewportSize({ width: 1280, height: 720 })
    await homeScreen(page, 'Сравнение')
    await trigger.press('Enter'); await page.setViewportSize({ width: 390, height: 480 })
    await page.keyboard.press('Escape'); await expect(page.locator('#main-content')).toBeFocused()
    await assertFocusVisible(page)
    expect(h.calls).toHaveLength(2)
    expect(await page.evaluate(() => window.__g44visualFits)).toBe(6)
})
