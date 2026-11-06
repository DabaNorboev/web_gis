<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { Layers, Satellite, Wind, RotateCw, ChevronRight, ShoppingBasket, Pill, BusFront, Trees, TriangleAlert } from '@lucide/vue'
import type {
    AnalysisBlockKey, AnalysisBlock, AnalysisPoi, PoiCategory, SatelliteData, SatelliteReleaseRef, SatelliteSelected,
} from '@/types/placeAnalysis'
import type { AnalysisBlockState } from '@/composables/usePlaceAnalysis'
import type { SatelliteMode } from '@/place-analysis'
import {
    coverageReasons, formatCircleFraction, formatMeanNdvi, formatObservationDate, formatObtainedAt,
    satelliteCatalogLabel, satelliteReasonLabel, satelliteWarnings,
} from '@/utils/satellite'

const props = defineProps<{
    canLoad: boolean
    tab: 'overview' | 'objects' | 'satellite' | 'air'
    blocks: Record<AnalysisBlockKey, AnalysisBlockState>
    selectedPoi: string | null
    category: PoiCategory | 'all'
    date: string
    satelliteMode: SatelliteMode
    satelliteCatalog: SatelliteData | null
    stationRadius: number
    selectedIds: string[]
}>()
const emit = defineEmits<{
    open: [key: AnalysisBlockKey]; load: [key: AnalysisBlockKey]; category: [key: PoiCategory | 'all']; poi: [id: string]; station: [id: string]
    date: [value: string]; 'satellite-mode': [value: SatelliteMode]; 'station-radius': [value: number]; 'station-selection': [value: string[]]
}>()
const names = { poi: 'Объекты (POI)', satellite: 'Спутниковые снимки', air: 'Станции мониторинга воздуха' }
const categories: Record<PoiCategory, string> = { grocery: 'Продукты', pharmacy: 'Аптеки', official_stop: 'Остановки', park: 'Парки' }
const keys = computed<AnalysisBlockKey[]>(() => props.tab === 'overview' ? ['poi', 'satellite', 'air'] : [props.tab === 'objects' ? 'poi' : props.tab])
function result(key: AnalysisBlockKey): AnalysisBlock | undefined { return props.blocks[key].response?.blocks[key] }
function status(key: AnalysisBlockKey): string {
    const s = props.blocks[key]
    if (s.phase === 'idle') return 'Требуется явный запуск анализа.'
    if (s.phase === 'loading') return 'Загрузка…'
    if (s.phase === 'ready') {
        if (key !== 'satellite') return 'Готово'
        const selected = selectedSatellite.value
        if (!selected) return 'Получен несогласованный ответ'
        if (selected.status === 'READY') return selected.layers ? 'Наблюдение готово' : 'Изображения недоступны'
        if (selected.reason === 'DATE_NOT_SELECTED') return 'Дата не выбрана'
        return satelliteReasonLabel(selected.reason)
    }
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
const unlocatedStops = computed(() => Math.max(0, (stopSummary.value?.source_without_coordinates ?? 0) - (stopSummary.value?.excluded_outside_scope ?? 0)))
const unlocatedWord = computed(() => { const plural = new Intl.PluralRules('ru').select(unlocatedStops.value); return plural === 'one' ? 'запись' : plural === 'few' ? 'записи' : 'записей' })
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
const satelliteData = computed<SatelliteData | null>(() => satellite.value?.status === 'READY' ? satellite.value.data : null)
const satelliteInfo = computed<SatelliteData | null>(() => satelliteData.value ?? props.satelliteCatalog)
const selectedSatellite = computed<SatelliteSelected | null>(() => satelliteData.value?.selected ?? null)
const satelliteDates = computed<SatelliteReleaseRef[]>(() => satelliteInfo.value?.available_dates ?? [])
const selectedWarningList = computed(() => satelliteWarnings(selectedSatellite.value))
const selectedCoverage = computed(() => selectedSatellite.value?.coverage ?? null)
const selectedCoverageReasons = computed(() => coverageReasons(selectedCoverage.value))
const selectedDateKnown = computed(() => !props.date || satelliteDates.value.some(value => value.date === props.date))
const satelliteImageUnavailable = computed(() => selectedSatellite.value?.status === 'READY' && !selectedSatellite.value.layers)
const air = computed(() => props.blocks.air.response?.blocks.air)
const cardNames = { poi: 'Объекты рядом', satellite: 'Спутник', air: 'Воздух' }
const cardIcons = { poi: Layers, satellite: Satellite, air: Wind }
const categoryIcons = { grocery: ShoppingBasket, pharmacy: Pill, official_stop: BusFront, park: Trees }
const actionNames = { poi: 'объекты', satellite: 'спутник', air: 'воздух' }
function partial(key: AnalysisBlockKey): boolean {
    if (key === 'satellite') {
        if (props.blocks.satellite.phase !== 'ready') return false
        if (satelliteImageUnavailable.value) return true
        return selectedSatellite.value?.status === 'READY' && !!selectedCoverage.value && selectedCoverage.value.usable_fraction < 1
    }
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
    if (key === 'satellite' && satelliteData.value) {
        const selected = satelliteData.value.selected
        if (selected.reason === 'DATE_NOT_SELECTED') {
            const catalog = satelliteCatalogLabel(satelliteData.value)
            return satelliteDates.value.length
                ? `${catalog}. Выберите дату во вкладке «Спутник» — каталог ещё не является наблюдением.`
                : 'В каталоге нет пригодных дат для этого круга.'
        }
        if (selected.reason === 'DATE_NOT_IN_CATALOG') return `${formatObservationDate(selected.date)} отсутствует в каталоге для этого круга.`
        if (selected.status === 'READY') {
            const head = formatObservationDate(selected.date)
            if (!selected.layers) return `${head}. Изображения недоступны, аналитика по кругу сохранена.`
            if (selectedCoverage.value) return `${head}. Пригодно для NDVI: ${formatCircleFraction(selectedCoverage.value.usable_fraction)} круга.`
            return head
        }
        return `${formatObservationDate(selected.date)}: ${satelliteReasonLabel(selected.reason)}.`
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
        <div class="pa-sat-mode" role="group" aria-label="Вид спутниковых данных">
            <button class="pa-sat-mode__button" :class="{ 'is-active': satelliteMode === 'snapshot' }" type="button"
                :aria-pressed="satelliteMode === 'snapshot'" @click="emit('satellite-mode', 'snapshot')">Снимок</button>
            <button class="pa-sat-mode__button" :class="{ 'is-active': satelliteMode === 'ndvi' }" type="button"
                :aria-pressed="satelliteMode === 'ndvi'" @click="emit('satellite-mode', 'ndvi')">NDVI</button>
        </div>
        <label class="pa-field"><span>Дата снимка</span>
            <select class="pa-select" aria-label="Дата снимка" :value="date" :disabled="!canLoad" @change="emit('date', ($event.target as HTMLSelectElement).value)">
                <option value="">Без даты — только каталог</option>
                <option v-for="available in satelliteDates" :key="available.date" :value="available.date">{{ formatObservationDate(available.date) }}{{ available.warnings.length ? ' · ограничение' : '' }}</option>
                <option v-if="date && !selectedDateKnown" :value="date">{{ formatObservationDate(date) }} · нет в каталоге</option>
            </select>
        </label>
        <div v-if="blocks.satellite.phase === 'error' || blocks.satellite.phase === 'unavailable'" class="pa-alert pa-alert--error" role="status">
            <TriangleAlert :size="16" aria-hidden="true" />
            <div><strong>{{ blocks.satellite.phase === 'unavailable' ? 'Спутниковый источник недоступен' : 'Не удалось загрузить спутниковые данные' }}</strong>
                <p>{{ blocks.satellite.phase === 'unavailable' ? 'Данные этой даты недоступны по предметной причине. Другие блоки анализа не затронуты.' : 'Повторите загрузку спутникового блока; объекты и воздух остаются доступны.' }}</p></div>
        </div>
        <button v-if="blocks.satellite.phase === 'error' || blocks.satellite.phase === 'unavailable'" class="pa-outline" type="button" @click="emit('load', 'satellite')">Повторить загрузку спутника</button>
        <p v-if="satelliteInfo && !satelliteDates.length" class="pa-note">В каталоге нет пригодных для этого круга дат.</p>
        <template v-if="satelliteData">
            <template v-for="warning in selectedWarningList" :key="warning.code + warning.message">
                <div class="pa-alert pa-alert--warning" role="status">
                    <TriangleAlert :size="16" aria-hidden="true" />
                    <div><strong>Ограничение выбранной даты</strong><p>{{ warning.message }}</p></div>
                </div>
            </template>
            <p v-if="satelliteData.selected.reason === 'DATE_NOT_SELECTED'" class="pa-note pa-note--strong">
                Дата не выбрана. Каталог показывает только подготовленные даты и не является наблюдением.
            </p>
            <p v-else-if="satelliteData.selected.reason === 'DATE_NOT_IN_CATALOG'" class="pa-note pa-note--strong">
                Даты {{ formatObservationDate(satelliteData.selected.date) }} нет в каталоге для этого круга. Выберите другую дату.
            </p>
            <template v-else-if="satelliteData.selected.status === 'READY'">
                <div class="pa-sat-coverage" data-satellite-coverage>
                    <div class="pa-sat-coverage__head">
                        <span class="pa-sat-coverage__glyph"><Satellite :size="18" aria-hidden="true" /></span>
                        <div>
                            <strong>{{ formatCircleFraction(selectedCoverage?.usable_fraction ?? 0) }} круга</strong>
                            <p>пригодно для NDVI</p>
                        </div>
                    </div>
                    <p v-if="(selectedCoverage?.usable_fraction ?? 1) < 1" class="pa-sat-coverage__note">Остальные пиксели круга неизвестны или исключены маской. Это не низкий NDVI.</p>
                    <p class="pa-sat-coverage__scope" data-satellite-scope>Слой показан на всей подготовленной территории. Показатели рассчитаны для выбранного круга.</p>
                </div>
                <p class="pa-note">NDVI безразмерен и не равен доле растительности. Неизвестные пиксели прозрачны; при сильном увеличении изображение становится крупнее, но новые детали не появляются.</p>
                <div v-if="satelliteImageUnavailable" class="pa-alert pa-alert--warning" role="status">
                    <TriangleAlert :size="16" aria-hidden="true" />
                    <div><strong>Изображения недоступны</strong><p>Аналитика по кругу сохранена; растровые слои этой даты не подготовлены или доставка недоступна.</p></div>
                </div>
                <button v-if="satelliteImageUnavailable" class="pa-outline" type="button" @click="emit('load', 'satellite')">Повторить загрузку изображений</button>
                <dl class="pa-sat-meta">
                    <div><dt>Дата съёмки</dt><dd>{{ formatObservationDate(satelliteData.selected.date) }}</dd></div>
                    <div><dt>Источник</dt><dd>Copernicus Sentinel-2 L2A</dd></div>
                    <div><dt>Средний NDVI пригодных пикселей</dt><dd>{{ formatMeanNdvi(satelliteData.selected.mean_ndvi) }} <small>не процент растительности</small></dd></div>
                    <div v-for="scene in satelliteData.selected.scenes ?? []" :key="scene.scene_id"><dt>{{ scene.tile }}</dt><dd>{{ scene.scene_id }}<small>{{ formatObtainedAt(scene.acquired_at_catalog) }} · {{ scene.platform }}</small></dd></div>
                    <div><dt>Версии</dt><dd>{{ satelliteData.method_version }} · {{ satelliteData.mask_version }} · {{ satelliteData.legend_version }}</dd></div>
                </dl>
                <details v-if="selectedCoverage" class="pa-sat-details">
                    <summary>Покрытие круга и причины исключений</summary>
                    <p>Пикселей круга: {{ selectedCoverage.circle_pixels }}; подготовлено: {{ selectedCoverage.prepared_pixels }}; пригодно: {{ selectedCoverage.usable_pixels }}.</p>
                    <ul v-if="selectedCoverageReasons.length" class="pa-sat-reasons">
                        <li v-for="reason in selectedCoverageReasons" :key="reason.key">{{ reason.label }}: {{ reason.count }}</li>
                    </ul>
                    <p v-else>Все подготовленные пиксели круга пригодны.</p>
                    <p>Неизвестные и исключённые пиксели не считаются низким NDVI.</p>
                </details>
                <details v-if="(satelliteData.selected.limitations ?? []).length" class="pa-sat-details">
                    <summary>Ограничения набора</summary>
                    <ul><li v-for="line in satelliteData.selected.limitations" :key="line">{{ line }}</li></ul>
                </details>
            </template>
            <template v-else>
                <p class="pa-note pa-note--strong">Для выбранной даты нет пригодных данных: {{ satelliteReasonLabel(satelliteData.selected.reason) }}.</p>
                <details v-if="selectedCoverage" class="pa-sat-details">
                    <summary>Покрытие круга и причины исключений</summary>
                    <p>Пикселей круга: {{ selectedCoverage.circle_pixels }}; подготовлено: {{ selectedCoverage.prepared_pixels }}; пригодно: {{ selectedCoverage.usable_pixels }}.</p>
                    <ul v-if="selectedCoverageReasons.length" class="pa-sat-reasons">
                        <li v-for="reason in selectedCoverageReasons" :key="reason.key">{{ reason.label }}: {{ reason.count }}</li>
                    </ul>
                    <p>Изображение отсутствует, потому что нет пригодных пикселей NDVI. Ноль NDVI не подставляется.</p>
                </details>
            </template>
        </template>
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
            <p v-if="categoryKey === 'official_stop' && unlocatedStops" class="pa-note pa-stop-unlocated">В исходном наборе {{ unlocatedStops }} {{ unlocatedWord }} без координат. Неизвестно, относятся ли они к этой окрестности</p>
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
    <template v-if="tab === 'air' && air?.status === 'READY'">
        <ul class="pa-stations"><li v-for="station in air.data.stations" :key="station.id">
            <button class="pa-station" type="button" @click="emit('station', station.id)">{{ station.name }} · {{ station.distance_m }} м · {{ station.group }}</button>
            <button class="pa-outline" type="button" :disabled="!selectedIds.includes(station.id) && selectedIds.length >= 20" @click="toggleStation(station.id)">{{ selectedIds.includes(station.id) ? 'Убрать станцию из выбора' : 'Включить станцию в выбор' }}</button>
        </li></ul>
        <p v-if="air.data.missing_selected_ids.length" class="pa-note">В справочнике не найдены: {{ air.data.missing_selected_ids.join(', ') }}</p>
    </template>
</template>
