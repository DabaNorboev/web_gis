<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { Layers, Satellite, Wind, RotateCw, ChevronRight, ShoppingBasket, Pill, BusFront, Trees } from '@lucide/vue'
import type { AnalysisBlockKey, AnalysisBlock, AnalysisPoi, PoiCategory } from '@/types/placeAnalysis'
import type { AnalysisBlockState } from '@/composables/usePlaceAnalysis'

const props = defineProps<{
    canLoad: boolean
    tab: 'overview' | 'objects' | 'satellite' | 'air'
    blocks: Record<AnalysisBlockKey, AnalysisBlockState>
    selectedPoi: string | null
    category: PoiCategory | 'all'
    date: string
    stationRadius: number
    selectedIds: string[]
}>()
const emit = defineEmits<{
    open: [key: AnalysisBlockKey]; load: [key: AnalysisBlockKey]; category: [key: PoiCategory | 'all']; poi: [id: string]; station: [id: string]
    date: [value: string]; 'station-radius': [value: number]; 'station-selection': [value: string[]]
}>()
const names = { poi: 'Объекты (POI)', satellite: 'Спутниковые снимки', air: 'Станции мониторинга воздуха' }
const categories: Record<PoiCategory, string> = { grocery: 'Продукты', pharmacy: 'Аптеки', official_stop: 'Остановки', park: 'Парки' }
const keys = computed<AnalysisBlockKey[]>(() => props.tab === 'overview' ? ['poi', 'satellite', 'air'] : [props.tab === 'objects' ? 'poi' : props.tab])
function result(key: AnalysisBlockKey): AnalysisBlock | undefined { return props.blocks[key].response?.blocks[key] }
function status(key: AnalysisBlockKey): string {
    const s = props.blocks[key]
    if (s.phase === 'idle') return 'Требуется явный запуск анализа.'
    if (s.phase === 'loading') return 'Загрузка…'
    if (s.phase === 'ready') return 'Готово'
    if (s.phase === 'unavailable') return 'Данные недоступны'
    if (s.error?.kind === 'timeout') return 'Время ожидания истекло'
    if (s.error?.kind === 'invalid_response') return 'Получен несогласованный ответ'
    if (s.error?.kind === 'network') return 'Сеть недоступна'
    if (s.error?.status === 429) return 'Лимит запросов; повторите позже'
    if (s.error?.code === 'ADDRESS_NOT_FOUND') return 'Адрес не найден в активном наборе'
    if (s.error?.code === 'ADDRESS_SOURCE_UNAVAILABLE') return 'Набор адресов недоступен'
    return 'Ошибка загрузки блока'
}
const poi = computed(() => props.blocks.poi.response?.blocks.poi)
const items = computed<AnalysisPoi[]>(() => poi.value?.status === 'READY' ? poi.value.data.items.filter(p => props.category === 'all' || p.category === props.category) : [])
const visibleCategories = computed(() => props.category === 'all' ? Object.keys(categories) as PoiCategory[] : [props.category])
const distanceFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const stopSummary = computed(() => poi.value?.status === 'READY' ? poi.value.data.official_stop_summary : undefined)
function categoryCount(category: PoiCategory) {
    if (category === 'official_stop') return stopSummary.value?.found_count ?? '—'
    return poi.value?.status === 'READY' ? poi.value.data.counts_by_category[category] ?? '—' : '—'
}
const foundSummary = computed(() => {
    if (poi.value?.status !== 'READY') return ''
    const data = poi.value.data
    const selected = visibleCategories.value
    if (selected.some(c => poi.value?.availability_by_category?.[c]?.status === 'ERROR') && selected.length === 1) return 'Не удалось загрузить объекты.'
    if (selected.some(c => poi.value?.availability_by_category?.[c]?.status === 'UNAVAILABLE') && selected.length === 1) return 'Данные этой категории пока недоступны.'
    const counts = selected.map(c => c === 'official_stop' ? stopSummary.value?.found_count : data.counts_by_category[c])
    if (counts.some(n => n == null)) return `Показано объектов: ${items.value.length}. Данные загружены частично.`
    const count = counts.reduce<number>((sum, n) => sum + (n ?? 0), 0)
    if (props.category === 'official_stop') return count === 0 ? 'Найдено 0 точек с координатами' : `Найдено ${count} остановочных точек`
    return `Объектов рядом: ${count}`
})
const sources = computed(() => [...new Map(items.value.map(item => [
    `${item.source}:${item.dataset_import_id}:${item.source_version ?? item.source_updated_at}`,
    item,
])).values()])
const satellite = computed(() => props.blocks.satellite.response?.blocks.satellite)
const air = computed(() => props.blocks.air.response?.blocks.air)
const cardNames = { poi: 'Объекты рядом', satellite: 'Спутник', air: 'Воздух' }
const cardIcons = { poi: Layers, satellite: Satellite, air: Wind }
const categoryIcons = { grocery: ShoppingBasket, pharmacy: Pill, official_stop: BusFront, park: Trees }
const actionNames = { poi: 'объекты', satellite: 'спутник', air: 'воздух' }
function partial(key: AnalysisBlockKey): boolean {
    if (key !== 'poi' || poi.value?.status !== 'READY') return false
    return Object.keys(categories).some(value => {
        const c = value as PoiCategory
        return (poi.value?.availability_by_category?.[c]?.status ?? 'READY') !== 'READY'
            || poi.value?.coverage?.by_category?.[c]?.status !== 'COVERED'
            || poi.value?.completeness?.by_category?.[c]?.status === 'PARTIAL'
    })
}
function tone(key: AnalysisBlockKey): string { return partial(key) ? 'partial' : props.blocks[key].phase }
function countLabel(category: PoiCategory): number | string {
    const state = poi.value?.availability_by_category?.[category]?.status
    if (state === 'ERROR') return 'Ошибка'
    if (state === 'UNAVAILABLE') return 'Нет данных'
    const count = categoryCount(category)
    return count === '—' ? 'Неизвестно' : count
}
function summary(key: AnalysisBlockKey): string {
    const state = props.blocks[key]
    if (state.phase === 'idle') return props.canLoad ? 'Данные ещё не загружены.' : 'Выберите место для анализа.'
    if (state.phase === 'loading') return 'Получаем данные…'
    if (state.phase === 'error') return 'Не удалось загрузить данные. Попробуйте обновить.'
    if (state.phase === 'unavailable') return key === 'satellite' ? 'Спутниковые снимки пока недоступны.' : key === 'air' ? 'Данные о станциях и наблюдениях пока недоступны.' : 'Данные об объектах недоступны.'
    if (key === 'poi') return partial(key) ? 'Данные загружены частично' : 'Данные загружены'
    if (key === 'satellite' && satellite.value?.status === 'READY') {
        const dates = satellite.value.data.available_dates
        return dates.length ? `Доступно дат съёмки: ${dates.length}. Последняя: ${[...dates].map(d => d.date).sort().at(-1)?.split('-').reverse().join('.')}.` : 'Доступных снимков нет.'
    }
    if (key === 'air' && air.value?.status === 'READY') {
        const stations = air.value.data.stations
        return stations.length ? `Станций в справочнике: ${stations.length}. ${stations[0]!.name} · ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(stations[0]!.distance_m / 1000)} км по прямой.` : 'В используемом справочнике станции не найдены.'
    }
    return 'Данных нет.'
}

