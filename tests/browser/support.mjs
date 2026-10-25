import { test as base, expect } from '@playwright/test'
import { places, ambiguousPlaces, profile, searchResponse } from './fixtures.mjs'

export const test = base.extend({
    api: async ({ page, context, baseURL }, use, testInfo) => {
        const calls = [], unexpected = [], errors = [], consoleMessages = [], gates = new Map()
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text() }))
        page.on('response', response => {
            if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) unexpected.push(`${response.status()} ${response.url()}`)
        })
        await context.route('**/*', async route => {
            const url = new URL(route.request().url())
            if (url.origin !== new URL(baseURL).origin) {
                unexpected.push(url.href)
                return route.abort('blockedbyclient')
            }
            if (!url.pathname.startsWith('/api/')) return route.continue()
            calls.push(url.pathname + url.search)
            if (url.pathname === '/api/v1/addresses/search') return route.fulfill({ json: searchResponse(url.searchParams.get('q') ?? '') })
            const match = url.pathname.match(/^\/api\/v1\/addresses\/([^/]+)\/profile$/)
            const id = match ? decodeURIComponent(match[1]) : null
            if (id === 'missing') return route.fulfill({ status: 503, json: { message: 'Synthetic unavailable address A' } })
            const place = [...Object.values(places), ...ambiguousPlaces].find(place => place.id === id)
            if (!place) {
                unexpected.push(url.href)
                return route.fulfill({ status: 501, json: { message: 'Unexpected smoke API request' } })
            }
            const gate = gates.get(id)
            if (gate) { gate.requested(); await gate.wait }
            await route.fulfill({ json: profile(place, Number(url.searchParams.get('radius_m'))) })
        })
        const api = {
            calls,
            hold(place) {
                let release, requested
                const wait = new Promise(resolve => { release = resolve })
                const started = new Promise(resolve => { requested = resolve })
                gates.set(place.id, { wait, requested, release })
                return { started, release }
            },
        }
        let checksPassed = false
        try {
            await use(api)
            expect(unexpected, 'no unmocked API or external resource requests').toEqual([])
            expect(errors, 'no uncaught browser errors').toEqual([])
            checksPassed = true
        } finally {
            for (const gate of gates.values()) gate.release()
            if (!checksPassed || testInfo.status !== testInfo.expectedStatus) {
                await testInfo.attach('requests-and-console', { body: JSON.stringify({ calls, unexpected, errors, consoleMessages }, null, 2), contentType: 'application/json' })
                if (!page.isClosed()) await testInfo.attach('dom', { body: await page.locator('body').innerHTML(), contentType: 'text/html' })
            }
        }
    },
})
export { expect }

export async function ready(page) {
    for (const side of ['А', 'Б']) await expect(page.getByRole('region', { name: `Вариант ${side}`, exact: true })).toHaveAttribute('aria-busy', 'false')
}
export async function mapReady(page, allowBasemapError = false) {
    await expect.poll(() => page.evaluate(() => {
        const maps = [...document.querySelectorAll('.comparison-map-frame')].filter(frame => frame.getBoundingClientRect().width > 0 && frame.querySelector('canvas')).map(frame => window.__smokeMapIn?.(`#${frame.id}`))
        return maps.length > 0 && maps.every(map => !!map && map.loaded() && !map.isMoving() && map.getCanvas().clientWidth === map.getContainer().clientWidth && map.getCanvas().clientHeight === map.getContainer().clientHeight)
    }), { message: 'real MapLibre loaded, source updates and camera settled' }).toBe(true)
    if (!allowBasemapError) await expect(page.locator('.comparison-map-frame:visible .map-status')).toHaveCount(0)
}
export async function replaceSide(page, side, place) {
    await page.getByRole('button', { name: `Заменить адрес ${side}`, exact: true }).press('Enter')
    const input = page.getByRole('combobox', { name: 'Адрес в Красноярске', exact: true })
    await expect(input).toBeFocused()
    await input.fill(place.label)
    await expect(page.getByRole('option')).toHaveCount(1)
    await input.press('ArrowDown')
    await input.press('Enter')
}
export async function expectGeometry(page, place) {
    await mapReady(page)
    await expect.poll(() => page.evaluate(async () => {
        const data = await window.__smokeMap().getSource('transport-selection').getData()
        return data.features.filter(feature => feature.properties.kind === 'address-object').map(feature => feature.properties.id)
    })).toEqual([place.id])
    await expect.poll(() => page.evaluate(async () => {
        const data = await window.__smokeMap().getSource('transport-selection').getData()
        return data.features.find(feature => feature.properties.kind === 'point')?.geometry.coordinates
    })).toEqual([place.lon, place.lat])
}
export async function expectMapFits(page) {
    await mapReady(page)
    await expect.poll(() => page.evaluate(() => {
        const toolbar = document.querySelector('.comparison-toolbar').getBoundingClientRect()
        const frames = [...document.querySelectorAll('.comparison-map-frame')].filter(frame => frame.getBoundingClientRect().width > 0)
        return frames.length > 0 && frames.every(frame => ['canvas', '.maplibregl-ctrl-zoom-in', '.maplibregl-ctrl-zoom-out', '.maplibregl-ctrl-scale', '.maplibregl-ctrl-attrib'].every(selector => {
            const rect = frame.querySelector(selector)?.getBoundingClientRect()
            return rect && rect.width > 0 && rect.height > 0 && rect.top >= toolbar.bottom - 1 && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth + 1
        })) && document.querySelector('.comparison-map-return').getBoundingClientRect().bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth
    }), { message: 'each visible canvas, zoom, scale, attribution and return fits below the toolbar' }).toBe(true)
}
