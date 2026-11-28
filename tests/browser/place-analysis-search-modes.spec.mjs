import { openMapLayers } from './support/map-controls.mjs'
import { test, expect } from '@playwright/test'
import { fixtures, point, preview } from './support/geocoding.mjs'
import { pointReference } from '../frontend/fixtures/point-address-reference.mjs'
import { searchResponse, places, addressObject } from './fixtures.mjs'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'
import { envelope } from '../frontend/fixtures/geocoding.mjs'

const mode = page => page.getByRole('button', { name: /^Поиск: / })
const input = page => page.getByRole('combobox', { name: 'Поиск адреса' })
const ready = page => page.locator('[data-analysis-block="poi"]').getByRole('status')
const addressMarker = (page, id) => page.locator(`.pa-address-marker[data-address-id="${id}"]`)
const addressFeatures = page => page.evaluate(() =>
    window.__smokeMapIn('.pa-map')?.getSource('pa-address-preview')?.serialize().data.features ?? [])
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
    await openMapLayers(page)
    const legend = page.getByRole('button', { name: 'Категории POI' })
    await expect(legend).toHaveAttribute('aria-expanded', 'false')
    await legend.press('Enter')
    await expect(page.locator('#pa-poi-legend-body')).toBeVisible()
    await legend.press('Space')
    await expect(page.locator('#pa-poi-legend-body')).toBeHidden()
    await input(page).fill('Тестовая улица, 1')
    const marker = addressMarker(page, places.a.id)
    await expect(marker).toHaveText('')
    await expect(marker).toHaveAccessibleName('Тестовая улица, 1 · на карте')
    await expect(page.locator('.pa-sidebar-search')).not.toContainText('OpenStreetMap')
    await expect.poll(() => page.evaluate(() => window.__smokeMapIn('.pa-map')?.getZoom())).toBeLessThanOrEqual(16.5)
    expect(f.requests).toHaveLength(0)
    await page.getByRole('button', { name: 'Тестовая улица, 1', exact: true }).click()
    await expect(ready(page)).toHaveText('Готово')
    expect(f.resolutions).toEqual([places.a.id]); expect(f.requests).toHaveLength(3)
    expect(f.requests.every(r => r.analysis_version === undefined && r.place.address_id === places.a.id && !r.place.selection_token)).toBe(true)
    await mode(page).click(); await expect(input(page)).toHaveValue('Тестовая улица, 1')
    await expect(ready(page)).toHaveText('Готово'); expect(f.calls).toHaveLength(0)
    await mode(page).click(); await expect(input(page)).toHaveValue('Тестовая улица, 1')
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0); expect(f.requests).toHaveLength(3)
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
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1)
    await input(page).press('ArrowDown')
    await expect(page.getByRole('listbox').getByRole('option', { selected: true })).toHaveCount(1)

    await mode(page).click()
    await expect(mode(page)).toHaveText('Поиск: локальный')
    await page.clock.fastForward(500)
    await mode(page).click()
    await expect(mode(page)).toHaveText('Поиск: Geoapify')
    await expect(input(page)).toHaveValue(query)
    await input(page).focus()
    await page.clock.fastForward(500)
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0)
    expect(localSearches).toHaveLength(0)
    expect(f.calls).toHaveLength(1)
    await expect(input(page)).not.toHaveAttribute('aria-activedescendant', /.+/)

    await input(page).press('Enter')
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1)
    await page.clock.fastForward(500)
    expect(f.calls.map(({ op, req }) => [op, req.mode, req.q])).toEqual([
        ['search', 'autocomplete', query],
        ['search', 'search', query],
    ])
    await expect(page.getByRole('listbox').getByRole('option', { selected: true })).toHaveCount(0)
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
            if (op === 'confirm') { await preview(page); await page.getByRole('button', { name: 'Анализировать по этому адресу', exact: true }).click() }
            else await input(page).fill('Синтетическая 10')
        }
        await expect.poll(() => !!stale).toBe(true)
        const text = await input(page).inputValue(), count = f.calls.length, analyses = f.requests.length
        await mode(page).click(); await mode(page).click()
        await expect(input(page)).toHaveValue(text)
        const req = stale.request().postDataJSON()
        try { await stale.fulfill({ json: envelope(req, op === 'confirm' ? f.selected : { status: 'OK', reason: null, ...(op === 'reverse' ? { point: { lon: req.lon, lat: req.lat } } : {}), candidates: [f.c] }) }) } catch { /* cancelled */ }
        await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0)
        await expect(page.getByRole('region', { name: 'Подтверждение адреса' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Анализировать место', exact: true }))[op === 'reverse' ? 'toBeEnabled' : 'toBeDisabled']()
        expect(f.calls).toHaveLength(count); expect(f.requests).toHaveLength(analyses)
    })
}
test('Geoapify selection expires and reconfirms while local mode keeps ready results', async ({ page }) => {
    const f = await fixtures(page); await page.clock.install({ time: Date.now() }); await page.goto('/'); await mode(page).click(); await preview(page)
    await page.getByRole('button', { name: 'Анализировать по этому адресу', exact: true }).click()
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
            const pointAction = card.getByRole('button', { name: 'Анализировать точку', exact: true })
            const addressAction = card.getByRole('button', { name: 'Анализировать адрес', exact: true })
            await expect(card.getByRole('button', { name: 'Закрыть карточку точки', exact: true })).toBeVisible()
            await expect(card.getByRole('button', { name: 'Отмена', exact: true })).toHaveCount(0)
            if (['address', 'ambiguous'].includes(action)) {
                await expect(card.locator('.pa-point-actions button')).toHaveCount(2)
                if (action === 'ambiguous') {
                    await expect(addressAction).toBeDisabled()
                    await card.getByRole('combobox', { name: 'Ближайший адрес' }).selectOption(places.b.id)
                }
                await expect(addressAction).toBeEnabled()
                const box = await card.boundingBox()
                for (const button of [pointAction, addressAction]) {
                    const area = await button.boundingBox()
                    expect(area.height).toBeGreaterThanOrEqual(44)
                    expect(area.width).toBeLessThan(box.width - 32)
                }
                const a = await pointAction.boundingBox(), b = await addressAction.boundingBox()
                expect(Math.max(b.x - a.x - a.width, b.y - a.y - a.height)).toBeGreaterThanOrEqual(8)
                expect(f.resolutions).toHaveLength(0)
                await addressAction.click()
                await expect(ready(page)).toHaveText('Готово')
                expect(f.resolutions).toEqual([action === 'ambiguous' ? places.b.id : places.a.id])
                expect(f.requests.every(r => r.place.address_id === f.resolutions[0] && !r.analysis_version)).toBe(true)
            } else {
                if (action === 'error') await expect(card).toContainText('Адрес-ориентир недоступен')
                if (action === 'empty' || action === 'error') {
                    await expect(card.locator('.pa-point-actions button')).toHaveCount(1)
                    await expect(addressAction).toHaveCount(0)
                }
                await pointAction.click()
                await expect(ready(page)).toHaveText('Готово')
                expect(f.requests.every(r => r.place.kind === 'point' && r.place.lon === sourcePoint.lon && r.place.lat === sourcePoint.lat)).toBe(true)
                if (action === 'point') {
                    const actions = page.locator('.pa-api-actions')
                    const addressButton = actions.getByRole('button', { name: 'Анализировать адрес', exact: true })
                    const analyze = actions.getByRole('button', { name: 'Анализировать место', exact: true })
                    const addressLabel = actions.getByText('Ближайший адрес:', { exact: true })
                    await expect(addressButton).toBeVisible()
                    const addressBox = await addressButton.boundingBox()
                    const analyzeBox = await analyze.boundingBox()
                    const labelBox = await addressLabel.boundingBox()
                    expect(addressBox.y - analyzeBox.y - analyzeBox.height).toBeGreaterThanOrEqual(8)
                    expect(addressBox.x + addressBox.width).toBeLessThanOrEqual(analyzeBox.x + analyzeBox.width + 1)
                    expect(labelBox.x + labelBox.width).toBeLessThan(addressBox.x)
                    expect(labelBox.y).toBeLessThan(addressBox.y + addressBox.height)
                    expect(labelBox.y + labelBox.height).toBeGreaterThan(addressBox.y)
                }
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
        await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0)
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
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0)
    await expect(page.getByText(places.a.label, { exact: true })).toHaveCount(0)
    await expect(ready(page)).toHaveText('Готово')
    expect(f.requests.map(r => r.place)).toEqual(Array(3).fill({ kind: 'point', lon: sourcePoint.lon, lat: sourcePoint.lat }))
    expect(f.calls).toHaveLength(0)
})

