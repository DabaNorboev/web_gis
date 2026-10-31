import { test, expect, homeScreen } from './support.mjs'
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
async function mapState(page) {
    return page.evaluate(async () => {
        const map = window.__smokeMapIn('.placelens-map')
        const overlays = []
        for (const [id, source] of Object.entries(map?.getStyle().sources ?? {})) if (id.includes('trip')) overlays.push([id, await map.getSource(id).getData()])
        return { overlays, center: map?.getCenter().toArray(), zoom: map?.getZoom() }
    })
}


for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    test(`pencil opens exact saved card without a modal or calculation ${viewport.width}`, async ({ page, api }) => {
        await page.setViewportSize(viewport)
        const h = await setup(page, { unknown: true }); await page.goto(root())
        await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(5)
        await homeScreen(page, 'Настройки')
        for (const card of await editor(page).locator('.goal-editor:visible').all()) {
            await card.getByRole('textbox', { name: /Ориентир времени/ }).fill('20')
            await card.getByRole('button', { name: 'Сохранить', exact: true }).click()
        }
        const initialMap = await mapState(page), url = page.url(), history = await page.evaluate(() => history.length)
        await homeScreen(page, 'Сравнение')
        if (viewport.width >= 768) await page.getByRole('button', { name: 'Свернуть панель', exact: true }).click()
        const pencil = row(page, 'study').getByRole('button', { name: 'Изменить цель Учёба', exact: true })
        await expect(pencil).toHaveText('')
        await pencil.press('Enter')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        const card = editor(page).locator('.goal-editor:visible').nth(2)
        const title = card.getByLabel('Название общей цели', { exact: true })
        await expect(title).toBeFocused(); await expect(title).toBeInViewport(); await expect(title).toHaveValue('Учёба')
        await expect(editor(page).locator('.goal-summary')).toHaveCount(2)
        const threshold = card.getByRole('textbox', { name: /Ориентир времени/ })
        await expect(threshold).toHaveValue('20'); await threshold.fill('-1')
        await expect(card.getByRole('alert')).toBeVisible(); await expect(card.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled()
        await threshold.fill('25'); expect(page.url()).toBe(url); await title.fill('Университет')
        await card.getByRole('button', { name: 'Сохранить', exact: true }).click()
        await expect(card.locator('.goal-summary')).toContainText('До 25 мин')
        await homeScreen(page, 'Сравнение')
        await expect(row(page, 'study')).toContainText('Университет')
        await expect(row(page, 'study').locator('td[data-side=right]')).toContainText('Путь неизвестен')
        expect(await row(page, 'study').locator('td[data-side=right]').innerText()).not.toContain('Данные о пути неизвестны.')
        await expect(page.locator('[data-metric-id="transport:nearest_stop_distance"] .home-goal-pencil')).toHaveCount(0)
        await expect(page.getByRole('button', { name: /Задать ориентир|Личный ориентир/ })).toHaveCount(0)
        expect(JSON.parse(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('places')).places[2].label).toBe('Университет'); expect(await page.evaluate(() => history.length)).toBe(history); expect(h.calls).toHaveLength(2)
        const after = await mapState(page)
        expect(after.center).toEqual(initialMap.center); expect(after.zoom).toEqual(initialMap.zoom)
        // Labels/signals may change; actual route coordinates stay untouched.
        const routes = state => state.overlays.flatMap(([, data]) => data.features.filter(f => f.properties.kind === 'route').map(f => f.geometry))
        expect(routes(after)).toEqual(routes(initialMap))
        await page.locator('.home-result-tools').scrollIntoViewIfNeeded()
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: `experiments/placelens-visual/screenshots/u3-feedback-${viewport.width}.png` })
        if (viewport.width === 1440) {
            await page.setViewportSize({ width: 2228, height: 1334 })
            await page.locator('#home-workspace-results').evaluate(element => { element.scrollTop = 0 })
            await page.locator('#home-panel').evaluate(element => { element.scrollTop = 0 })
            await page.screenshot({ path: 'experiments/placelens-visual/screenshots/u3-feedback-wide.png' })
            await page.setViewportSize(viewport)
        }
        await row(page, 'study').getByRole('button', { name: 'Изменить цель Университет', exact: true }).click()
        await expect(title).toBeFocused(); await threshold.fill(''); await card.getByRole('button', { name: 'Сохранить', exact: true }).click()
        await homeScreen(page, 'Сравнение'); await expect(row(page, 'study').locator('[data-orientation-status]')).toHaveCount(0)
    })
}

