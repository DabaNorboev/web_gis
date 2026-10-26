import { test, expect } from './support.mjs'
import { places, profile } from './fixtures.mjs'
const url = `/address/${encodeURIComponent(places.a.id)}?radius_m=500`
const ready = async page => expect(page.getByRole('heading', {name:places.a.label,exact:true})).toBeVisible()

test('profile tabs support keyboard without changing history, keep radius and mobile map navigation', async ({page,api}) => {
    await page.goto(url); await ready(page)
    const overview=page.getByRole('tab',{name:'Обзор',exact:true}), data=page.getByRole('tab',{name:'О данных',exact:true})
    const initial=page.url(), calls=api.calls.length
    await overview.press('ArrowRight'); await expect(data).toBeFocused(); await expect(data).toHaveAttribute('aria-selected','true')
    await expect(page.getByRole('tabpanel')).toHaveCount(1)
    await expect(page.getByRole('tabpanel')).toContainText('Дата наблюдения: неизвестна')
    await expect(page.getByRole('heading',{name:'Транспорт',exact:true})).not.toBeVisible()
    await data.press('Home'); await expect(overview).toBeFocused()
    await overview.press('End'); await expect(data).toBeFocused()
    expect(page.url()).toBe(initial); expect(api.calls).toHaveLength(calls)
    await page.getByRole('button',{name:'300 м',exact:true}).press('Enter')
    await expect(page.locator('#profile-sources')).toBeVisible()
    await page.goBack(); await expect(page.getByRole('button',{name:'500 м',exact:true})).toHaveAttribute('aria-pressed','true')
    await page.goForward(); await expect(page.getByRole('button',{name:'300 м',exact:true})).toHaveAttribute('aria-pressed','true')
    await page.reload(); await ready(page)
    await expect(overview).toHaveAttribute('aria-selected','true')
    const jump=page.getByRole('link',{name:'Карта и слои',exact:true})
    if(page.viewportSize().width<768) {
        await jump.press('Enter')
        await expect(page.locator('.address-map canvas')).toBeInViewport()
        await page.getByRole('link',{name:'↑ К показателям',exact:true}).press('Enter')
        await expect(overview).toBeInViewport()
    } else await expect(jump).not.toBeVisible()
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('profile radius distinguishes distant objects from unknown coverage and zero; data exceptions stay separate', async ({page,api}) => {
    const p=profile(places.a), water=p.blocks.water.data, park=p.blocks.parks.data
    park.metrics.nearest_distance.value=0
    p.blocks.roads.data.metrics.nearest_distance.value=501
    water.metrics.nearest_distance.value=650;water.coverage.status='UNKNOWN';water.coverage.reason='Синтетическая проверка: неизвестное покрытие воды'
    water.nearest={id:'water-1',name:'Длинное название водного объекта '.repeat(15)}
    water.metrics.nearest_distance.observed_at='2026-10-17T00:00:00Z'
    water.metrics.nearest_distance.source_updated_at='2026-10-18T00:00:00Z'
    water.metrics.nearest_distance.quality.freshness='STALE'
    p.blocks.railways={status:'ERROR',data:null,message:'Синтетический отказ железнодорожных данных'}
    await page.route('**/api/v1/addresses/*/profile*',route=>route.fulfill({json:p}))
    await page.goto(url);await ready(page)
    await expect(page.getByRole('article').filter({has:page.getByRole('heading',{name:'Ближайший парк',exact:true})})).toContainText('0 м')
    await expect(page.getByText('Крупная дорога — за кругом 500 м',{exact:true})).toBeVisible()
    await expect(page.getByText('501 м',{exact:true})).not.toBeVisible()
    await page.getByText('Крупная дорога — за кругом 500 м',{exact:true}).press('Enter')
    await expect(page.getByText('501 м',{exact:true})).toBeVisible()
    await expect(page.getByText('650 м',{exact:true})).toBeVisible()
    await expect(page.locator('#profile-overview')).toContainText(water.coverage.reason)
    await expect(page.locator('#profile-overview')).toContainText('Синтетический отказ железнодорожных данных')
    await page.getByRole('tab',{name:'О данных',exact:true}).press('Enter')
    const waterSource=page.locator('.address-source').filter({hasText:'Дата наблюдения: 17.10.2026'})
    await expect(waterSource).toHaveCount(1); await expect(waterSource).toContainText('актуальность: устаревшие')
    await expect(waterSource).toContainText('18.10.2026');await expect(waterSource).toContainText(water.coverage.reason)
    await waterSource.getByText('Метод и технические сведения',{exact:true}).press('Enter')
    await expect(waterSource).toContainText('ID снимка: 1')
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('nearest stop is first; same names retain per-object selection; missing nearest is distinct from zero points', async ({page,api}) => {
    const p=profile(places.a), t=p.blocks.transport.data
    t.nearest_stop.name='Длинное название ближайшей остановки '.repeat(10)
    t.stops_in_radius[1].name=t.stops_in_radius[2].name='Общее название'
    await page.route('**/api/v1/addresses/*/profile*',route=>route.fulfill({json:p}))
    await page.goto(url);await ready(page)
    await expect(page.locator('#profile-overview')).toContainText(t.nearest_stop.name)
    await expect(page.locator('.profile-stop-button').first()).not.toBeVisible()
    await page.getByRole('button',{name:'Показать остановку на карте',exact:true}).press('Enter')
    await expect(page.locator('.city-map-object')).toContainText('Выбранная остановка')
    await page.getByText('Другие остановки и число в круге',{exact:true}).press('Enter')
    const choices=page.getByRole('list',{name:'Остальные остановки профиля'}).getByRole('button')
    await expect(choices).toHaveCount(3)
    const first=choices.filter({hasText:'Объект 1 · Общее название'}),second=choices.filter({hasText:'Объект 2 · Общее название'})
    for(const [button,id] of [[first,t.stops_in_radius[1].id],[second,t.stops_in_radius[2].id]]) {
        await button.press('Enter');await expect(button).toHaveAttribute('aria-pressed','true')
        await expect.poll(()=>page.evaluate(async()=>{const m=window.__smokeMapIn('.address-map');if(!m?.getSource('transport-selection'))return null;const d=await m.getSource('transport-selection').getData();return d.features.find(f=>f.properties.kind==='selected-stop')?.properties.id})).toBe(id)
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    t.nearest_stop=null;t.stops_in_radius=[];t.metrics.stops_count.value=0
    t.metrics.nearest_stop_distance.value=null;t.metrics.nearest_stop_distance.quality.availability='INSUFFICIENT_DATA'
    await page.reload();await ready(page)
    await expect(page.locator('#profile-overview')).toContainText('Недостаточно данных')
    await expect(page.locator('#profile-overview')).not.toContainText('Ближайшая остановка — за кругом')
    await page.getByText('Другие остановки и число в круге',{exact:true}).press('Enter')
    await expect(page.locator('#profile-overview')).toContainText('0 точек остановок')
})
