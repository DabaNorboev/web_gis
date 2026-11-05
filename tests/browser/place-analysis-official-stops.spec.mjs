import { test, expect } from '@playwright/test'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'

function officialResponse(request, mode) {
    const response = responseFor(request, { poi:'READY' })
    if (!response.blocks.poi) return response
    const b=response.blocks.poi,p=response.place.point
    const item=(id,category,lon,name)=>({id,category,name,address:null,point:{lon,lat:p.lat},geometry:{type:'Point',coordinates:[lon,p.lat]},distance_m:0,access:null,source:category==='official_stop'?'official-stops':'OpenStreetMap',dataset_import_id:category==='official_stop'?9:category==='grocery'?14:15,observed_at:null,source_updated_at:'2025-05-31T00:00:00.000000Z'})
    b.data.items=[item('osm:node:1','grocery',p.lon,'Fixture grocery'),item('osm:node:2','pharmacy',p.lon+.0002,'Fixture pharmacy')]
    if(mode==='ready'||mode==='partial'||mode==='limited')for(const [id,offset] of [['3965',0],['3966',.0008]])b.data.items.push({...item(`official-stop:${id}`,'official_stop',p.lon+offset,'Одноимённая остановка'),source_version:'20250531T1612',source_url:'https://www.24bpd.ru/opendata/2466231215-stoppingpoints/',limitations:'Наличие остановки не подтверждает удобный подход, нужные маршруты или расписание.'})
    b.availability_by_category={}
    for(const c of ['grocery','pharmacy','official_stop','park']){
        const status=c==='park'?'UNAVAILABLE':c==='official_stop'&&mode==='error'?'ERROR':'READY'
        b.availability_by_category[c]={status,code:status==='READY'?null:'CATEGORY_CALCULATION_FAILED',message:`Fixture ${c} ${status}`}
        b.coverage.by_category[c]={status:c==='park'||status==='ERROR'?'UNKNOWN':c==='official_stop'&&(mode==='partial'||mode==='limited')?'PARTIAL':'COVERED',reason:`Fixture ${c} coverage ${mode}`,available_radius_m:null}
        b.completeness.by_category[c]={status:'UNKNOWN',reason:'Полнота сети и актуальность не подтверждены. Нужные маршруты и расписание не гарантируются.'}
    }
    b.data.count=null;b.data.counts_by_category={grocery:1,pharmacy:1,official_stop:mode==='partial'||mode==='limited'||mode==='error'?null:mode==='zero'?0:2,park:null}
    b.data.official_stop_summary={found_count:mode==='error'?null:mode==='zero'?0:mode==='limited'?7:2,source_without_coordinates:2}
    return response
}
for(const mode of ['ready','zero','partial','limited','error'])test(`official stops ${mode}: distinct points, source, selection and other categories`,async({page})=>{
    await page.route('**/api/v1/place-analysis',route=>route.fulfill({json:officialResponse(route.request().postDataJSON(),mode)}))
    await page.goto('/analysis')
    await expect.poll(()=>page.evaluate(()=>!!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await page.getByRole('button',{name:'Точка на карте',exact:true}).focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter')
    await page.getByRole('button',{name:'Анализировать',exact:true}).click()
    await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Готово')
    await page.getByRole('tab',{name:'Объекты',exact:true}).click()
    await page.getByRole('button',{name:`Остановки (${mode==='error'?'—':mode==='zero'?'0':mode==='limited'?'7':'2'})`,exact:true}).click()
    if(mode==='ready'||mode==='partial'||mode==='limited'){
        await expect(page.locator('.pa-objects > li')).toHaveCount(2)
        await expect(page.locator('.pa-stop-found')).toHaveText(`Найдено ${mode==='limited'?7:2} остановочных точек`)
        await expect(page.locator('.pa-stop-unlocated')).toHaveText('В исходном наборе 2 записи без координат. Неизвестно, относятся ли они к этой окрестности')
        await expect(page.locator('.pa-map-marker')).toHaveCount(2)
        const row=page.locator('.pa-objects [data-poi-id="official-stop:3965"] > button');await row.click()
        await expect(page.locator('.pa-map-marker[data-poi-id="official-stop:3965"]')).toHaveAttribute('aria-pressed','true')
        await page.locator('.pa-sources summary').click()
        await expect(page.getByText(/Версия источника: 20250531T1612/)).toBeVisible()
        await expect(page.getByText(/Официальный набор остановок \(24bpd\)/)).toBeVisible()
        await expect(page.getByRole('link',{name:'Паспорт набора'})).toHaveAttribute('href','https://www.24bpd.ru/opendata/2466231215-stoppingpoints/')
        await expect(page.locator('.pa-object-details')).toHaveCount(0)
        await page.getByRole('tab',{name:'Обзор',exact:true}).click()
        const marker=page.locator('.pa-map-marker[data-poi-id="official-stop:3966"]');await marker.focus();await marker.press('Enter')
        await expect(page.locator('.pa-objects [data-poi-id="official-stop:3966"] > button')).toHaveAttribute('aria-pressed','true')
    }else{
        await expect(page.locator('.pa-map-marker')).toHaveCount(0)
        if(mode==='zero')await expect(page.getByText('Найдено 0 точек с координатами',{exact:true})).toBeVisible()
        else {await expect(page.getByRole('status').filter({hasText:'Ошибка категории:'})).toBeVisible();await expect(page.locator('.pa-stop-found')).toHaveCount(0)}
    }
    for(const [label,id] of [['Продукты','osm:node:1'],['Аптеки','osm:node:2']]){
        await page.getByRole('button',{name:`${label} (1)`,exact:true}).click()
        await expect(page.locator(`.pa-objects [data-poi-id="${id}"]`)).toBeVisible()
    }
})

test('official found count follows radius and place; failed category never becomes zero',async({page})=>{
    let fail=false
    await page.route('**/api/v1/place-analysis',route=>{const r=route.request().postDataJSON();return route.fulfill({json:officialResponse(r,fail?'error':r.place.lon>93?'zero':r.radius_m===1000?'limited':'ready')})})
    await page.goto('/analysis')
    await expect.poll(()=>page.evaluate(()=>!!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    async function choose(center){await page.getByRole('button',{name:'Точка на карте',exact:true}).focus();await page.keyboard.press('Enter');if(center)await page.evaluate(async center=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));window.__smokeMapIn('.pa-map').jumpTo({center})},center);await page.keyboard.press('Enter');await page.getByRole('button',{name:'Анализировать',exact:true}).click();await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Готово');await page.getByRole('tab',{name:'Объекты',exact:true}).click()}
    await choose();await page.getByRole('button',{name:'Остановки (2)',exact:true}).click()
    await expect(page.locator('.pa-stop-found')).toHaveText('Найдено 2 остановочных точек')
    await page.locator('#pa-radius-number').fill('1000');await page.locator('#pa-radius-number').press('Tab')
    await expect(page.locator('.pa-stop-found')).toHaveText('Найдено 7 остановочных точек')
    await expect(page.locator('.pa-objects > li')).toHaveCount(2) // A limited list must not redefine found_count.
    // Pan after entering pick mode: focusing the map can resize/refit its viewport.
    await choose([93.1,56.1]);await page.getByRole('button',{name:'Остановки (0)',exact:true}).click()
    await expect(page.locator('.pa-stop-found')).toHaveText('Найдено 0 точек с координатами');await expect(page.locator('.pa-map-marker')).toHaveCount(0)
    fail=true;await page.getByRole('button',{name:'Обновить объекты',exact:true}).click()
    await expect(page.getByRole('status').filter({hasText:'Ошибка категории:'})).toBeVisible();await expect(page.locator('.pa-stop-found')).toHaveCount(0)
})