test('quiet unknown and missing cells retain reasons, actions and provenance in info', async ({ page, api }) => {
    await setup(page, { unknown: true })
    await page.route('**/api/v1/addresses/*/profile?*', route => {
        const place = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)) === places.b.id ? places.b : places.a
        const value = profile(place)
        const metric = value.blocks.transport.data.metrics.nearest_stop_distance
        metric.value = null; metric.quality = { ...metric.quality, availability: 'INSUFFICIENT_DATA', reason: 'Охват остановок неизвестен.' }
        return route.fulfill({ json: value })
    })
    await page.goto(root())
    const missing = row(page, 'study').locator('td[data-side=right]')
    await expect(missing).toContainText('Путь неизвестен'); expect(await missing.innerText()).not.toContain('Данные о пути неизвестны.')
    const info = missing.getByRole('button', { name: /^Подробности поездки:/ })
    await info.click(); await expect(page.getByRole('dialog')).toContainText('Данные о пути неизвестны.')
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Повторить эту поездку', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape'); await expect(info).toBeFocused()
    const stop = page.locator('[data-metric-id="transport:nearest_stop_distance"]')
    expect(await stop.innerText()).not.toContain('Охват остановок неизвестен.')
    await stop.getByRole('button', { name: 'Подробности: Ближайшая остановка, А', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Охват остановок неизвестен.')
    await expect(page.getByRole('dialog')).toContainText('Источник:')
    await page.keyboard.press('Escape')
})

test('inline session threshold survives radius and interface; sharing omits it and reload clears it', async ({ page, api }) => {
    const h = await setup(page); await page.goto(root())
    await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(6)
    await homeScreen(page, 'Настройки')
    const field = editor(page).getByRole('textbox', { name: /Ориентир времени/ }).first()
    await field.fill('20')
    await page.getByRole('button', { name: '300 м', exact: true }).click()
    await expect(field).toHaveValue('20')
    const ui = page.getByRole('group', { name: 'Интерфейс', exact: true })
    await expect(page.getByRole('group', { name: 'Интерфейс', exact: true })).toHaveCount(0)
    await homeScreen(page, 'Настройки'); await expect(field).toHaveValue('20')
    await page.getByText('Поделиться', { exact: true }).click()
    await expect(page.getByLabel('Поделиться сравнением')).toContainText('не входят в ссылку')
    expect(page.url()).not.toContain('threshold'); expect(h.calls).toHaveLength(2)
    await page.reload(); await homeScreen(page, 'Настройки')
    await expect(field).toHaveValue('')
})
test('controlled request completes into new inline threshold with no false first-result accent', async ({ page, api }) => {
    const h = await setup(page, { held: true }); await page.goto(root())
    await expect.poll(() => h.calls.length).toBe(2)
    await homeScreen(page, 'Настройки')
    const field = editor(page).getByRole('textbox', { name: /Ориентир времени/ }).first()
    await field.fill('15'); await field.fill('20'); h.release()
    await homeScreen(page, 'Сравнение')
    await expect(row(page).locator('[data-orientation-status=within]')).toHaveCount(1)
    await expect(row(page).locator('[data-orientation-status=over]')).toHaveCount(1)
    await expect(page.locator('.home-orientation-changed')).toHaveCount(0)
    await expect(page.locator('p[aria-live=polite][aria-atomic=true]')).toBeEmpty()
    expect(h.calls).toHaveLength(2)
})

