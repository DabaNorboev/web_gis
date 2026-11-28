import {test,expect} from '@playwright/test'
import {responseFor} from '../frontend/fixtures/place-analysis.mjs'
import {pointReference} from '../frontend/fixtures/point-address-reference.mjs'
async function setup(page,partial=false){
 const calls=[]
 await page.route('**/api/v1/addresses/resolve-point',r=>r.fulfill({json:pointReference()}))
 await page.route('**/api/v1/place-analysis',route=>{const request=route.request().postDataJSON();calls.push(request);const result=responseFor(request,{poi:'READY'});if(partial&&result.blocks.poi){
  const poi=result.blocks.poi
  poi.coverage.status='PARTIAL'
  poi.coverage.by_category.park.status='OUTSIDE_SERVICE_AREA'
  poi.coverage.by_category.official_stop.status='UNKNOWN'
  poi.data.counts_by_category.park=null
  poi.data.counts_by_category.official_stop=null
  poi.data.count=null
  poi.availability_by_category=Object.fromEntries(Object.keys(poi.data.counts_by_category).map(category=>[category,
   category==='official_stop' ? {status:'ERROR',code:'CATEGORY_CALCULATION_FAILED',message:'Fixture error'} : {status:'READY',code:null,message:'Fixture ready'}]))
 }return route.fulfill({json:result})})
 await page.goto('/analysis');await expect.poll(()=>page.evaluate(()=>!!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
 await pick(page);await page.getByRole('button',{name:'Анализировать точку',exact:true}).click();await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Готово');return calls
}
async function pick(page){await page.getByRole('button',{name:'Точка на карте',exact:true}).focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'Выбранная точка'})).toBeVisible()}
test('pending card stays above markers; selected marker stays at its geographic screen anchor; explicit reverse belongs to search',async({page})=>{
 await setup(page)
 await page.getByRole('button',{name:'Поиск: локальный',exact:true}).click()
 await expect(page.getByRole('button',{name:'Найти адрес поблизости',exact:true})).toBeVisible()
 await expect(page.locator('.pa-header__controls .pa-place-button')).toHaveCount(0)
 await expect(page.locator('.pa-sidebar-search').getByRole('button', { name: 'Точка на карте' })).toBeVisible()
 await expect(page.locator('[data-geocoding] button').filter({hasText:'Найти адрес поблизости'})).toHaveCount(1)
 await expect(page.locator('.pa-point-reference')).toHaveCount(1)
 await page.getByRole('tab',{name:'Объекты',exact:true}).click();await page.getByRole('button',{name:'Аптеки (1)',exact:true}).click()
 const marker=page.locator('.pa-map-marker[data-poi-id="osm:node:1"]')
 const center=()=>marker.evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})
 const before=await center();await page.locator('.pa-objects [data-poi-id="osm:node:1"] > button').click();const after=await center()
 expect(Math.abs(after.x-before.x)).toBeLessThan(1);expect(Math.abs(after.y-before.y)).toBeLessThan(1)
 await pick(page)
 // Force a marker to the point-card centre through the real MapLibre API;
 // its z-index must remain confined to the map's stacking context.
 await page.evaluate(()=>{const map=window.__smokeMapIn('.pa-map');map.jumpTo({center:[map.getCenter().lng,map.getCenter().lat]})})
 const above=await page.locator('.pa-point-card').evaluate(card=>{const r=card.getBoundingClientRect();const hits=[[.5,.15],[.5,.5],[.5,.85]].map(([x,y])=>document.elementFromPoint(r.x+r.width*x,r.y+r.height*y));return hits.every(el=>card.contains(el))})
 expect(above).toBe(true)
 await expect(page.getByText('Результаты API.',{exact:false})).toHaveCount(0)
})
test('overview shows real counts and independent states; refresh and details are separate actions',async({page})=>{
 const calls=await setup(page,true)
 const poi=page.locator('[data-analysis-block="poi"]'),sat=page.locator('[data-analysis-block="satellite"]'),air=page.locator('[data-analysis-block="air"]')
 await expect(poi).toHaveClass(/is-partial/);await expect(poi.getByText('Данные загружены частично',{exact:true})).toBeVisible()
 await expect(poi.locator('.pa-card__counts')).toContainText('Аптеки');await expect(poi.locator('.pa-card__counts dd')).toContainText(['0','1','Ошибка','Вне покрытия'])
 await expect(sat).toHaveClass(/is-unavailable/);await expect(sat).toContainText('Спутниковые снимки пока недоступны.')
 await expect(air).toHaveClass(/is-unavailable/);await expect(air).toContainText('Данные о станциях и наблюдениях пока недоступны.')
 await expect(page.getByText('Покрытие: COVERED.',{exact:false})).toHaveCount(0)
 await expect(page.getByText('Полнота: PARTIAL.',{exact:false})).toHaveCount(0)
 const old=calls.length;await poi.getByRole('button',{name:'Обновить объекты',exact:true}).click();await expect.poll(()=>calls.length).toBe(old+1);expect(calls.at(-1).blocks).toEqual(['poi'])
 await poi.getByRole('button',{name:'Открыть объекты',exact:true}).click();await expect(page.getByRole('tab',{name:'Объекты',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('tab',{name:'Объекты',exact:true})).toBeFocused()
 await page.getByRole('tab',{name:'Обзор',exact:true}).click();await sat.getByRole('button',{name:'Открыть спутник',exact:true}).click();await expect(page.getByRole('tab',{name:'Снимки и NDVI',exact:true})).toHaveAttribute('aria-selected','true')
 await page.getByRole('tab',{name:'Обзор',exact:true}).click();await air.getByRole('button',{name:'Открыть воздух',exact:true}).click();await expect(page.getByRole('tab',{name:'Воздух',exact:true})).toHaveAttribute('aria-selected','true')
 expect(calls.length).toBe(old+1)
})

test('map tools are grouped on desktop and open beside zoom on phones', async ({ page }) => {
    await page.goto('/analysis')
    const toolbar = page.getByRole('group', { name: 'Управление картой' })
    const surface = page.locator('.pa-map')
    const theme = toolbar.getByLabel('Тема подложки карты')
    const mobileToggle = toolbar.getByRole('button', { name: 'Вид карты' })
    const layers = page.locator('#pa-layers-body')
    await expect(layers).toBeHidden()
    if (await mobileToggle.isVisible()) {
        await expect(theme).toBeHidden()
        await mobileToggle.press('Enter')
        await expect(layers).toBeVisible()
        const menu = await page.locator('#pa-map-settings').boundingBox()
        const toggle = await mobileToggle.boundingBox()
        expect(menu.x).toBeGreaterThanOrEqual(0)
        expect(menu.x + menu.width).toBeLessThanOrEqual(toggle.x)
    } else {
        const bar = await toolbar.boundingBox()
        const map = await surface.boundingBox()
        expect(bar.y + bar.height).toBeLessThanOrEqual(map.y)
        await toolbar.getByRole('button', { name: 'Слои карты' }).press('Enter')
        await expect(layers).toBeVisible()
        await layers.getByRole('checkbox', { name: 'Объекты (POI)' }).press('Escape')
        await expect(layers).toBeHidden()
    }
    await theme.selectOption('dark')
    await expect(page.locator('.pa-map-host')).toHaveAttribute('data-map-theme', 'dark')
    if (await mobileToggle.isVisible()) {
        await toolbar.getByRole('button', { name: '2D' }).press('Escape')
        await expect(theme).toBeHidden()
        await expect(mobileToggle).toBeFocused()
    }
    const zoom = () => page.evaluate(() => window.__smokeMapIn('.pa-map').getZoom())
    const initialZoom = await zoom()
    await toolbar.getByRole('button', { name: 'Приблизить карту' }).press('Enter')
    await expect.poll(zoom).toBeCloseTo(initialZoom + 1, 2)
    await toolbar.getByRole('button', { name: 'Отдалить карту' }).press('Enter')
    await expect.poll(zoom).toBeCloseTo(initialZoom, 2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (!(await mobileToggle.isVisible())) {
        await page.setViewportSize({ width: 821, height: 560 })
        const bar = await toolbar.boundingBox()
        const zoomOut = await toolbar.getByRole('button', { name: 'Отдалить карту' }).boundingBox()
        expect(zoomOut.x + zoomOut.width).toBeLessThanOrEqual(bar.x + bar.width)
    }
})
