// Controlled synthetic API examples; real Vue, MapLibre and application components.
import { test, expect, ready, mapReady, replaceSide } from './support.mjs'
import { places, profile, comparisonUrl } from './fixtures.mjs'
const storageKey='placelens.overview-topics.v1'
const profileUrl=`/address/${encodeURIComponent(places.a.id)}?radius_m=500`
const settings=page=>page.locator('.overview-topics')
async function openSettings(page) { await settings(page).locator('summary').press('Enter') }
async function selectOnly(page, names) {
    for(const label of ['Остановки','Парки','Вода','Крупные дороги','Железнодорожные пути']) await settings(page).getByRole('checkbox',{name:label,exact:true}).setChecked(names.includes(label))
}
async function mapState(page, selector) {
    await expect.poll(()=>page.evaluate(selector=>{const m=window.__smokeMapIn(selector);return !!m&&m.loaded()&&!m.isMoving()},selector)).toBe(true)
    return page.evaluate(async selector=>{
        const m=window.__smokeMapIn(selector),r=m.getCanvas().getBoundingClientRect()
        return {center:m.getCenter().toArray(),zoom:m.getZoom(),width:r.width,height:r.height,selection:await m.getSource('transport-selection').getData(),objectSelection:await m.getSource('analysis-object-selection').getData(),selectedId:document.querySelector(`${selector} .city-map-object`)?.dataset.selectedId,layers:m.getStyle().layers.filter(l=>l.id.startsWith('analysis-')||l.id.startsWith('transport-')).map(l=>[l.id,l.layout?.visibility])}
    },selector)
}
function controlled(place,radius=500) {
    const p=profile(place,radius)
    for(const topic of ['parks','water','roads','railways']) {p.blocks[topic].data.metrics.nearest_distance.key=`${topic}_nearest_distance`;p.blocks[topic].data.metrics.nearest_distance.method_version='synthetic-v1'}
    return p
}

