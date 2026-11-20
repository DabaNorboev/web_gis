import { expect } from '@playwright/test'
import { candidate, selection, envelope, iso } from '../../frontend/fixtures/geocoding.mjs'
import { responseFor } from '../../frontend/fixtures/place-analysis.mjs'
export async function fixtures(page, { candidateOverrides = {}, lookupError, confirmError, expired = false, expiresSoon = false } = {}) {
    const calls = [], requests = [], c = candidate(candidateOverrides)
    let current = selection(c, expiresSoon ? { expires_at: iso(7000), snapshot_expires_at: iso(7000) } : expired ? { expires_at: iso(-1000) } : {})
    await page.route('**/api/v1/geocoding/**', async route => {
        const op = route.request().url().split('/').at(-1), req = route.request().postDataJSON()
        calls.push({ op, req })
        expect(route.request().method()).toBe('POST')
        if (lookupError && ['search', 'reverse'].includes(op)) return route.fulfill({ status: 503, json: { code: lookupError, request_id: req.request_id, retry_after_s: null, message: 'PRIVATE_CANARY' } })
        if (confirmError && op === 'confirm') return route.fulfill({ status: 422, json: { code: confirmError, request_id: req.request_id, retry_after_s: null, message: 'PRIVATE_CANARY' } })
        if (op === 'confirm') return route.fulfill({ json: envelope(req, current) })
        if (op === 'reconfirm') {
            current = { ...current, selection_token: 'SYNTHETIC_RENEWED', expires_at: iso(86400000) }
            return route.fulfill({ json: envelope(req, current) })
        }
        const reverse = op === 'reverse'
        return route.fulfill({ json: envelope(req, { status: c.can_confirm ? 'OK' : 'NO_SELECTABLE_RESULTS', reason: c.can_confirm ? null : 'POSITION_REQUIRES_POINT',
            ...(reverse ? { point: { lon: req.lon, lat: req.lat } } : {}), candidates: [{ ...c, ...(reverse ? { reference_distance_m: 12 } : {}) }] }) })
    })
    await page.route('**/api/v1/place-analysis', route => {
        const req = route.request().postDataJSON(); requests.push(req)
        if (req.analysis_version === 2) {
            if (expired && req.place.selection_token !== 'SYNTHETIC_RENEWED') return route.fulfill({ status: 410, json: { code: 'SELECTION_EXPIRED' } })
            const response = responseFor({ ...req, place: { kind: 'point', ...current.place.point } }, { poi: 'READY' })
            return route.fulfill({ json: { ...response, analysis_version: 2, place: current.place } })
        }
        return route.fulfill({ json: responseFor(req, { poi: 'READY' }) })
    })
    return { calls, requests, c, get selected() { return current } }
}
export async function point(page) {
    await page.getByRole('button', { name: 'Точка на карте', exact: true }).click()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Анализировать', exact: true }).click()
}
export async function preview(page) {
    const input = page.getByRole('combobox', { name: 'Поиск адреса' })
    await input.fill(''); await input.fill('Синтетическая 10')
    await page.getByRole('option').first().click()
}
