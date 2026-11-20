import { test, expect } from '@playwright/test'
import { fixtures, point, preview } from './support/geocoding.mjs'
import { pointReference } from '../frontend/fixtures/point-address-reference.mjs'
import { searchResponse, places, addressObject } from './fixtures.mjs'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'
import { envelope } from '../frontend/fixtures/geocoding.mjs'

const mode = page => page.getByRole('button', { name: /^Поиск: / })
const input = page => page.getByRole('combobox', { name: 'Поиск адреса' })
const ready = page => page.locator('[data-analysis-block="poi"]').getByRole('status')
function resolved(id) {
    const p = Object.values(places).find(p => p.id === id) ?? { ...places.a, id }
    return { address: { id, label: p.label, object: addressObject({ ...p, lon: .4, lat: .5 }), bounds: [.4, .5, .4, .5], source: 'OpenStreetMap', dataset_import_id: 1, observed_at: null, source_updated_at: null, reason: 'Synthetic' }, capabilities: { resolver_version: 1, selected_profile_version: 1 } }
}
async function local(page) {
    const f = await fixtures(page), resolutions = []
    await page.route('**/api/v1/addresses/search?*', route => route.fulfill({ json: searchResponse(new URL(route.request().url()).searchParams.get('q')) }))
    await page.route(/\/api\/v1\/addresses\/osm[^/?]+$/, route => {
        const id = decodeURIComponent(route.request().url().split('/').at(-1)); resolutions.push(id)
        return route.fulfill({ json: resolved(id) })
    })
    // The fixture response must echo the resolver point for v1 address analysis.
    await page.route('**/api/v1/place-analysis', route => {
        const req = route.request().postDataJSON()
        if (req.place.kind !== 'address' || req.analysis_version === 2) return route.fallback()
        f.requests.push(req)
        return route.fulfill({ json: responseFor(req, { poi: 'READY' }) })
    })
    return { ...f, resolutions }
}
test('local starts by default; explicit OSM object uses v1 and mode preserves text, place and ready results', async ({ page }) => {
    const f = await local(page); await page.goto('/')
    await expect(mode(page)).toHaveText('Поиск: локальный')
    await input(page).fill('Тестовая улица, 1')
    await page.getByRole('button', { name: 'Тестовая улица, 1', exact: true }).click()
    await expect(ready(page)).toHaveText('Готово')
    expect(f.resolutions).toEqual([places.a.id]); expect(f.requests).toHaveLength(3)
    expect(f.requests.every(r => r.analysis_version === undefined && r.place.address_id === places.a.id && !r.place.selection_token)).toBe(true)
    await mode(page).click(); await expect(input(page)).toHaveValue('Тестовая улица, 1')
    await expect(ready(page)).toHaveText('Готово'); expect(f.calls).toHaveLength(0)
    await mode(page).click(); await expect(input(page)).toHaveValue('Тестовая улица, 1')
    await expect(page.getByRole('option')).toHaveCount(0); expect(f.requests).toHaveLength(3)
})
test('Geoapify Enter searches the preserved query once after switching modes', async ({ page }) => {
    const f = await local(page)
    const localSearches = []
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/v1/addresses/search') localSearches.push(request)
    })
    await page.clock.install()
    await page.goto('/')
    await mode(page).click()
    const query = 'Синтетическая 10'
    await input(page).fill(query)
    await expect(page.getByRole('option')).toHaveCount(1)
    await input(page).press('ArrowDown')
    await expect(page.getByRole('option', { selected: true })).toHaveCount(1)

    await mode(page).click()
    await expect(mode(page)).toHaveText('Поиск: локальный')
    await page.clock.fastForward(500)
    await mode(page).click()
    await expect(mode(page)).toHaveText('Поиск: Geoapify')
    await expect(input(page)).toHaveValue(query)
    await input(page).focus()
    await page.clock.fastForward(500)
    await expect(page.getByRole('option')).toHaveCount(0)
    expect(localSearches).toHaveLength(0)
    expect(f.calls).toHaveLength(1)
    await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /.+/)

    await input(page).press('Enter')
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.clock.fastForward(500)
    expect(f.calls.map(({ op, req }) => [op, req.mode, req.q])).toEqual([
        ['search', 'autocomplete', query],
        ['search', 'search', query],
    ])
    await expect(page.getByRole('option', { selected: true })).toHaveCount(0)
})
for (const op of ['search', 'confirm', 'reverse']) {
    test(`mode A-B-A rejects late Geoapify ${op}`, async ({ page }) => {
        const f = await fixtures(page); let stale
        await page.route(`**/api/v1/geocoding/${op}`, route => { stale = route })
        await page.goto('/'); await mode(page).click()
        if (op === 'reverse') {
            await point(page)
            await page.getByRole('button', { name: 'Найти адрес поблизости', exact: true }).click()
        } else {
            if (op === 'confirm') { await preview(page); await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click() }
            else await input(page).fill('Синтетическая 10')
        }
        await expect.poll(() => !!stale).toBe(true)
        const text = await input(page).inputValue(), count = f.calls.length, analyses = f.requests.length
        await mode(page).click(); await mode(page).click()
        await expect(input(page)).toHaveValue(text)
        const req = stale.request().postDataJSON()
        try { await stale.fulfill({ json: envelope(req, op === 'confirm' ? f.selected : { status: 'OK', reason: null, ...(op === 'reverse' ? { point: { lon: req.lon, lat: req.lat } } : {}), candidates: [f.c] }) }) } catch { /* cancelled */ }
        await expect(page.getByRole('option')).toHaveCount(0)
        await expect(page.getByRole('region', { name: 'Подтверждение адреса' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Анализировать место', exact: true }))[op === 'reverse' ? 'toBeEnabled' : 'toBeDisabled']()
        expect(f.calls).toHaveLength(count); expect(f.requests).toHaveLength(analyses)
    })
}
test('Geoapify selection expires and reconfirms while local mode keeps ready results', async ({ page }) => {
    const f = await fixtures(page); await page.clock.install({ time: Date.now() }); await page.goto('/'); await mode(page).click(); await preview(page)
    await page.getByRole('button', { name: 'Подтвердить положение', exact: true }).click()
    await expect(ready(page)).toHaveText('Готово'); await mode(page).click()
    await page.clock.fastForward(86400000 + 2000)
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Переподтвердить положение', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeEnabled()
    await expect(ready(page)).toHaveText('Готово'); expect(f.requests).toHaveLength(3)
    expect(f.calls.filter(c => c.op === 'search')).toHaveLength(1)
})
for (const external of [false, true]) {
    for (const action of ['point', 'address', 'empty', 'error', 'ambiguous']) {
        test(`${external ? 'Geoapify' : 'local'} point card: ${action}`, async ({ page }) => {
            const f = await local(page); let sourcePoint
            await page.route('**/api/v1/addresses/resolve-point', route => {
                sourcePoint = route.request().postDataJSON()
                return action === 'error' ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: pointReference(action === 'empty' ? 'NONE' : 'NEARBY', action === 'ambiguous' ? ['osm:way:101', 'osm:way:202'] : ['osm:way:101']) })
            })
            await page.goto('/'); if (external) await mode(page).click()
            await page.getByRole('button', { name: 'Точка на карте', exact: true }).click(); await page.keyboard.press('Enter')
            const card = page.getByRole('dialog', { name: 'Выбранная точка' })
            await expect.poll(() => !!sourcePoint).toBe(true)
            await mode(page).click(); await expect(card).toBeVisible()
            if (['address', 'ambiguous'].includes(action)) {
                const choices = card.getByRole('button', { name: 'Анализировать этот адрес', exact: true })
                await expect(choices).toHaveCount(action === 'ambiguous' ? 2 : 1)
                expect(f.resolutions).toHaveLength(0)
                await choices.last().click()
                await expect(ready(page)).toHaveText('Готово')
                expect(f.resolutions).toEqual([action === 'ambiguous' ? places.b.id : places.a.id])
                expect(f.requests.every(r => r.place.address_id === f.resolutions[0] && !r.analysis_version)).toBe(true)
            } else {
                if (action === 'error') await expect(card).toContainText('Адрес-ориентир недоступен')
                await card.getByRole('button', { name: 'Анализировать точку', exact: true }).click()
                await expect(ready(page)).toHaveText('Готово')
                expect(f.requests.every(r => r.place.kind === 'point' && r.place.lon === sourcePoint.lon && r.place.lat === sourcePoint.lat)).toBe(true)
            }
            expect(f.calls).toHaveLength(0); expect(f.requests).toHaveLength(3)
        })
    }
}

for (const resolving of [false, true]) {
    test(`switching during local ${resolving ? 'resolver' : 'search'} rejects late response and keeps query`, async ({ page }) => {
        const f = await local(page); let stale
        if (resolving) await page.route(/\/api\/v1\/addresses\/osm[^/?]+$/, route => { stale = route })
        else await page.route('**/api/v1/addresses/search?*', route => { stale = route })
        await page.goto('/'); await input(page).fill('Тестовая улица, 1')
        if (resolving) await page.getByRole('button', { name: 'Тестовая улица, 1', exact: true }).click()
        await expect.poll(() => !!stale).toBe(true)
        await mode(page).click(); await mode(page).click()
        try { await stale.fulfill({ json: resolving ? resolved(places.a.id) : searchResponse('Тестовая улица, 1') }) } catch { /* cancelled */ }
        await expect(input(page)).toHaveValue('Тестовая улица, 1')
        await expect(page.getByRole('option')).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Анализировать место', exact: true })).toBeDisabled()
        expect(f.calls).toHaveLength(0); expect(f.requests).toHaveLength(0)
    })
}

test('choosing a point invalidates pending local address resolver', async ({ page }) => {
    const f = await local(page); let stale
    await page.route(/\/api\/v1\/addresses\/osm[^/?]+$/, route => { stale = route })
    await page.goto('/'); await input(page).fill('Тестовая улица, 1')
    await page.getByRole('button', { name: 'Тестовая улица, 1', exact: true }).click()
    await expect.poll(() => !!stale).toBe(true)
    await point(page); await expect(ready(page)).toHaveText('Готово')
    try { await stale.fulfill({ json: resolved(places.a.id) }) } catch { /* cancelled */ }
    await expect(ready(page)).toHaveText('Готово')
    expect(f.requests).toHaveLength(3); expect(f.requests.every(r => r.place.kind === 'point')).toBe(true)
})

test('confirming a pending point cancels a local resolver started after placing the point', async ({ page }) => {
    const f = await local(page)
    let stale, sourcePoint
    await page.route('**/api/v1/addresses/resolve-point', route => {
        sourcePoint = route.request().postDataJSON()
        return route.fallback()
    })
    await page.route(/\/api\/v1\/addresses\/osm[^/?]+$/, route => { stale = route })
    await page.goto('/')
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).click()
    await page.keyboard.press('Enter')
    const card = page.getByRole('dialog', { name: 'Выбранная точка' })
    await expect(card).toBeVisible()
    await expect.poll(() => !!sourcePoint).toBe(true)
    await input(page).fill(places.a.label)
    await page.getByRole('button', { name: places.a.label, exact: true }).click()
    await expect.poll(() => !!stale).toBe(true)
    const request = stale.request()
    expect(decodeURIComponent(new URL(request.url()).pathname.split('/').at(-1))).toBe(places.a.id)
    expect(f.requests).toHaveLength(0)

    await card.getByRole('button', { name: 'Анализировать точку', exact: true }).click()
    await expect(ready(page)).toHaveText('Готово')
    try {
        await stale.fulfill({ json: resolved(places.a.id) })
    } catch (error) {
        if (!request.failure()) throw error
    }
    expect(await request.response()).toBeNull()

    await expect(card).toHaveCount(0)
    await expect(input(page)).toHaveValue(places.a.label)
    await expect(page.getByRole('option')).toHaveCount(0)
    await expect(page.getByText(places.a.label, { exact: true })).toHaveCount(0)
    await expect(ready(page)).toHaveText('Готово')
    expect(f.requests.map(r => r.place)).toEqual(Array(3).fill({ kind: 'point', lon: sourcePoint.lon, lat: sourcePoint.lat }))
    expect(f.calls).toHaveLength(0)
})