test('shared topics preserve maps, requests and history, expose all metrics, empty choice and reset across pages',async({page,api})=>{
    await page.goto(profileUrl)
    await expect(page.getByRole('heading',{name:places.a.label,exact:true})).toBeVisible()
    await expect(settings(page)).toContainText('исходный обзор')
    await page.getByRole('article').filter({has:page.getByRole('heading',{name:'Ближайший парк',exact:true})}).getByRole('button').press('Enter')
    const before=await mapState(page,'.address-map'),calls=api.calls.length,url=page.url(),history=await page.evaluate(()=>history.length)
    await openSettings(page);await selectOnly(page,['Вода'])
    const parkChoice=settings(page).getByRole('checkbox',{name:'Парки',exact:true})
    await parkChoice.press('Space');await expect(parkChoice).toBeChecked()
    await parkChoice.press('Space');await expect(parkChoice).not.toBeChecked()
    await expect(page.getByRole('heading',{name:'Вода',exact:true})).toBeVisible()
    await expect(page.getByRole('heading',{name:'Ближайший парк',exact:true})).not.toBeVisible()
    await expect(settings(page)).toContainText('Обзор настроен')
    await page.getByText('Все показатели',{exact:true}).press('Enter')
    await expect(page.getByRole('heading',{name:'Ближайший парк',exact:true})).toBeVisible()
    await expect(page.getByRole('heading',{name:'Ближайшая остановка',exact:true})).toBeVisible()
    await selectOnly(page,[])
    await expect(settings(page)).toContainText('Темы не выбраны')
    await settings(page).getByRole('button',{name:'Настроить обзор',exact:true}).press('Enter')
    await expect(settings(page).getByRole('checkbox',{name:'Остановки',exact:true})).toBeFocused()
    await selectOnly(page,['Вода'])
    const after=await mapState(page,'.address-map')
    if(page.viewportSize().width>=768) expect(after).toEqual(before)
    else {expect(after.center).toEqual(before.center);expect(after.zoom).toBe(before.zoom);expect(after.selection).toEqual(before.selection);expect(after.objectSelection).toEqual(before.objectSelection);expect(after.selectedId).toBe(before.selectedId);expect(after.layers).toEqual(before.layers)}
    expect(api.calls.length).toBe(calls);expect(page.url()).toBe(url);expect(await page.evaluate(()=>history.length)).toBe(history)
    expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),storageKey)).toEqual(['water'])
    await page.reload();await expect(page.getByRole('heading',{name:places.a.label,exact:true})).toBeVisible()
    await expect(settings(page)).toContainText('1/5 тем')
    await page.goto(comparisonUrl());await ready(page)
    await expect(settings(page).locator('summary')).toContainText('Вода')
    await expect(page.getByRole('group',{name:'Вода',exact:true})).toBeVisible()
    await expect(page.getByRole('group',{name:'Ближайший парк',exact:true})).not.toBeVisible()
    await openSettings(page)
    const comparisonBefore=await mapState(page,'#compare-map-left'), compareCalls=api.calls.length
    await settings(page).getByRole('button',{name:'Сбросить к исходному обзору',exact:true}).press('Enter')
    await expect(page.getByRole('group',{name:'Ближайший парк',exact:true})).toBeVisible()
    expect(await mapState(page,'#compare-map-left')).toEqual(comparisonBefore)
    expect(api.calls.length).toBe(compareCalls)
    expect(await page.evaluate(key=>localStorage.getItem(key),storageKey)).toBeNull()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('summary compares both sides at displayed precision and focuses far rows without changing URL',async({page,api})=>{
    const a=controlled(places.a),b=controlled(places.b)
    a.blocks.transport.data.metrics.nearest_stop_distance.value=100
    b.blocks.transport.data.metrics.nearest_stop_distance.value=200
    a.blocks.parks.data.metrics.nearest_distance.value=200
    b.blocks.parks.data.metrics.nearest_distance.value=0
    a.blocks.water.data.metrics.nearest_distance.value=600.1
    b.blocks.water.data.metrics.nearest_distance.value=600.4
    await page.route('**/api/v1/addresses/*/profile*',route=>route.fulfill({json:decodeURIComponent(route.request().url()).includes(places.a.id)?a:b}))
    await page.goto(comparisonUrl());await ready(page)
    const summary=page.getByRole('region',{name:'Коротко по выбранным темам',exact:true})
    await expect(summary.getByRole('link')).toHaveCount(3)
    await expect(summary).toContainText('У адреса А остановка ближе по прямой')
    await expect(summary).toContainText('У адреса Б парк ближе по прямой (0 м против 200 м)')
    await expect(summary).toContainText('одинаково при показанной точности — 600 м по прямой')
    await expect(summary).toContainText('Дата наблюдения неизвестна')
    const url=page.url(),calls=api.calls.length
    await summary.getByRole('link').last().press('Enter')
    const row=page.locator('#compare-metric-water-nearest_distance')
    await expect(row).toBeFocused();await expect(row.locator(':scope > details')).toHaveAttribute('open','')
    expect(await row.evaluate(e=>parseFloat(getComputedStyle(e).outlineWidth))).toBeGreaterThanOrEqual(2)
    await expect(row).toBeInViewport()
    expect(page.url()).toBe(url);expect(api.calls.length).toBe(calls)
    await openSettings(page);await selectOnly(page,['Крупные дороги','Железнодорожные пути'])
    await expect(summary.getByRole('link')).toHaveCount(2)
    await expect(summary).not.toContainText('остановка ближе')
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('storage failure and unknown or old settings keep working controls and only topic identifiers',async({page,api})=>{
    await page.addInitScript(()=>{localStorage.setItem('placelens.overview-topics.v0','{"addresses":["old"]}');localStorage.setItem('placelens.overview-topics.v1','["unknown","parks","parks"]')})
    await page.goto(profileUrl);await expect(page.getByRole('heading',{name:places.a.label,exact:true})).toBeVisible()
    await openSettings(page)
    await expect(settings(page).getByRole('checkbox',{checked:true})).toHaveCount(1)
    await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new Error('controlled storage failure')};Storage.prototype.removeItem=function(){throw new Error('controlled storage failure')}})
    const calls=api.calls.length
    await settings(page).getByRole('checkbox',{name:'Вода',exact:true}).check()
    await expect(settings(page).getByRole('status')).toContainText('Не удалось сохранить')
    await expect(page.getByRole('heading',{name:'Вода',exact:true})).toBeVisible()
    await settings(page).getByRole('button',{name:'Сбросить к исходному обзору',exact:true}).click()
    await expect(settings(page)).toContainText('исходный обзор')
    expect(api.calls.length).toBe(calls)
    await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new Error('denied')}})})
    await page.reload();await expect(page.getByRole('heading',{name:places.a.label,exact:true})).toBeVisible()
    await expect(settings(page)).toContainText('исходный обзор')
    await expect(settings(page).getByRole('status')).toContainText('Не удалось сохранить')
})

