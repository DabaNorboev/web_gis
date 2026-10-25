import { test, expect } from './support.mjs'
import { places } from './fixtures.mjs'

test('profile map fills desktop workspace and floating controls preserve camera, layers and requests', async ({ page, api }, testInfo) => {
    await page.goto(`/address/${encodeURIComponent(places.a.id)}?radius_m=500`)
    await expect(page.getByRole('heading', { name: places.a.label, exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => { const map = window.__smokeMapIn('.address-map'); return !!map && map.loaded() && !map.isMoving() })).toBe(true)
    const desktop = page.viewportSize().width >= 768
    const state = () => page.evaluate(async () => {
        const map = window.__smokeMapIn('.address-map'), r = map.getCanvas().getBoundingClientRect()
        return { camera: [map.getZoom(), map.getCenter().toArray(), map.getBearing(), map.getPitch()], canvas: [r.x,r.y,r.width,r.height], data: await map.getSource('transport-selection').getData() }
    })
    const panel = page.locator('.profile-panel'), map = page.locator('.address-map')
    const toggle = page.getByRole('button', { name: /Слои 0 включено/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    if (desktop) {
        const dimensions = await page.evaluate(() => ({ header: document.querySelector('.placelens-header').getBoundingClientRect().bottom, map: document.querySelector('.address-map').getBoundingClientRect().toJSON(), height:innerHeight, scroll:document.documentElement.scrollHeight }))
        expect(dimensions.map.y).toBe(dimensions.header)
        expect(dimensions.map.bottom).toBe(dimensions.height)
        expect(dimensions.scroll).toBe(dimensions.height)
        await page.getByText('Найти другой адрес', { exact:true }).click()
        await expect(page.getByRole('combobox')).toBeVisible()
        await expect(map).toHaveJSProperty('clientHeight', dimensions.map.height)
        await page.getByText('Найти другой адрес', { exact:true }).click()
    } else {
        await page.getByRole('link', {name:'Карта и слои',exact:true}).click()
    }
    const before = await state(), calls = api.calls.length, url = page.url()
    await toggle.press('Enter')
    await expect(page.getByRole('checkbox', { name:'Остановки',exact:true })).toBeVisible()
    await expect(page.getByRole('checkbox', { name:'Парки',exact:true })).toBeVisible()
    await expect(page.getByRole('checkbox', { name:'Водные объекты',exact:true })).not.toBeVisible()
    expect(await state()).toEqual(before)
    await page.getByRole('checkbox', { name:'Остановки',exact:true }).check()
    await page.getByRole('checkbox', { name:'Парки',exact:true }).check()
    await page.getByText('Дополнительные', { exact:true }).click()
    for (const name of ['Растительные территории','Водные объекты','Крупные дороги','Железнодорожные линии']) await page.getByRole('checkbox', {name,exact:true}).check()
    await page.getByRole('button', {name:'О данных: Парки',exact:true}).press('Enter')
    const body = page.locator('.map-layers-panel--floating .map-layers-body')
    const bodyBox = await body.boundingBox(), zoomBox = await page.getByRole('button',{name:'Приблизить',exact:true}).boundingBox()
    expect(bodyBox.y + bodyBox.height).toBeLessThan(zoomBox.y)
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const sidebarBefore = await panel.evaluate(el=>el.scrollTop)
    await body.hover(); await page.mouse.wheel(0,420)
    await expect.poll(()=>body.evaluate(el=>el.scrollTop)).toBeGreaterThan(0)
    expect(await panel.evaluate(el=>el.scrollTop)).toBe(sidebarBefore)
    await page.getByRole('button',{name:'Закрыть сведения',exact:true}).press('Escape')
    await expect(page.getByRole('button',{name:'О данных: Парки',exact:true})).toBeFocused()
    await page.getByRole('button',{name:'О данных: Парки',exact:true}).press('Escape')
    const activeToggle = page.getByRole('button',{name:/Слои 6 включено/})
    await expect(activeToggle).toBeFocused()
    await expect(activeToggle).toHaveAttribute('aria-expanded','false')
    await expect.poll(()=>page.evaluate(()=>!window.__smokeMapIn('.address-map').isMoving())).toBe(true)
    const enabledState = await state()
    for (let i=0; i<2; i++) {
        await activeToggle.press('Enter'); await activeToggle.press('Escape')
        expect(await state()).toEqual(enabledState)
    }
    await page.getByRole('button',{name:'Улицы',exact:true}).press('Enter')
    await expect(page.locator('.city-map')).toHaveAttribute('data-map-theme','streets')
    expect(await state()).toEqual(enabledState)
    const canvas = page.locator('.address-map canvas'), rect = await canvas.boundingBox()
    let x = rect.x + rect.width*.7, y = rect.y + rect.height*.65
    await page.mouse.move(x,y)
    await page.mouse.wheel(0,350)
    if (desktop) {
        await expect.poll(()=>panel.evaluate(el=>el.scrollTop)).toBeGreaterThan(sidebarBefore)
        expect(await state()).toEqual(enabledState)
    }
    await canvas.scrollIntoViewIfNeeded()
    const currentRect = await canvas.boundingBox()
    x = currentRect.x + currentRect.width*.7; y = currentRect.y + currentRect.height*.65
    await page.mouse.move(x,y)
    await page.keyboard.down('Control'); await page.mouse.wheel(0,-240); await page.keyboard.up('Control')
    await expect.poll(async()=>(await state()).camera[0]).toBeGreaterThan(enabledState.camera[0])
    const zoomed = await state()
    await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x-45,y-30,{steps:8}); await page.mouse.up()
    await expect.poll(async()=>(await state()).camera[1]).not.toEqual(zoomed.camera[1])
    expect(api.calls).toHaveLength(calls)
    expect(page.url()).toBe(url)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await activeToggle.click()
    await testInfo.attach('profile-controls', {body:await page.screenshot({path:testInfo.outputPath('profile-controls.png')}),contentType:'image/png'})
})