const emptySearchMessages = {
    AVAILABLE: 'Адреса не найдены.',
    UNAVAILABLE: 'Локальный поиск недоступен. Можно выбрать точку на карте.',
}
for (const [availability, message] of Object.entries(emptySearchMessages)) {
    test(`empty HTTP 200 local search with ${availability} keeps point analysis available`, async ({ page }) => {
        const f = await local(page)
        const response = searchResponse('Несуществующая тестовая улица')
        response.meta.quality.availability = availability
        if (availability === 'UNAVAILABLE') response.meta.dataset_import_id = null
        await page.route('**/api/v1/addresses/search?*', route => route.fulfill({ status: 200, json: response }))
        await page.goto('/')
        await input(page).fill('Несуществующая тестовая улица')

        await expect(page.getByRole('status').filter({ hasText: message })).toHaveText(message)
        const other = availability === 'AVAILABLE' ? emptySearchMessages.UNAVAILABLE : emptySearchMessages.AVAILABLE
        await expect(page.getByRole('status').filter({ hasText: other })).toHaveCount(0)
        await expect(page.getByRole('option')).toHaveCount(0)
        await point(page)
        await expect(ready(page)).toHaveText('Готово')
        expect(f.requests.map(r => r.place.kind)).toEqual(['point', 'point', 'point'])
        expect(f.calls).toHaveLength(0)
    })
}

