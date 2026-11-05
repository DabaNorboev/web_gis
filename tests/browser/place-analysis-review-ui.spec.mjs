import {test,expect} from '@playwright/test'
import {responseFor} from '../frontend/fixtures/place-analysis.mjs'
import {pointReference} from '../frontend/fixtures/point-address-reference.mjs'
async function setup(page,partial=false){
 const calls=[]
 await page.route('**/api/v1/addresses/resolve-point',r=>r.fulfill({json:pointReference()}))
 await page.route('**/api/v1/place-analysis',route=>{const request=route.request().postDataJSON();calls.push(request);const result=responseFor(request,{poi:'READY'});if(partial&&result.blocks.poi){result.blocks.poi.coverage.by_category.park.status='UNKNOWN';result.blocks.poi.data.counts_by_category.park=null;result.blocks.poi.data.count=null}return route.fulfill({json:result})})
 await page.goto('/analysis');await expect.poll(()=>page.evaluate(()=>!!window.__smokeMapIn('.pa-map')?.isStyleLoaded())).toBe(true)
 await pick(page);await page.getByRole('button',{name:'Анализировать',exact:true}).click();await expect(page.locator('[data-analysis-block="poi"] [role="status"]')).toHaveText('Готово');return calls
}
async function pick(page){await page.getByRole('button',{name:'Точка на карте',exact:true}).focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'Выбранная точка'})).toBeVisible()}
test('pending card stays above markers; selected marker stays at its geographic screen anchor; reference belongs to analysis actions',async({page})=>{
 await setup(page)
 await expect(page.locator('.pa-api-actions .pa-point-reference')).toBeVisible()
 await expect(page.locator('.pa-header__controls .pa-place-button')).toHaveCount(0)
 await expect(page.locator('.pa-map-pick')).toBeVisible()
 const primary=await page.locator('.pa-api-actions__main > .pa-primary').boundingBox(),reference=await page.locator('.pa-api-actions .pa-point-reference').boundingBox()
 expect(Math.abs(primary.x-reference.x)).toBeLessThan(1);expect(reference.y).toBeGreaterThanOrEqual(primary.y+primary.height+10)
 await expect(page.locator('.pa-panel__scroll .pa-point-reference')).toHaveCount(0)
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
 await expect(page.locator('.pa-map-style__label')).toHaveText('Тема');await expect(page.locator('.pa-map-style__label')).toBeVisible()
 await expect(page.getByText('Результаты API.',{exact:false})).toHaveCount(0)
})
test('overview shows real counts and independent states; refresh and details are separate actions',async({page})=>{
 const calls=await setup(page,true)
 const poi=page.locator('[data-analysis-block="poi"]'),sat=page.locator('[data-analysis-block="satellite"]'),air=page.locator('[data-analysis-block="air"]')
 await expect(poi).toHaveClass(/is-partial/);await expect(poi.getByText('Данные загружены частично',{exact:true})).toBeVisible()
 await expect(poi.locator('.pa-card__counts')).toContainText('Аптеки');await expect(poi.locator('.pa-card__counts dd')).toContainText(['0','1','Неизвестно','Неизвестно'])
 await expect(sat).toHaveClass(/is-unavailable/);await expect(sat).toContainText('Спутниковые снимки пока недоступны.')
 await expect(air).toHaveClass(/is-unavailable/);await expect(air).toContainText('Данные о станциях и наблюдениях пока недоступны.')
 await expect(page.getByText('Покрытие: COVERED.',{exact:false})).toHaveCount(0)
 await expect(page.getByText('Полнота: PARTIAL.',{exact:false})).toHaveCount(0)
 const old=calls.length;await poi.getByRole('button',{name:'Обновить объекты',exact:true}).click();await expect.poll(()=>calls.length).toBe(old+1);expect(calls.at(-1).blocks).toEqual(['poi'])
 await poi.getByRole('button',{name:'Открыть объекты',exact:true}).click();await expect(page.getByRole('tab',{name:'Объекты',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('tab',{name:'Объекты',exact:true})).toBeFocused()
 await page.getByRole('tab',{name:'Обзор',exact:true}).click();await sat.getByRole('button',{name:'Открыть спутник',exact:true}).click();await expect(page.getByRole('tab',{name:'Спутник',exact:true})).toHaveAttribute('aria-selected','true')
 await page.getByRole('tab',{name:'Обзор',exact:true}).click();await air.getByRole('button',{name:'Открыть воздух',exact:true}).click();await expect(page.getByRole('tab',{name:'Воздух',exact:true})).toHaveAttribute('aria-selected','true')
 expect(calls.length).toBe(old+1)
})
