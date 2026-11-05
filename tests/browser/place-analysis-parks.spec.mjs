import { test,expect } from '@playwright/test'
import { responseFor } from '../frontend/fixtures/place-analysis.mjs'
function parkResponse(request,mode){
    const response=responseFor(request,{poi:'READY'});if(!response.blocks.poi)return response
    const b=response.blocks.poi,p=response.place.point
    const item=(id,category,name)=>({id,category,name,address:null,point:p,geometry:{type:'Point',coordinates:[p.lon,p.lat]},distance_m:0,access:null,source:category==='official_stop'?'official-stops':'OpenStreetMap',dataset_import_id:1,observed_at:null,source_updated_at:null})
    const shape={type:'Polygon',coordinates:[[[p.lon+.0005,p.lat-.0002],[p.lon+.04,p.lat-.0002],[p.lon+.04,p.lat+.0002],[p.lon+.0005,p.lat+.0002],[p.lon+.0005,p.lat-.0002]]]}
    b.data.items=[item('osm:node:1','grocery','Fixture grocery'),item('osm:node:2','pharmacy','Fixture pharmacy'),item('official-stop:3','official_stop','Fixture stop')]
    if(mode==='ready'||mode==='partial')b.data.items.push({...item('osm:node:100','park','Point park fixture'),limitations:'Отметка парка: границы неизвестны. Вход и доступ не подтверждены.'},{...item('osm:way:200','park','Territory park fixture'),geometry:shape,point:{lon:p.lon+.02,lat:p.lat},distance_m:31,limitations:'Расстояние до территории, не до входа.'})
    b.availability_by_category={}
    for(const c of ['grocery','pharmacy','official_stop','park']){
        const status=c==='park'&&mode==='error'?'ERROR':c==='park'&&mode==='unavailable'?'UNAVAILABLE':'READY'
        b.availability_by_category[c]={status,code:status==='READY'?null:'CATEGORY_CALCULATION_FAILED',message:`Fixture ${c} ${status}`}
        b.coverage.by_category[c]={status:status!=='READY'?'UNKNOWN':c==='park'&&mode==='partial'?'PARTIAL':'COVERED',reason:`Fixture ${c} ${mode}`,available_radius_m:null}
        b.completeness.by_category[c]={status:c==='official_stop'?'PARTIAL':'UNKNOWN',reason:'Fixture source limitations'}
    }
    b.data.count=null;b.data.counts_by_category={grocery:1,pharmacy:1,official_stop:null,park:mode==='ready'?2:mode==='zero'?0:null}
    return response
}
for(const mode of ['ready','zero','partial','error','unavailable'])test(`park ${mode}: full contour, point boundary unknown, linked choice and independent categories`,async({page})=>{
    let fixture
    await page.route('**/api/v1/place-analysis',route=>{const r=parkResponse(route.request().postDataJSON(),mode);if(r.blocks.poi)fixture=r;return route.fulfill({json:r})})
    await page.goto('/analysis');await expect.poll(()=>page.evaluate(()=>!!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
    await page.getByRole('button',{name:'Точка на карте',exact:true}).focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Анализировать',exact:true}).click()
    await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Готово');await page.getByRole('tab',{name:'Объекты',exact:true}).click()
    await page.getByRole('button',{name:`Парки (${mode==='ready'?'2':mode==='zero'?'0':'—'})`,exact:true}).click()
    if(mode==='ready'||mode==='partial'){
        await expect(page.locator('.pa-objects > li')).toHaveCount(2)
        await expect(page.getByText('Отметка: границы неизвестны',{exact:true})).toBeVisible()
        await page.locator('.pa-objects [data-poi-id="osm:node:100"] > button').click();await expect(page.locator('.pa-map-marker[data-poi-id="osm:node:100"]')).toHaveAttribute('aria-pressed','true')
        await expect(page.locator('.pa-object-details')).toHaveCount(0)
        await expect.poll(()=>page.evaluate(()=>window.__smokeMapIn('.pa-map').getSource('pa-poi').serialize().data.features[0].geometry)).toEqual(fixture.blocks.poi.data.items.find(i=>i.id==='osm:way:200').geometry)
        const hit=await page.evaluate(p=>{const q=window.__smokeMapIn('.pa-map').project([p.lon+.002,p.lat]);return{x:q.x,y:q.y}},fixture.place.point)
        await page.locator('.pa-map').scrollIntoViewIfNeeded();await page.locator('.pa-map .maplibregl-canvas').click({position:hit})
        await expect(page.locator('.pa-objects [data-poi-id="osm:way:200"] > button')).toHaveAttribute('aria-pressed','true')
        await expect(page.locator('.pa-objects [data-poi-id="osm:way:200"] > button')).toHaveAttribute('aria-pressed','true')
    }else{
        await expect(page.locator('.pa-map-marker')).toHaveCount(0)
        if(mode==='zero')await expect(page.getByText('Объектов рядом: 0',{exact:true})).toBeVisible()
        else await expect(page.getByRole('status').filter({hasText:mode==='error'?'Ошибка категории:':'Категория недоступна:'})).toBeVisible()
    }
    for(const [label,id,count] of [['Продукты','osm:node:1','1'],['Аптеки','osm:node:2','1'],['Остановки','official-stop:3','—']]){
        await page.getByRole('button',{name:`${label} (${count})`,exact:true}).click();await expect(page.locator(`.pa-objects [data-poi-id="${id}"]`)).toBeVisible()
    }
})