test('inline editor isolates modes and standalone scenario; rename and point edits keep the same goal setting', async ({ page, api }) => {
    const h = await setup(page); await page.goto(root())
    await homeScreen(page, 'Сравнение')
    await expect(row(page).locator('.home-cell-value').first()).toHaveText('около 16 мин')
    await homeScreen(page, 'Настройки')
    const field = editor(page).getByRole('textbox', { name: /Ориентир времени/ }).first()
    await field.fill('20')
    const mode = value => editor(page).getByRole('radio', { name: value === 'walking' ? 'Пешком' : 'Авто', exact: true })
    await mode('walking').check(); await expect(field).toHaveValue('')
    await field.fill('9'); await mode('driving').check(); await expect(field).toHaveValue('20')
    await editor(page).getByRole('textbox', { name: 'Название общей цели', exact: true }).first().fill('Работа рядом')
    await expect(field).toHaveValue('20')
    await editor(page).locator('.goal-editor').first().getByRole('button', { name: 'Убрать точку', exact: true }).click()
    await expect(field).toHaveValue('20'); await expect(row(page)).toContainText('Нет расчёта')
    await page.getByRole('group', { name: 'Сценарий', exact: true }).getByRole('button', { name: 'Отдельная поездка', exact: true }).click()
    const ownField = editor(page).getByRole('textbox', { name: /Ориентир времени/ }).first()
    await expect(ownField).toHaveValue(''); await ownField.fill('30')
    await page.getByRole('group', { name: 'Сценарий', exact: true }).getByRole('button', { name: 'Адреса', exact: true }).click()
    await expect(field).toHaveValue('20'); expect(h.calls).toHaveLength(2)
})