function toggleStation(id: string) {
    const next = props.selectedIds.includes(id) ? props.selectedIds.filter(value => value !== id) : [...props.selectedIds, id]
    if (next.length <= 20) {
        emit('station-selection', next)
        // Selection invalidates this result; keep focus on the stable explicit reload action.
        void nextTick(() => document.getElementById('pa-load-air')?.focus())
    }
}
</script>

<template>
    <h1 class="pa-title">{{ tab === 'overview' ? 'Анализ выбранного места' : tab === 'objects' ? names.poi : names[tab] }}</h1>
    <template v-if="tab === 'satellite'">
        <label class="pa-field"><span>Дата снимка</span><input class="pa-select" type="date" :value="date" @change="emit('date', ($event.target as HTMLInputElement).value)"></label>
        <p class="pa-note">Без даты запрашивается каталог подготовленных дат.</p>
    </template>
    <template v-if="tab === 'air'">
        <label class="pa-field"><span>Радиус выбора станций, м</span><input class="pa-select" type="number" min="1000" max="20000" step="1000" :value="stationRadius" @change="emit('station-radius', Number(($event.target as HTMLInputElement).value))"></label>
        <p class="pa-note">Выбор станций независим от круга места. Измерение станции не является измерением в выбранной точке.</p>
        <button v-for="id in selectedIds" :key="id" class="pa-outline" type="button" @click="toggleStation(id)">Убрать из выбора: {{ id }}</button>
    </template>
    <article v-for="key in keys" :key="key" class="pa-card pa-card--analysis" :class="`is-${tone(key)}`" :data-analysis-block="key" :aria-busy="blocks[key].phase === 'loading'">
        <div class="pa-card__head">
            <span class="pa-card__glyph" :class="{ 'pa-card__glyph--sat': key === 'satellite', 'pa-card__glyph--air': key === 'air' }"><component :is="cardIcons[key]" :size="20" aria-hidden="true" /></span>
            <div><h2>{{ cardNames[key] }}</h2><p role="status" class="pa-card__status">{{ status(key) }}</p></div>
            <button :id="`pa-load-${key}`" class="pa-card__refresh" type="button" :aria-label="`${blocks[key].phase === 'idle' ? 'Загрузить' : 'Обновить'} ${actionNames[key]}`" :title="`${blocks[key].phase === 'idle' ? 'Загрузить' : 'Обновить'} ${actionNames[key]}`" :disabled="!canLoad || blocks[key].phase === 'loading'" @click="emit('load', key)"><RotateCw :size="16" aria-hidden="true" /></button>
        </div>
        <p class="pa-card__summary">{{ summary(key) }}</p>
        <dl v-if="tab === 'overview' && key === 'poi' && poi?.status === 'READY'" class="pa-card__counts">
            <div v-for="(label, categoryKey) in categories" :key="categoryKey"><dt><component :is="categoryIcons[categoryKey]" :class="`pa-summary-icon--${categoryKey}`" :size="15" aria-hidden="true" />{{ label }}</dt><dd>{{ countLabel(categoryKey) }}</dd></div>
        </dl>
        <button v-if="tab === 'overview'" class="pa-card__open" type="button" :aria-label="`Открыть ${actionNames[key]}`" @click="emit('open', key)">Подробнее<ChevronRight :size="15" aria-hidden="true" /></button>
    </article>
    <template v-if="tab === 'objects' && poi?.status === 'READY'">
        <p class="pa-found-summary" :class="{ 'pa-stop-found': category === 'official_stop' && stopSummary?.found_count != null && !['ERROR', 'UNAVAILABLE'].includes(poi.availability_by_category?.official_stop?.status ?? '') }" role="status">{{ foundSummary }}</p>
        <div class="pa-chips" role="group" aria-label="Категории объектов">
            <button class="pa-chip" :class="{ 'is-active': category === 'all' }" :aria-pressed="category === 'all'" type="button" @click="emit('category', 'all')"><Layers :size="14" aria-hidden="true" />Все</button>
            <button v-for="(label, key) in categories" :key="key" class="pa-chip" :class="{ 'is-active': category === key }" :aria-pressed="category === key" type="button" @click="emit('category', key)"><component :is="categoryIcons[key]" :size="14" aria-hidden="true" />{{ label }} ({{ categoryCount(key) }})</button>
        </div>
        <template v-for="categoryKey in visibleCategories" :key="categoryKey">
            <p v-if="poi.availability_by_category?.[categoryKey]?.status !== undefined && poi.availability_by_category[categoryKey].status !== 'READY'" class="pa-note" role="status">{{ categories[categoryKey] }}: {{ poi.availability_by_category[categoryKey].status === 'ERROR' ? 'Ошибка категории' : 'Категория недоступна' }}: {{ poi.availability_by_category[categoryKey].message }}</p>
            <p v-if="categoryKey === 'official_stop' && stopSummary?.source_without_coordinates" class="pa-note pa-stop-unlocated">В исходном наборе {{ stopSummary.source_without_coordinates }} записи без координат. Неизвестно, относятся ли они к этой окрестности</p>
        </template>
        <ul class="pa-objects">
            <li v-for="(item, index) in items" :key="item.id" :data-poi-id="item.id">
                <button class="pa-object" type="button" :aria-pressed="selectedPoi === item.id" :class="{ 'is-selected': selectedPoi === item.id }" @click="emit('poi', item.id)"><span class="pa-object__number" aria-hidden="true">{{ index + 1 }}</span><span class="pa-object__body"><strong><component :is="categoryIcons[item.category]" :class="`pa-summary-icon--${item.category}`" :size="14" aria-hidden="true" />{{ item.name ?? 'Без названия' }}</strong><small>{{ distanceFormat.format(item.distance_m) }} м по прямой<span v-if="item.address"> · {{ item.address }}</span></small><small v-if="item.identity_note">{{ item.identity_note }}</small><small v-if="item.category === 'park' && item.geometry.type === 'Point'">Отметка: границы неизвестны</small></span></button>
            </li>
        </ul>
        <details v-if="sources.length" class="pa-sources">
            <summary>Источники данных</summary>
            <div v-for="source in sources" :key="`${source.source}:${source.dataset_import_id}:${source.source_version ?? source.source_updated_at}`">
                <p>Источник: {{ source.source === 'official-stops' ? 'Официальный набор остановок (24bpd)' : source.source }} · снимок {{ source.dataset_import_id ?? 'неизвестен' }}</p>
                <p>Версия источника: {{ source.source_version ?? source.source_updated_at ?? 'неизвестна' }}</p>
                <a v-if="source.source_url" :href="source.source_url" target="_blank" rel="noopener noreferrer">Паспорт набора</a>
            </div>
        </details>
    </template>
    <template v-if="tab === 'satellite' && satellite?.status === 'READY'">
        <p v-for="available in satellite.data.available_dates" :key="available.scene_id"><button class="pa-outline" type="button" @click="emit('date', available.date)">{{ available.date }}</button></p>
        <p v-if="satellite.data.available_dates.length === 0" class="pa-note">В используемом каталоге нет подготовленных дат.</p>
        <p class="pa-note">NDVI не равен доле растительности. Отображение изображений будет доступно с подготовленными слоями.</p>
    </template>
    <template v-if="tab === 'air' && air?.status === 'READY'">
        <ul class="pa-stations"><li v-for="station in air.data.stations" :key="station.id">
            <button class="pa-station" type="button" @click="emit('station', station.id)">{{ station.name }} · {{ station.distance_m }} м · {{ station.group }}</button>
            <button class="pa-outline" type="button" :disabled="!selectedIds.includes(station.id) && selectedIds.length >= 20" @click="toggleStation(station.id)">{{ selectedIds.includes(station.id) ? 'Убрать станцию из выбора' : 'Включить станцию в выбор' }}</button>
        </li></ul>
        <p v-if="air.data.missing_selected_ids.length" class="pa-note">В справочнике не найдены: {{ air.data.missing_selected_ids.join(', ') }}</p>
    </template>
</template>