test('summary clears old facts during replacement and radius change, rejects late delivery and leaves chosen errors visible',async({page,api})=>{
    let releaseRadius
    const radiusGate=new Promise(resolve=>releaseRadius=resolve)
    await page.route('**/api/v1/addresses/*/profile*',async route=>{
        const u=new URL(route.request().url()),id=decodeURIComponent(u.pathname.split('/').at(-2)),place=Object.values(places).find(p=>p.id===id),p=controlled(place,Number(u.searchParams.get('radius_m')))
        p.blocks.transport.data.metrics.nearest_stop_distance.value=place===places.a?50:200
        if(place===places.c) p.blocks.railways={status:'ERROR',data:null,message:'Синтетический отказ путей'}
        if(place===places.d) p.blocks.water.data.coverage.status='UNKNOWN'
        if(p.radius_m===300) await radiusGate
        return route.fulfill({json:p})
    })
    await page.addInitScript(()=>{
        window.__lateReady=false;window.__lateRelease=null;window.__holdLate=true
        const original=window.fetch.bind(window)
        window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('303/profile')&&window.__holdLate){window.__holdLate=false;const data=await response.json();window.__lateReady=true;await new Promise(resolve=>window.__lateRelease=resolve);return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})}return response}
    })
    await page.goto(comparisonUrl());await ready(page)
    const summary=page.getByRole('region',{name:'Коротко по выбранным темам',exact:true})
    await expect(summary).toContainText('У адреса А остановка ближе')
    await replaceSide(page,'А',places.c)
    await expect.poll(()=>page.evaluate(()=>window.__lateReady)).toBe(true)
    await expect(summary).toContainText('предварительно')
    await expect(summary).not.toContainText('У адреса А')
    await replaceSide(page,'А',places.d);await ready(page)
    await expect(summary).toContainText('покрытия')
    const text=await summary.innerText()
    await page.evaluate(()=>window.__lateRelease());await expect(summary).toHaveText(text,{useInnerText:true})
    await page.getByRole('button',{name:'300 м',exact:true}).click()
    await expect(summary).toHaveCount(0)
    releaseRadius();await ready(page)
    await expect(summary).toContainText('покрытия')
    await page.goBack();await ready(page);await expect(page.getByRole('button',{name:'500 м',exact:true})).toHaveAttribute('aria-pressed','true')
    await openSettings(page);await selectOnly(page,['Железнодорожные пути'])
    await replaceSide(page,'А',places.c);await ready(page)
    await expect(summary).toContainText('сравнение неполное')
    await expect(page.locator('#compare-metric-railways-nearest_distance')).toContainText('Синтетический отказ путей')
    await expect(page.locator('#compare-metric-railways-nearest_distance')).toBeVisible()
})

test('partial response keeps row focus and group order as far metrics arrive',async({page,api})=>{
    let release
    const gate=new Promise(resolve=>release=resolve)
    await page.route('**/api/v1/addresses/*/profile*',async route=>{
        const place=decodeURIComponent(route.request().url()).includes(places.a.id)?places.a:places.b
        const p=controlled(place)
        p.blocks.water.data.metrics.nearest_distance.value=600
        if(place===places.b) await gate
        await route.fulfill({json:p})
    })
    try {
        await page.goto(comparisonUrl())
        const summary=page.getByRole('region',{name:'Коротко по выбранным темам',exact:true})
        await expect(summary).toContainText('предварительно')
        await summary.getByRole('link').last().press('Enter')
        const row=page.locator('#compare-metric-water-nearest_distance')
        await expect(row).toBeFocused()
        const order=await page.locator('.comparison-category > h2').allTextContents()
        release();await ready(page)
        await expect(row).toBeFocused()
        expect(await page.locator('.comparison-category > h2').allTextContents()).toEqual(order)
        await expect(summary).toContainText('одинаково при показанной точности — 600 м')
    } finally {release()}
})
