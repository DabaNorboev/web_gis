<script setup lang="ts">
import { onMounted, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import type { AddressMapState } from '@/utils/addressMap'
import type { Coordinates } from '@/types/transport'
import { MapPin, MoveUpRight } from '@lucide/vue'
import PlaceLayout from '@/layouts/PlaceLayout.vue'
import SidebarResizeHandle from '@/components/SidebarResizeHandle.vue'
import { useSidebarWidth } from '@/composables/useSidebarWidth'
import { profileUrl } from '@/utils/metricDisplay'
import AddressPicker from '@/components/AddressPicker.vue'
import CityMap from '@/components/map/CityMap.vue'
import TransportResults from '@/components/TransportResults.vue'
import { useTransportAnalysis } from '@/composables/useTransportAnalysis'
import { parsePointSelection, pointSelectionUrl, type PointSelection } from '@/utils/pointSelection'

const workspace = ref<HTMLElement | null>(null)
const sidebar = reactive(useSidebarWidth(workspace, 'home'))
const invalidPointLink = ref(false)
function writePointLocation(selection: PointSelection) {
    invalidPointLink.value = false
    const url = pointSelectionUrl(selection, window.location.search)
    if (url !== window.location.pathname + window.location.search) window.history.pushState(null, '', url)
}
const stopFocus = ref<{ layer: 'stops'; id: string; sequence: number } | null>(null)
function selectStop(id: number) { selectedStopId.value = id; stopFocus.value = { layer: 'stops', id: String(id), sequence: (stopFocus.value?.sequence ?? 0) + 1 } }
const { point, analysis, status, radius, selectedStopId, setRadius, selectPoint, reset, restore } = useTransportAnalysis(writePointLocation)
watch(point, value => { document.title = value ? 'Остановки вокруг точки — PlaceLens' : 'Сравните окружение адресов — PlaceLens' }, { immediate: true })
const addressChoice = shallowRef<AddressMapState>({ groups: [], selectedId: null, highlightedId: null, highlightedGroupId: null })
const picker = ref<InstanceType<typeof AddressPicker> | null>(null)
const searchResetKey = ref(0)
function restorePointLocation() {
    const selection = parsePointSelection(window.location.search)
    invalidPointLink.value = selection.invalid
    searchResetKey.value++
    restore(selection)
}
onMounted(() => { restorePointLocation(); window.addEventListener('popstate', restorePointLocation) })
onBeforeUnmount(() => window.removeEventListener('popstate', restorePointLocation))
function previewAddresses(state: AddressMapState) {
    addressChoice.value = state
    if (state.groups.length && point.value) reset()
}
function confirmAddress(id: string) {
    window.location.assign(profileUrl(id, radius.value))
}
function selectMapPoint(coordinates: Coordinates) {
    searchResetKey.value++
    void selectPoint(coordinates)
}
function resetSelection() {
    searchResetKey.value++
    reset()
}
</script>

<template>
    <PlaceLayout>
        <main id="main-content" tabindex="-1" ref="workspace" class="placelens-workspace" :class="{ 'is-resizable': sidebar.enabled, 'sidebar-is-resizing': sidebar.dragging }" :style="sidebar.style">
            <aside id="home-panel" class="place-panel" :aria-labelledby="point ? 'transport-title' : 'search-title'">
                <div class="place-panel-content" :class="{ 'has-analysis': point || addressChoice.groups.length }">
                    <section v-if="!point && !addressChoice.groups.length" class="place-intro">
                        <div class="intro-eyebrow"><span class="h-px w-6 bg-[#51836b]" /> ВЫБИРАЕТЕ ЖИЛЬЁ В КРАСНОЯРСКЕ</div>
                        <h1 id="intro-title">Сравните окружение<br class="hidden md:block" /> адресов.</h1>
                        <p>Остановки, парки, вода и дороги рядом. Найдите адрес, изучите окружение и добавьте второй вариант для сравнения.</p>
                    </section>

                    <details class="home-search-panel" :class="{ 'home-search-panel--point': point }" :open="!point">
                        <summary v-show="point">Найти адрес вместо точки</summary>
                    <section class="place-search" aria-labelledby="search-title">
                        <h1 v-if="addressChoice.groups.length" id="search-title" class="text-lg font-semibold">Выберите объект адреса</h1>
                        <h2 v-else id="search-title">{{ point ? 'Найти адрес вместо точки' : 'С какого адреса начнём?' }}</h2>
                        <AddressPicker ref="picker" :selected-id="null" :reset-key="searchResetKey" external-map @select="confirmAddress" @map-state="previewAddresses" />
                    </section>
                    </details>
                    <p v-if="!point && !addressChoice.groups.length" class="home-compare-note">Уже знаете оба адреса? <a href="/compare" class="result-action">Перейти к сравнению →</a><span class="block mt-2">Без регистрации · расстояния по прямой</span></p>
                    <p v-if="invalidPointLink" class="result-notice mt-3 text-sm" role="alert">Некорректная ссылка на точку: нужны координаты WGS84 и радиус 300 или 500 м. Выберите точку на карте или найдите адрес через поиск.</p>

                    <div v-if="!point && !addressChoice.groups.length" class="explore-hint">
                        <span class="explore-hint-icon"><MoveUpRight class="size-4" aria-hidden="true" /></span>
                        <p>Нажмите на карту, чтобы узнать<br /> об остановках вокруг точки.</p>
                    </div>
                    <TransportResults v-if="point" :radius="radius" :selected-stop-id="selectedStopId" @radius="setRadius" @select-stop="selectStop" :point="point" :analysis="analysis" :status="status" @retry="selectPoint(point)" @reset="resetSelection" />
                </div>

                <div class="place-panel-footer">
                    <MapPin class="size-5 shrink-0 text-[#51836b]" aria-hidden="true" />
                    <p>Выберите адрес для профиля<br /> или точку для поиска остановок.</p>
                </div>
            </aside>

            <SidebarResizeHandle v-if="sidebar.enabled" :width="sidebar.width" :min="sidebar.bounds.min" :max="sidebar.bounds.max" controls="home-panel" @start="sidebar.pointerDown" @move="sidebar.pointerMove" @end="sidebar.pointerEnd" @key="sidebar.keydown" @reset="sidebar.reset" />
            <section class="placelens-map" aria-label="Карта Красноярска">
                <CityMap :focus-request="stopFocus" @clear-stop="selectedStopId = null" :point="point" :address-group="null" :address-groups="addressChoice.groups" :selected-address-id="addressChoice.selectedId" :highlighted-address-id="addressChoice.highlightedId" :highlighted-group-id="addressChoice.highlightedGroupId" @select-address-object="picker?.selectObjectById($event)" @highlight-address-object="picker?.highlightObjectById($event)" :analysis="analysis" :radius="radius" :selected-stop-id="selectedStopId" @select-stop="selectStop" @select="selectMapPoint" />
            </section>
        </main>
    </PlaceLayout>
</template>