test('orientation, radius, rename and geometry keep distinct trip boundaries across either side replacement and removal', async ({ page, api }) => {
    const h = await setup(page); await page.goto(root())
    await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(6)
    const routes = async () => page.evaluate(async () => {
        const map = window.__smokeMapIn('.placelens-map')
        return (await map.getSource('trips').getData()).features.filter(f => f.properties.kind === 'route')
    })
    const showMap = async () => {
        await homeScreen(page, 'Карта')
        await expect.poll(() => page.evaluate(() => { const m = window.__smokeMapIn('.placelens-map'); return m?.loaded() && !m.isMoving() })).toBe(true)
    }
    await showMap(); const original = await routes(); expect(original).toHaveLength(6)
    await homeScreen(page, 'Настройки')
    const open = editor(page).getByRole('textbox', { name: /Ориентир времени/ }).first()
    await open.fill('20')
    await showMap(); expect(await routes()).toEqual(original); expect(h.calls).toHaveLength(2)

    const a = api.hold(places.a), b = api.hold(places.b)
    try {
        await homeScreen(page, 'Настройки'); await page.getByRole('button', { name: '300 м', exact: true }).press('Enter')
        await Promise.all([a.started, b.started])
        await expect(page.getByLabel('Состояние А', { exact: true })).toHaveAttribute('aria-busy', 'true')
        await expect(page.getByLabel('Состояние Б', { exact: true })).toHaveAttribute('aria-busy', 'true')
        await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(6)
        await showMap(); expect(await routes()).toEqual(original); expect(h.calls).toHaveLength(2)
    } finally { a.release(); b.release() }
    for (const side of ['А', 'Б']) await expect(page.getByLabel(`Состояние ${side}`, { exact: true })).toHaveAttribute('aria-busy', 'false')
    await showMap(); expect(await routes()).toEqual(original)
    await homeScreen(page, 'Настройки')
    await editor(page).getByLabel('Название общей цели', { exact: true }).first().fill('Работа переименована')
    await expect(editor(page).getByRole('textbox', { name: /Ориентир времени/ }).first()).toHaveValue('20')
    await showMap(); expect(await routes()).toEqual(original); expect(h.calls).toHaveLength(2)

    // Editing one original goal clears its two routes, preserving the other four.
    await homeScreen(page, 'Настройки')
    const pointEditor = editor(page).locator('.goal-editor').first()
    const search = pointEditor.getByRole('combobox', { name: 'Адрес в Красноярске', exact: true })
    await search.fill(places.d.label); await expect(pointEditor.getByRole('option')).toHaveCount(1)
    await search.press('ArrowDown'); await search.press('Enter')
    await expect(row(page).locator('.home-cell-value')).toHaveCount(0)
    await expect(editor(page).getByRole('textbox', { name: /Ориентир времени/ }).first()).toHaveValue('20')
    await showMap()
    const unaffected = original.filter(f => JSON.parse(f.properties.entity)[0].placeId !== 'work')
    await expect.poll(routes).toEqual(unaffected); expect(h.calls).toHaveLength(2)
    await homeScreen(page, 'Сравнение')
    await row(page).locator('[data-side=left]').getByRole('button', { name: /^Подробности поездки:/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Рассчитать эту поездку', exact: true }).press('Enter')
    await expect(row(page).locator('[data-side=left] .home-cell-value')).toHaveText('около 16 мин')
    expect(h.calls).toHaveLength(3); expect(h.calls.at(-1).places).toHaveLength(1)
    expect(h.calls.at(-1).places[0]).toMatchObject({ lon: places.d.lon, lat: places.d.lat })
    await showMap(); await expect.poll(async () => (await routes()).length).toBe(5)

    // Replacing either start invalidates only its side. No replacement calculates implicitly.
    for (const [side, key, place] of [['Б', 'right', places.d], ['А', 'left', places.c]]) {
        const kept = (await routes()).filter(f => JSON.parse(f.properties.entity)[0].side !== key)
        await homeScreen(page, 'Настройки'); await page.getByRole('button', { name: `Заменить адрес ${side}`, exact: true }).press('Enter')
        const field = page.locator('#home-panel .place-search').getByRole('combobox', { name: 'Адрес в Красноярске', exact: true })
        await field.fill(place.label); await expect(page.getByRole('listbox', { name: 'Найденные адреса' }).getByRole('option')).toHaveCount(1)
        await field.press('ArrowDown'); await field.press('Enter')
        await expect(page.getByLabel(`Состояние ${side}`, { exact: true })).toHaveAttribute('aria-busy', 'false')
        await showMap(); await expect.poll(routes).toEqual(kept); expect(h.calls).toHaveLength(3)
    }
    await homeScreen(page, 'Настройки')
    await editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true }).press('Enter')
    await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(6); expect(h.calls).toHaveLength(5)
    await showMap()
    await homeScreen(page, 'Настройки'); await editor(page).getByRole('radio', { name: 'Пешком', exact: true }).check()
    await showMap(); await expect.poll(routes).toEqual([]); expect(h.calls).toHaveLength(5)
    await homeScreen(page, 'Настройки'); await editor(page).getByRole('radio', { name: 'Авто', exact: true }).check()
    await expect(editor(page).getByRole('textbox', { name: /Ориентир времени/ }).first()).toHaveValue('20')
    await editor(page).getByRole('button', { name: 'Рассчитать поездки от адресов', exact: true }).press('Enter')
    await expect(page.locator('.home-trip-cell.is-ready')).toHaveCount(6); expect(h.calls).toHaveLength(7)
    await showMap()
    for (const [side, key] of [['Б', 'right'], ['А', 'left']]) {
        const kept = (await routes()).filter(f => JSON.parse(f.properties.entity)[0].side !== key)
        await homeScreen(page, 'Настройки'); await page.getByRole('button', { name: `Убрать ${side}`, exact: true }).press('Enter')
        await showMap(); await expect.poll(routes).toEqual(kept); expect(h.calls).toHaveLength(7)
        await homeScreen(page, 'Настройки')
        await expect(editor(page).getByRole('textbox', { name: /Ориентир времени/ }).first()).toHaveValue('20')
    }
})