const emptySearchMessages = {
    AVAILABLE: 'Адреса не найдены.',
    UNAVAILABLE: 'Локальный поиск недоступен.',
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
        await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0)
        const actions = page.locator('.pa-search-feedback')
        const clarify = actions.getByRole('button', { name: 'Уточнить адрес' })
        await expect(actions.getByRole('button', { name: 'Выбрать точку', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Точка на карте', exact: true })).toBeInViewport({ ratio: 0.98 })
        if (availability === 'AVAILABLE') {
            await clarify.press('Enter')
            await expect(input(page)).toBeFocused()
            await expect(input(page)).toHaveValue('Несуществующая тестовая улица')
        } else {
            await expect(clarify).toHaveCount(0)
        }
        await page.getByRole('button', { name: 'Точка на карте', exact: true }).press('Enter')
        await expect(page.locator('.pa-map')).toBeFocused()
        await page.keyboard.press('Enter')
        await page.getByRole('button', { name: 'Анализировать точку', exact: true }).click()
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
    const group = page.getByRole('group', { name: shortLabel, exact: true })
    await expect(group.getByRole('option')).toHaveCount(response.data[0].objects.length)
    for (const [index] of response.data[0].objects.entries()) {
        await expect(group.getByRole('option').nth(index)).toHaveAccessibleName(`${shortLabel} · Здание ${index + 1}`)
    }
    expect(f.resolutions).toHaveLength(0)
    await input(page).press('ArrowUp')
    const lastLabel = `${shortLabel} · Здание ${response.data[0].objects.length}`
    await expect(page.getByRole('listbox').getByRole('option', { name: lastLabel, exact: true, selected: true })).toBeInViewport()
    await input(page).press('ArrowDown')
    await input(page).press('ArrowDown')
    await expect(page.getByRole('listbox').getByRole('option', { selected: true })).toHaveAccessibleName(shortLabel + ' · Здание 2')
    await expect(addressMarker(page, 'osm:way:502')).toHaveClass(/is-highlighted/)
    expect(f.resolutions).toHaveLength(0); expect(f.requests).toHaveLength(0)
    await input(page).press('Enter')
    await expect(ready(page)).toHaveText('Готово')
    await expect(page.getByText(shortLabel, { exact: true })).toHaveCount(1)
    await expect(page.getByText(rawLabel, { exact: true })).toHaveCount(0)
    expect(f.resolutions).toEqual(['osm:way:502'])
    expect(f.requests.every(r => r.place.address_id === 'osm:way:502')).toBe(true)
})

test('local groups fit their API bounds and connect list, source geometry and exact map choice', async ({ page }) => {
    const f = await local(page)
    const response = structuredClone(searchResponse('Неоднозначная'))
    const group = response.data[0]
    const building = group.objects[0]
    // The point shares the building marker's anchor. Both must remain clickable.
    const addressPoint = addressObject({ ...building, id: 'osm:node:602' })
    group.objects = [building, addressPoint]
    group.object_count = group.objects.length
    const other = searchResponse(places.b.label).data[0]
    other.match_type = 'approximate'
    response.data.push(other)
    await page.route('**/api/v1/addresses/search?*', route => route.fulfill({ json: response }))
    await page.goto('/')
    await expect.poll(() => page.evaluate(() => !!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await page.evaluate(() => {
        const map = window.__smokeMapIn('.pa-map')
        const original = map.fitBounds.bind(map)
        map.fitBounds = (bounds, options) => {
            window.lastAddressFit = bounds.toArray().flat()
            return original(bounds, options)
        }
    })
    await input(page).fill('Неоднозначная')
    const list = page.getByRole('listbox', { name: 'Локальные адреса' })
    await expect(list.getByRole('group')).toHaveCount(2)
    await expect(list.getByText('Приблизительное совпадение')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.lastAddressFit)).toEqual(group.bounds)
    await expect(addressMarker(page, building.id)).toHaveText('1')
    await expect(addressMarker(page, addressPoint.id)).toHaveText('2')
    await expect.poll(async () => (await addressFeatures(page)).map(item => item.geometry))
        .toEqual([building.geometry, addressPoint.geometry])

    const buildingLabel = `${group.label} · Здание 1`
    const pointLabel = `${group.label} · Адресная точка 2`
    const buildingRow = list.getByRole('button', { name: buildingLabel, exact: true })
    const pointRow = list.getByRole('button', { name: pointLabel, exact: true })
    await buildingRow.hover()
    await expect(addressMarker(page, building.id)).toHaveClass(/is-highlighted/)
    await expect.poll(async () => (await addressFeatures(page)).filter(item => item.properties.highlighted).map(item => item.geometry))
        .toEqual([building.geometry])

    await list.getByRole('button', { name: other.label, exact: true }).focus()
    await expect.poll(() => page.evaluate(() => window.lastAddressFit)).toEqual(other.bounds)
    await expect(addressMarker(page, other.objects[0].id)).toHaveClass(/is-highlighted/)
    await pointRow.focus()
    await expect.poll(() => page.evaluate(() => window.lastAddressFit)).toEqual(group.bounds)
    await expect(addressMarker(page, addressPoint.id)).toHaveClass(/is-highlighted/)
    await expect.poll(async () => (await addressFeatures(page)).filter(item => item.properties.highlighted).map(item => item.geometry))
        .toEqual([addressPoint.geometry])

    const marker = addressMarker(page, addressPoint.id)
    await expect(marker).toHaveAccessibleName(pointLabel + ' · на карте')
    await addressMarker(page, building.id).focus()
    await expect(buildingRow).toHaveClass(/is-active/)
    expect(f.resolutions).toEqual([]); expect(f.requests).toEqual([])
    await marker.click()
    await expect(ready(page)).toHaveText('Готово')
    expect(f.resolutions).toEqual([addressPoint.id])
    expect(f.requests).toHaveLength(3)
    expect(f.requests.every(request => request.place.address_id === addressPoint.id)).toBe(true)
})

for (const destination of ['point', 'mode']) {
    test(`a late local search body cannot reopen preview after switching to ${destination}`, async ({ page }) => {
        const f = await local(page)
        let stale
        await page.route('**/api/v1/addresses/search?*', route => { stale = route })
        await page.addInitScript(() => {
            const fetch = window.fetch.bind(window)
            window.fetch = async (input, options) => {
                if (typeof input !== 'string' || !input.startsWith('/api/v1/addresses/search?')) return fetch(input, options)
                const response = await fetch(input, { ...options, signal: undefined })
                const json = response.json.bind(response)
                response.json = async () => {
                    const body = await json()
                    setTimeout(() => { document.documentElement.dataset.lateSearchRead = 'yes' }, 0)
                    return body
                }
                return response
            }
        })
        await page.goto('/')
        await input(page).fill('Неоднозначная')
        await expect.poll(() => !!stale).toBe(true)
        if (destination === 'point') {
            await point(page)
            await expect(ready(page)).toHaveText('Готово')
        } else {
            await mode(page).click()
            await mode(page).click()
            await expect(mode(page)).toHaveText('Поиск: локальный')
        }
        await stale.fulfill({ json: searchResponse('Неоднозначная') })
        await expect(page.locator('html')).toHaveAttribute('data-late-search-read', 'yes')
        await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0)
        await expect(page.locator('.pa-address-marker')).toHaveCount(0)
        expect(await addressFeatures(page)).toEqual([])
        expect(f.resolutions).toEqual([]); expect(f.calls).toEqual([])
        expect(f.requests).toHaveLength(destination === 'point' ? 3 : 0)
        expect(f.requests.every(request => request.place.kind === 'point')).toBe(true)
    })
}
