<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import PlaceLayout from '@/layouts/PlaceLayout.vue'
import AddressPicker from '@/components/AddressPicker.vue'
import CityMap from '@/components/map/CityMap.vue'
import MapLayersPanel from '@/components/map/MapLayersPanel.vue'
import type { LinearVisibility } from '@/types/profile'
import type { AreaVisibility } from '@/types/profile'
import ProfileSummary from '@/components/ProfileSummary.vue'
import SidebarResizeHandle from '@/components/SidebarResizeHandle.vue'
import { useSidebarWidth } from '@/composables/useSidebarWidth'
import { useAddressProfile } from '@/composables/useAddressProfile'
import { profileUrl } from '@/utils/metricDisplay'
import { comparisonUrl } from '@/utils/comparison'
import type { AddressProfile } from '@/types/profile'
import type { AddressResult } from '@/types/address'
import type { MapLayerKey } from '@/types/mapLayers'

const props = defineProps<{ id: string }>()
const workspace = ref<HTMLElement | null>(null)
const profilePanel = ref<HTMLElement | null>(null)
const sidebar = reactive(useSidebarWidth(workspace, 'profile'))
const parsedRadius = Number(new URLSearchParams(window.location.search).get('radius_m'))
const { radius, profile, status, load, setRadius } = useAddressProfile(props.id, [300, 500].includes(parsedRadius) ? parsedRadius : 500)
const knownAddress = ref<AddressProfile['address'] | null>(null)
const knownPoint = ref<AddressProfile['point'] | null>(null)
const selectedStopId = ref<number | null>(null)
const view = ref<'overview' | 'data'>(window.location.hash === '#profile-sources' ? 'data' : 'overview')
function restoreView() { if (window.location.hash === '#profile-sources') view.value = 'data' }
function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    view.value = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'data' : view.value === 'overview' ? 'data' : 'overview'
    document.getElementById(`profile-tab-${view.value}`)?.focus()
}
const cityMap = ref<InstanceType<typeof CityMap> | null>(null)
const selectedObject = ref<{ layer: MapLayerKey; id: string } | null>(null)
const showStops = ref(false)
const linearVisibility = ref<LinearVisibility>({ roads: false, railways: false })
const areaVisibility = ref<AreaVisibility>({ parks: false, vegetation: false, water: false })
const mapFocus = ref<{ layer: MapLayerKey; id?: string; sequence: number } | null>(null)
async function focusLayer(key: MapLayerKey, id?: string) {
    if (key === 'stops') showStops.value = true
    else if (key === 'roads' || key === 'railways') linearVisibility.value = { ...linearVisibility.value, [key]: true }
    else areaVisibility.value = { ...areaVisibility.value, [key]: true }
    mapFocus.value = { layer: key, id, sequence: (mapFocus.value?.sequence ?? 0) + 1 }
    await nextTick()
    document.getElementById('profile-map-title')?.focus({ preventScroll: true })
    document.getElementById('profile-map')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
async function selectStop(id: number) {
    cityMap.value?.clearObjectSelection(); selectedStopId.value = id; showStops.value = true
    mapFocus.value = { layer: 'stops', id: String(id), sequence: (mapFocus.value?.sequence ?? 0) + 1 }
    await nextTick()
    document.getElementById('profile-map-title')?.focus({ preventScroll: true })
    document.getElementById('profile-map')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
watch(showStops, visible => { if (!visible) selectedStopId.value = null })
const mapAddress = computed<AddressResult | null>(() => knownAddress.value ? {
    id: knownAddress.value.id, label: knownAddress.value.label, match_type: 'exact', object_count: 1,
    bounds: knownAddress.value.bounds, objects: [knownAddress.value.object],
} : null)
function chooseAddress(id: string) {
    window.location.assign(profileUrl(id, radius.value))
}
function changeRadius(value: number) {
    const url = new URL(window.location.href)
    url.searchParams.set('radius_m', String(value))
    if (value === radius.value) return
    window.history.pushState(null, '', url)
    setRadius(value)
}
watch(profile, value => {
    selectedStopId.value = null
    mapFocus.value = null
    selectedObject.value = null
    if (value) {
        knownAddress.value = value.address
        knownPoint.value = value.point
        document.title = `${value.address.label} — PlaceLens`
    }
})
function restoreRadius() {
    const value = Number(new URLSearchParams(window.location.search).get('radius_m'))
    setRadius([300, 500].includes(value) ? value : 500)
}
onMounted(() => { void load(); window.addEventListener('popstate', restoreRadius); window.addEventListener('hashchange', restoreView) })
onBeforeUnmount(() => { window.removeEventListener('popstate', restoreRadius); window.removeEventListener('hashchange', restoreView) })
</script>

<template>
    <PlaceLayout>
        <main id="main-content" tabindex="-1" ref="workspace" class="address-workspace" :class="{ 'is-resizable': sidebar.enabled, 'sidebar-is-resizing': sidebar.dragging }" :style="sidebar.style" :aria-busy="status === 'loading'">
            <section ref="profilePanel" class="profile-panel" aria-label="Профиль выбранного адреса">
                <header id="profile-heading" class="address-heading">
                    <a href="/" class="profile-link">← Поиск и карта города</a>
                    <p class="mt-5 text-xs uppercase tracking-widest text-[#637769]">Окружение адреса</p>
                    <h1 class="mt-2 text-2xl font-semibold leading-tight sm:text-3xl">{{ knownAddress?.label ?? 'Профиль адреса' }}</h1>
                    <div class="address-toolbar">
                        <fieldset>
                            <legend class="mb-2 text-xs text-[#637769]">Радиус анализа по прямой</legend>
                            <button v-for="value in [300, 500]" :key="value" type="button" class="mr-2 rounded-lg border px-4 py-2 text-sm" :class="radius === value ? 'bg-[#2d6450] text-white' : 'bg-white'" :aria-pressed="radius === value" @click="changeRadius(value)">{{ value }} м</button>
                        </fieldset>
                        <a v-if="profile" :href="comparisonUrl({ left: profile.address.id, right: null, radius })" class="profile-link">Сравнить с другим адресом →</a>
                    </div>
                    <nav class="workspace-jumps profile-mobile-jumps" aria-label="Разделы профиля"><a href="#profile-map">Карта и слои</a></nav>
                    <details class="address-change">
                        <summary>Найти другой адрес</summary>
                        <div class="mt-3"><AddressPicker :selected-id="props.id" @select="chooseAddress" /></div>
                        <p class="address-note mt-2">До нажатия на новый объект профиль и основная карта относятся к прежнему адресу.</p>
                    </details>
                </header>
                <div id="profile-results" class="address-content">
                    <div class="profile-tabs" role="tablist" aria-label="Содержимое профиля" @keydown="tabKey">
                        <button id="profile-tab-overview" type="button" role="tab" aria-controls="profile-overview" :aria-selected="view === 'overview'" :tabindex="view === 'overview' ? 0 : -1" @click="view = 'overview'">Обзор</button>
                        <button id="profile-tab-data" type="button" role="tab" aria-controls="profile-sources" :aria-selected="view === 'data'" :tabindex="view === 'data' ? 0 : -1" @click="view = 'data'">О данных</button>
                    </div>
                    <p v-if="status === 'loading'" role="status">Загружаем профиль и рассчитываем окружение…</p>
                    <div v-else-if="status !== 'ready'" class="result-notice" role="alert">
                        <h2 class="font-semibold">{{ status === 'not_found' ? 'Объект не найден в наборе' : status === 'unavailable' ? 'Набор адресов недоступен' : 'Не удалось загрузить профиль' }}</h2>
                        <p class="mt-2">{{ status === 'not_found' ? 'Проверьте ссылку или выберите адрес через поиск. Отсутствие в наборе не доказывает отсутствие объекта на местности.' : 'Попробуйте повторить запрос или найдите другой адрес.' }}</p>
                        <button type="button" class="profile-action mt-2" @click="load">Повторить запрос</button>
                    </div>
                    <ProfileSummary v-else-if="profile" :profile="profile" :selected-object="selectedObject" :view="view" :selected-stop-id="selectedStopId" @retry="load" @select-stop="selectStop" @focus-layer="focusLayer" />
                </div>
            </section>
            <SidebarResizeHandle v-if="sidebar.enabled" :width="sidebar.width" :min="sidebar.bounds.min" :max="sidebar.bounds.max" controls="profile-heading profile-results" @start="sidebar.pointerDown" @move="sidebar.pointerMove" @end="sidebar.pointerEnd" @key="sidebar.keydown" @reset="sidebar.reset" />
            <aside id="profile-map" class="address-map-column" aria-label="Карта выбранного объекта и радиуса">
                <h2 id="profile-map-title" class="sr-only" tabindex="-1">Окружение на карте</h2>
                <div class="placelens-map address-map">
                    <CityMap ref="cityMap" :profile="profile" @select-object="selectedObject = $event" @clear-stop="selectedStopId = null" :scroll-target="profilePanel" overlay-controls :point="knownPoint" :address-group="mapAddress" :selected-address-id="knownAddress?.id ?? null" :analysis="profile?.map ?? null" :radius="radius" :selected-stop-id="selectedStopId" :show-stops="showStops" :area-layers="profile?.map.area_layers ?? null" :area-visibility="areaVisibility" :linear-layers="profile?.map.linear_layers ?? null" :linear-visibility="linearVisibility" :focus-request="mapFocus" :selectable="false" @select-stop="selectStop">
                        <template #controls>
                            <MapLayersPanel floating v-model:stops="showStops" v-model:areas="areaVisibility" v-model:lines="linearVisibility" :contexts="[{ key: 'address', label: knownAddress?.label ?? 'Выбранный адрес', profile, loading: status === 'loading', selectedStop: selectedStopId !== null }]" @focus-layer="focusLayer" />
                        </template>
                    </CityMap>
                </div>
                <p class="address-note profile-map-note px-4 pb-4">{{ profile ? 'На карте — выбранный объект, точка анализа и радиус. Остановки включаются переключателем; выбор в списке также включает слой. Контур не обозначает вход.' : knownPoint ? 'Точка адреса сохранена. Результаты для выбранного радиуса обновляются.' : 'Точка и окружение появятся после загрузки профиля.' }} Подложка может требовать интернета.</p>
                <a href="#profile-results" class="result-action profile-map-return mx-3 mb-3 inline-block">↑ К показателям</a>
            </aside>
        </main>
    </PlaceLayout>
</template>