test('local keyboard selects a concrete object with a complete compact address', async ({ page }) => {
    const viewport = page.viewportSize()
    if (viewport.width <= 390) await page.setViewportSize({ width: viewport.width, height: viewport.width === 320 ? 568 : 640 })
    const f = await local(page)
    const response = structuredClone(searchResponse('Неоднозначная'))
    const display = { address_line: 'Неоднозначная улица', house_number: '32/2А к3 стр4', district: 'Условный район' }
    const rawLabel = '660000, Неоднозначная улица, 32/2А к3 стр4, Красноярск, Россия'
    const shortLabel = 'Неоднозначная улица, 32/2А к3 стр4, Условный район'
    response.data[0].label = rawLabel
    for (const object of response.data[0].objects) object.display = display
    await page.route('**/api/v1/addresses/search?*', route => route.fulfill({ json: response }))
    await page.route(/\/api\/v1\/addresses\/osm[^/?]+$/, route => {
        const id = decodeURIComponent(route.request().url().split('/').at(-1))
        f.resolutions.push(id)
        const result = resolved(id)
        Object.assign(result.address, { display, label: rawLabel })
        return route.fulfill({ json: result })
    })
    await page.goto('/')
    await input(page).fill('Неоднозначная')
    await expect(page.getByRole('option')).toHaveText(response.data[0].objects.map((_, i) => `${shortLabel} · Объект ${i + 1}`))
    expect(f.resolutions).toHaveLength(0)
    await input(page).press('ArrowUp')
    const lastLabel = `${shortLabel} · Объект ${response.data[0].objects.length}`
    await expect(page.getByRole('option', { name: lastLabel, exact: true, selected: true })).toBeInViewport()
    await input(page).press('ArrowDown')
    await input(page).press('ArrowDown')
    await expect(page.getByRole('option', { selected: true })).toHaveText(shortLabel + ' · Объект 2')
    await input(page).press('Enter')
    await expect(ready(page)).toHaveText('Готово')
    await expect(page.getByText(shortLabel, { exact: true })).toHaveCount(1)
    await expect(page.getByText(rawLabel, { exact: true })).toHaveCount(0)
    expect(f.resolutions).toEqual(['osm:way:502'])
    expect(f.requests.every(r => r.place.address_id === 'osm:way:502')).toBe(true)
})
