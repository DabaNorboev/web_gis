import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule, loadComponent } from './support/vue-component.mjs'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'
import { mapDependencies, cityMapDependencies } from './support/map-dependencies.mjs'

function unexpectedMapUse() { throw new Error('SSR map-mode test must not mount MapLibre') }
const addressMap = loadModule(new URL('../../resources/js/utils/addressMap.ts', import.meta.url))
const component = loadComponent(new URL('../../resources/js/components/map/CityMap.vue', import.meta.url), cityMapDependencies({
    ...mapDependencies, ...addressMap, Map: unexpectedMapUse, NavigationControl: unexpectedMapUse, ScaleControl: unexpectedMapUse, setWorkerUrl: unexpectedMapUse, workerUrl: 'worker', basemap: { sources: {}, layers: [] },
}))
const props = { point: null, addressGroup: null, selectedAddressId: null, analysis: null, radius: 500, selectedStopId: null }

test('map retains point analysis by default while address profile disables arbitrary point selection', async () => {
    const home = await ssr.renderToString(vue.createSSRApp(component, props))
    assert.match(home, /Анализировать центр карты/)
    const profile = await ssr.renderToString(vue.createSSRApp(component, { ...props, selectable: false }))
    assert.doesNotMatch(profile, /Анализировать центр карты/)
    assert.match(profile, /Интерактивная карта Красноярска/)
})
