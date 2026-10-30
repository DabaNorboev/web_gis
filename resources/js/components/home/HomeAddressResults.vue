<script setup lang="ts">
import { computed, ref } from 'vue'
import HomeOrientationButton from './HomeOrientationButton.vue'
import HomeMetricCell from '@/components/home/HomeMetricCell.vue'
import HomeTripCell from '@/components/home/HomeTripCell.vue'
import HomeResultDialog from '@/components/home/HomeResultDialog.vue'
import ComparisonData from '@/components/ComparisonData.vue'
import ComparisonTripData from '@/components/ComparisonTripData.vue'
import ComparisonFacts from '@/components/ComparisonFacts.vue'
import OverviewTopics from '@/components/OverviewTopics.vue'
import { useOverviewTopics } from '@/composables/useOverviewTopics'
import { comparisonGroups, comparisonExtraRows, comparisonMetric, type ComparisonRow } from '@/utils/comparisonPresentation'
import { comparisonRowId } from '@/utils/comparisonFacts'
import { comparisonDifferences, type SideKey } from '@/utils/comparison'
import { pairedTripFact } from '@/utils/comparisonTrips'
import { homeMetricStateText, metricExplanation } from '@/utils/homeMetricPresentation'
import { mappedNearestId } from '@/utils/mapAnalysis'
import type { HomeWorkspace } from '@/composables/useHomeWorkspace'
import type { HomeTripsPort } from '@/types/homeWorkspace'
import type { HomeResultView, HomeTripEntry, HomeTripActions } from '@/types/homeResults'
import type { MapLayerKey } from '@/types/mapLayers'
const props = defineProps<{ model: HomeWorkspace; trips: HomeTripsPort; entries: HomeTripEntry[]; actions: HomeTripActions; view: HomeResultView; expanded: boolean; selectedStopId: number | null; selectedObject: { layer: MapLayerKey; id: string } | null }>()
const emit = defineEmits<{ 'update:view': [view: HomeResultView]; expand: []; focusLayer: [side: SideKey, layer: MapLayerKey, id?: string]; selectStop: [side: SideKey, id: number] }>()
const { includes, selection } = useOverviewTopics()
const showAll = ref(false)
const names = { left: 'А', right: 'Б' }
const tabs = [{ id: 'overview', label: 'Обзор' }, { id: 'trips', label: 'Поездки' }, { id: 'surroundings', label: 'Окружение' }, { id: 'data', label: 'Данные' }] as const
const single = computed(() => props.model.selectedSides.value.length === 1 ? props.model.selectedSides.value[0]! : null)
const selectedMapItem = computed(() => {
    const selection = props.selectedObject, profile = props.model.sides[props.model.activeSide.value].profile
    if (!selection || !profile || selection.layer === 'stops') return null
    const data = selection.layer === 'roads' || selection.layer === 'railways' ? profile.map.linear_layers?.[selection.layer]?.data : profile.map.area_layers?.[selection.layer]?.data
    return data?.features.find(feature => feature.properties.id === selection.id)
})
const rows = computed(() => [...comparisonGroups.flatMap(group => group.rows), ...(showAll.value ? comparisonExtraRows : [])].filter(row => showAll.value || includes(row.category)))
function tabKey(event: KeyboardEvent) {
    if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); document.getElementById('home-result-panel')?.focus(); return }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = tabs.findIndex(tab => tab.id === props.view)
    const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!
    emit('update:view', next.id)
    document.getElementById(`home-result-tab-${next.id}`)?.focus()
}
function showRow(side: SideKey, row: ComparisonRow) {
    const profile = props.model.sides[side].profile
    if (row.category === 'transport') {
        const id = profile?.blocks.transport.data?.nearest_stop?.id
        if (id != null && profile?.map.stops_in_radius.some(stop => stop.id === id)) emit('selectStop', side, id)
        else emit('focusLayer', side, 'stops')
    } else emit('focusLayer', side, row.category, mappedNearestId(profile, row.category))
}
function differences(row: ComparisonRow) {
    if (single.value) return []
    return comparisonDifferences(comparisonMetric(props.model.sides.left.profile, row), comparisonMetric(props.model.sides.right.profile, row), props.model.sides.left.profile?.blocks[row.category].data?.coverage, props.model.sides.right.profile?.blocks[row.category].data?.coverage)
}
function entryFor(side: SideKey, id: string) { return props.entries.find(entry => entry.trip.scenario === 'addresses' && entry.trip.side === side && entry.trip.placeId === id) }
</script>
<template>
    <section class="home-address-results" aria-label="Профиль и сравнение адресов">
        <h2 tabindex="-1" id="home-address-title" class="sr-only">{{ single ? `Профиль ${names[single]}` : model.selectedSides.value.length ? 'Сравнение А/Б' : 'Результаты выбранных мест' }}</h2>
        <div class="home-result-tools">
            <button type="button" class="home-result-expand" :aria-expanded="expanded" aria-controls="home-workspace-results" @click="emit('expand')">{{ expanded ? 'Свернуть результаты' : 'Развернуть результаты' }}</button>
            <div class="home-result-tabs" role="tablist" @keydown="tabKey" aria-label="Раздел результатов">
                <button v-for="tab in tabs" :key="tab.id" :id="`home-result-tab-${tab.id}`" type="button" role="tab" :tabindex="view === tab.id ? 0 : -1" :aria-selected="view === tab.id" aria-controls="home-result-panel" @click="emit('update:view', tab.id)">{{ tab.label }}</button>
            </div>
            <HomeResultDialog title="Как читать результаты" label="Как читать результаты"><p>Каждая колонка относится к выбранному адресному объекту. А — круг, Б — скруглённый квадрат. Числа описывают данные, автоматического победителя нет.</p><p>Окружение измеряется по прямой. Поездки рассчитаны по сети; модельное время не предсказывает обычное городское время. Неизвестное значение не означает ноль. Источники, даты, методы и покрытие доступны у каждой ячейки и в разделе «Данные».</p></HomeResultDialog>
        </div>
        <div id="home-result-panel" role="tabpanel" :aria-labelledby="`home-result-tab-${view}`" tabindex="0">
            <div v-if="!model.selectedSides.value.length" class="home-empty-result"><h2>Здесь будут результаты</h2><p>Найдите и подтвердите адресный объект, чтобы открыть его профиль. Для остановок рядом выберите сценарий «Остановки».</p></div>
            <div v-for="side in model.selectedSides.value" :key="side" :aria-label="`Состояние ${names[side]}`" :aria-busy="model.sides[side].status === 'loading'">
                <p v-if="model.sides[side].status !== 'ready'" :role="model.sides[side].status === 'loading' ? 'status' : 'alert'">{{ names[side] }} · {{ homeMetricStateText(model.sides[side].status) }} <button v-if="!['loading', 'empty'].includes(model.sides[side].status)" type="button" @click="model.loadSide(side)">Повторить {{ names[side] }}</button></p>
            </div>
            <template v-if="view !== 'data' && model.selectedSides.value.length">
                <table class="home-result-table" :class="{ 'is-single': single }">
                    <caption class="sr-only">{{ single ? `Профиль ${names[single]}` : 'Общая матрица А/Б' }} · поездки и окружение</caption>
                    <thead><tr><th scope="col">{{ view === 'surroundings' ? 'Окружение' : 'Места и показатели' }}</th><th v-for="side in model.selectedSides.value" :key="side" scope="col"><span class="home-column-heading"><span class="home-side-badge" :class="{ 'is-b': side === 'right' }">{{ names[side] }}</span><span>{{ model.sides[side].knownAddress?.label ?? model.sides[side].id }}</span></span></th></tr></thead>
                    <tbody v-if="view !== 'surroundings'" class="home-trip-rows">
                        <tr class="home-section-row"><th :colspan="model.selectedSides.value.length + 1" scope="colgroup">Поездки <span>{{ trips.addresses.mode.value === 'walking' ? 'Модель уличной части · подходы неизвестны' : 'Автомодель · без пробок, подходов и парковки' }}</span></th></tr>
                        <tr v-for="place in trips.addresses.places.value" :key="place.id" :data-goal-id="place.id">
                            <th scope="row"><span class="home-goal-label">{{ place.label || 'Без названия' }}</span><HomeOrientationButton :target="{ kind: 'trip', scenario: 'addresses', placeId: place.id, mode: trips.addresses.mode.value }" :label="place.label || 'Без названия'" /><HomeResultDialog v-if="!single" :title="`Сопоставимость: ${place.label || 'Без названия'}`" :label="`Сопоставимость поездок: ${place.label || 'Без названия'}`"><p>{{ pairedTripFact(trips.addresses.cell('left', place.id), trips.addresses.cell('right', place.id), trips.addresses.mode.value) }}</p><p>Сравнивается длина подтверждённых поездок одного источника и снимка; преимущества по неизвестному пути нет.</p></HomeResultDialog></th>
                            <td v-for="side in model.selectedSides.value" :key="side" :data-side="side"><HomeTripCell v-if="entryFor(side, place.id)" :entry="entryFor(side, place.id)!" :actions="actions" :mode="trips.addresses.mode.value" /></td>
                        </tr>
                        <tr v-if="!trips.addresses.places.value.length"><td :colspan="model.selectedSides.value.length + 1" class="home-cell-note">Добавьте общие цели в редакторе слева. Профиль окружения уже доступен.</td></tr>
                    </tbody>
                    <tbody v-if="view !== 'trips'">
                        <tr class="home-section-row"><th :colspan="model.selectedSides.value.length + 1" scope="colgroup">Окружение <span>{{ model.radius.value }} м · расстояния по прямой · входы и доступ не проверены</span></th></tr>
                        <template v-for="row in rows" :key="row.category + row.key">
                            <tr :id="comparisonRowId(row)" tabindex="-1" :data-metric-id="`${row.category}:${row.key}`">
                                <th scope="row"><span>{{ row.label }}</span><HomeOrientationButton v-if="row.category === 'transport' && row.key === 'nearest_stop_distance'" :target="{ kind: 'stop' }" :label="row.label" /><small class="home-metric-caption">{{ metricExplanation(row).short }}</small></th>
                                <td v-for="side in model.selectedSides.value" :key="side" :data-side="side"><HomeMetricCell :row="row" :side="side" :profile="model.sides[side].profile" :status="model.sides[side].status" :radius="model.radius.value" @retry="model.loadSide(side)" @show-map="showRow(side, row)" /></td>
                            </tr>
                            <tr v-if="differences(row).length" class="home-conditions-row"><td :colspan="model.selectedSides.value.length + 1"><ul aria-label="Различия условий сравнения"><li v-for="note in differences(row)" :key="note">{{ note }}</li></ul></td></tr>
                        </template>
                    </tbody>
                </table>
                <template v-if="view !== 'trips'">
                    <button type="button" class="home-all-metrics" :aria-expanded="showAll" @click="showAll = !showAll">{{ showAll ? 'Свернуть все показатели' : 'Все показатели' }}</button>
                    <OverviewTopics compact />
                    <details v-if="!single" class="home-local-details"><summary>Коротко по выбранным темам</summary><ComparisonFacts :sides="model.sides" :radius="model.radius.value" :selected="selection" /></details>
                    <details v-for="side in model.selectedSides.value.filter(side => model.sides[side].profile)" :key="side" class="home-local-details"><summary>Объекты и остановки · {{ names[side] }}</summary>
                        <p>Полнота списка, направления движения, входы и доступ не подтверждены. Слои ограничены кругом анализа.</p>
                        <ul><li v-for="stop in model.sides[side].profile!.map.stops_in_radius" :key="stop.id"><button type="button" :aria-pressed="model.activeSide.value === side && selectedStopId === stop.id" @click="emit('selectStop', side, stop.id)">{{ stop.name }} · {{ Math.round(stop.distance_m) }} м по прямой · на карте {{ names[side] }}</button></li></ul>
                        <p>Одинаковая подпись не определяет направление движения. Каждая кнопка выбирает отдельный объект.</p>
                        <button type="button" @click="emit('focusLayer', side, 'stops')">Показать слой остановок {{ names[side] }}</button>
                        <p v-if="model.activeSide.value === side && selectedObject">Выбрано на карте: {{ selectedMapItem?.properties.name || 'Объект без названия' }} · {{ selectedObject.layer }} · {{ selectedObject.id }}. <button type="button" @click="emit('focusLayer', side, selectedObject.layer, selectedObject.id)">Показать выбранный объект ещё раз</button></p>
                    </details>
                </template>
            </template>
            <div v-else-if="view === 'data' && model.selectedSides.value.length" class="home-results-data">
                <p>Локальные данные: официальный набор остановок и OpenStreetMap. Полнота объектов, входы и доступ на местности не проверены. Подложка карты — отдельный источник и может требовать интернет. Дата публикации и расчёта не заменяет дату наблюдения.</p>
                <ComparisonData v-for="side in model.selectedSides.value.filter(side => model.sides[side].profile)" :key="side" :profile="model.sides[side].profile!" :side="names[side]" />
                <ComparisonTripData :model="trips.addresses" />
            </div>
        </div>
    </section>
</template>
