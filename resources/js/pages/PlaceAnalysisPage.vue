<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import PlaceAnalysisMap from '@/components/place-analysis/PlaceAnalysisMap.vue'
import {
    categoryMeta,
    categoryOrder,
    demoAddresses,
    demoDates,
    demoHistory,
    demoPois,
    demoStations,
    initialPlace,
    staleLayerNotice,
    type AnalysisTab,
    type DemoPlace,
    type DemoPoint,
    type PoiCategory,
    type SatelliteMode,
} from '@/place-analysis-demo'
import '../../css/place-analysis.css'

const tabOrder: AnalysisTab[] = ['overview', 'objects', 'satellite', 'air']
const activeTab = ref<AnalysisTab>('overview')
const place = ref<DemoPlace>({ ...initialPlace })
const addressQuery = ref(initialPlace.label)
const suggestionsOpen = ref(false)
const searchHint = ref('')
const radius = ref(500)
const pendingPoint = ref<DemoPoint | null>(null)
const pickMode = ref(false)
const activeCategory = ref<PoiCategory>('pharmacy')
const selectedPoiId = ref<string | null>(null)
const selectedStationId = ref<string | null>(demoStations[0]!.id)
const satelliteMode = ref<SatelliteMode>('ndvi')
const satelliteDate = ref(demoDates[0]!)
const satelliteOpacity = ref(0.35)
const showObjects = ref(true)
const showSatellite = ref(true)
const showStations = ref(false)
const showRadius = ref(true)
const airFailed = ref(true)
const airPending = ref(false)
let retryTimer: ReturnType<typeof setTimeout> | null = null

const counts = computed(() => {
    const value: Record<PoiCategory, number> = { grocery: 0, pharmacy: 0, official_stop: 0, park: 0 }
    for (const poi of demoPois) value[poi.category] += 1
    return value
})
const poisForCategory = computed(() => demoPois.filter(poi => poi.category === activeCategory.value))
const selectedPoi = computed(() => demoPois.find(poi => poi.id === selectedPoiId.value) ?? null)
const selectedStation = computed(() => demoStations.find(station => station.id === selectedStationId.value) ?? demoStations[0]!)
const nearestStation = demoStations[0]!
const poiCount = demoPois.length
const validPercent = 72
const unknownPercent = 28
const historyLabels = ['09.08', '10.08', '11.08', '12.08', '13.08', '14.08', '15.08']
const historyBars = demoHistory.map((value, index) => ({
    value,
    label: index % 2 === 0 ? historyLabels[index / 2] ?? '' : '',
    height: value === null ? 12 : Math.max(8, Math.round(value / 40 * 88)),
}))
const tabLabels: Record<AnalysisTab, string> = {
    overview: 'Обзор', objects: 'Объекты', satellite: 'Спутник', air: 'Воздух',
}
const filteredAddresses = computed(() => {
    const query = addressQuery.value.trim().toLowerCase()
    if (!query) return demoAddresses
    return demoAddresses.filter(address => address.label.toLowerCase().includes(query))
})
const mapSatelliteMode = computed<SatelliteMode>(() => activeTab.value === 'overview' ? 'snapshot' : satelliteMode.value)
const mapShowObjects = computed(() => showObjects.value)
const mapShowStations = computed(() => showStations.value && activeTab.value === 'air' && !airFailed.value)
const mapCategoryFilter = computed<PoiCategory | null>(() => activeTab.value === 'objects' ? activeCategory.value : null)
const panelTitle = computed(() => {
    if (activeTab.value === 'overview') return 'Обзор'
    if (activeTab.value === 'objects') return `Объекты в радиусе ${radius.value} м`
    if (activeTab.value === 'satellite') return 'Спутниковый анализ (NDVI)'
    return 'Станции мониторинга воздуха'
})

function selectTab(tab: AnalysisTab) {
    activeTab.value = tab
    if (tab === 'overview') {
        showObjects.value = true
        showSatellite.value = true
        showStations.value = false
        satelliteOpacity.value = 0.35
    } else if (tab === 'objects') {
        showObjects.value = true
        showSatellite.value = false
        showStations.value = false
    } else if (tab === 'satellite') {
        showObjects.value = false
        showSatellite.value = true
        showStations.value = false
        satelliteOpacity.value = 0.75
    } else {
        showObjects.value = false
        showSatellite.value = false
        showStations.value = true
    }
}

function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = tabOrder.indexOf(activeTab.value)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabOrder.length - 1
        : event.key === 'ArrowLeft' ? (index - 1 + tabOrder.length) % tabOrder.length
            : (index + 1) % tabOrder.length
    const tab = tabOrder[next]!
    selectTab(tab)
    void nextTick(() => document.getElementById(`pa-tab-${tab}`)?.focus())
}

function normalizeRadius() {
    const value = Number(radius.value)
    radius.value = Number.isFinite(value) ? Math.min(1000, Math.max(200, Math.round(value))) : 500
}

function selectAddress(address: DemoPlace) {
    place.value = { ...address }
    addressQuery.value = address.label
    suggestionsOpen.value = false
    searchHint.value = ''
    pendingPoint.value = null
    pickMode.value = false
}

function submitSearch() {
    const address = filteredAddresses.value[0]
    if (address) selectAddress(address)
    else searchHint.value = 'Адрес не найден в демонстрационном списке.'
}

function clearSearch() {
    addressQuery.value = ''
    searchHint.value = ''
    suggestionsOpen.value = true
}

function selectCategory(category: PoiCategory) {
    activeCategory.value = category
    selectedPoiId.value = null
}

function togglePoi(id: string) {
    selectedPoiId.value = selectedPoiId.value === id ? null : id
}

function onMapPoint(point: DemoPoint) {
    pendingPoint.value = point
    pickMode.value = false
}

function analyzePoint() {
    if (!pendingPoint.value) return
    place.value = { id: null, label: 'Точка на карте', ...pendingPoint.value }
    addressQuery.value = 'Точка на карте'
    suggestionsOpen.value = false
    pendingPoint.value = null
    pickMode.value = false
}

function cancelPoint() {
    pendingPoint.value = null
    pickMode.value = false
}

function retryAir() {
    if (airPending.value || !airFailed.value) return
    airPending.value = true
    retryTimer = setTimeout(() => {
        airFailed.value = false
        airPending.value = false
        retryTimer = null
    }, 700)
}

function formatCoord(value: number) {
    return value.toFixed(4)
}

function selectStation(id: string) {
    selectedStationId.value = id
}

onMounted(() => {
    document.title = 'Анализ места — PlaceLens (макет)'
})
onBeforeUnmount(() => {
    if (retryTimer) clearTimeout(retryTimer)
})
</script>

<template>
    <div class="pa-page">
        <a class="pa-skip" href="#pa-panel">К содержанию анализа</a>
        <header class="pa-header">
            <a class="pa-brand" href="/" aria-label="PlaceLens — главная">
                <svg class="pa-brand__mark" viewBox="0 0 32 32" aria-hidden="true">
                    <rect width="32" height="32" rx="9" fill="#245b45" />
                    <path d="M9 10h7a5.5 5.5 0 0 1 0 11h-2.5v4H9V10Z" fill="#eaf2df" />
                    <circle cx="20" cy="14" r="4.5" stroke="#eaf2df" stroke-width="1.8" fill="none" />
                    <path d="m23.5 17.5 3 3" stroke="#eaf2df" stroke-width="1.8" stroke-linecap="round" />
                </svg>
                <span>Place<span>Lens</span></span>
            </a>
            <form class="pa-search" role="search" @submit.prevent="submitSearch">
                <svg class="pa-search__icon" viewBox="0 0 20 20" aria-hidden="true">
                    <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7" />
                    <path d="m12.5 12.5 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
                </svg>
                <input
                    v-model="addressQuery"
                    class="pa-search__input"
                    type="search"
                    placeholder="Поиск адреса в Красноярске"
                    aria-label="Поиск адреса"
                    :aria-expanded="suggestionsOpen"
                    aria-controls="pa-address-suggestions"
                    @focus="suggestionsOpen = true"
                    @input="suggestionsOpen = true; searchHint = ''"
                    @blur="suggestionsOpen = false"
                    @keydown.escape="suggestionsOpen = false"
                >
                <button v-if="addressQuery" class="pa-search__clear" type="button" aria-label="Очистить поиск" @click="clearSearch">×</button>
                <div v-if="suggestionsOpen" id="pa-address-suggestions" class="pa-suggestions">
                    <p class="pa-suggestions__note">Адресный поиск · демонстрационный список</p>
                    <button
                        v-for="address in filteredAddresses"
                        :key="address.id ?? address.label"
                        class="pa-suggestion"
                        type="button"
                        @mousedown.prevent="selectAddress(address)"
                    >
                        <span class="pa-suggestion__pin" aria-hidden="true">⌖</span>
                        <span>{{ address.label }}</span>
                    </button>
                    <p v-if="!filteredAddresses.length" class="pa-suggestions__empty">Ничего не найдено в демонстрационном списке.</p>
                    <p v-if="searchHint" class="pa-suggestions__empty">{{ searchHint }}</p>
                </div>
            </form>
            <span class="pa-demo-badge">{{ staleLayerNotice }}</span>
        </header>

        <div class="pa-controls">
            <button class="pa-place-button" type="button" :class="{ 'is-picking': pickMode }" @click="pickMode = true">
                <span class="pa-pin-icon" aria-hidden="true">●</span>
                <span>Точка на карте</span>
                <span class="pa-place-button__chevron" aria-hidden="true">⌄</span>
            </button>
            <div class="pa-radius">
                <label for="pa-radius-number">Радиус анализа:</label>
                <input id="pa-radius-number" v-model.number="radius" class="pa-radius__number" type="number" min="200" max="1000" step="50" @change="normalizeRadius">
                <span class="pa-radius__unit">м</span>
                <span class="pa-radius__edge">200 м</span>
                <input v-model.number="radius" class="pa-radius__range" type="range" min="200" max="1000" step="50" aria-label="Радиус анализа" @change="normalizeRadius">
                <span class="pa-radius__edge">1 000 м</span>
            </div>
            <p v-if="pickMode" class="pa-pick-hint" role="status">Кликните по карте, чтобы выбрать точку.</p>
        </div>

        <div class="pa-body">
            <aside id="pa-panel" class="pa-panel" aria-label="Панель анализа места">
                <nav class="pa-tabs" role="tablist" aria-label="Разделы анализа">
                    <button
                        v-for="tab in tabOrder"
                        :id="`pa-tab-${tab}`"
                        :key="tab"
                        class="pa-tab"
                        :class="{ 'is-active': activeTab === tab }"
                        type="button"
                        role="tab"
                        :aria-selected="activeTab === tab"
                        :aria-controls="`pa-panel-${tab}`"
                        :tabindex="activeTab === tab ? 0 : -1"
                        @click="selectTab(tab)"
                        @keydown="tabKey"
                    >{{ tabLabels[tab] }}</button>
                </nav>

                <div :id="`pa-panel-${activeTab}`" class="pa-panel__scroll" role="tabpanel" :aria-labelledby="`pa-tab-${activeTab}`">
                    <template v-if="activeTab === 'overview'">
                        <h1 class="pa-title">Обзор</h1>
                        <p class="pa-lead">Один анализ выбранного места. Значения и объекты — условные, это демонстрационный макет.</p>

                        <article class="pa-card">
                            <div class="pa-card__head">
                                <span class="pa-card__glyph pa-card__glyph--poi" aria-hidden="true">⌖</span>
                                <div>
                                    <h2>Объекты (POI)</h2>
                                    <p class="pa-card__status">Готово · {{ poiCount }} объектов</p>
                                </div>
                            </div>
                            <p class="pa-muted">Магазины, аптеки, официальные остановки, парки и скверы в выбранном радиусе.</p>
                            <button class="pa-link" type="button" @click="selectTab('objects')">Открыть объекты <span aria-hidden="true">›</span></button>
                        </article>

                        <article class="pa-card">
                            <div class="pa-card__head">
                                <span class="pa-card__glyph pa-card__glyph--sat" aria-hidden="true">≋</span>
                                <div>
                                    <h2>Спутниковые снимки</h2>
                                    <p class="pa-card__status">Частичное покрытие · {{ validPercent }}%</p>
                                </div>
                            </div>
                            <p class="pa-card__meta">Дата снимка: {{ satelliteDate }} · для {{ unknownPercent }}% круга данных нет</p>
                            <button class="pa-outline" type="button" @click="selectTab('satellite')">Смотреть слой <span aria-hidden="true">↗</span></button>
                        </article>

                        <article class="pa-card">
                            <div class="pa-card__head">
                                <span class="pa-card__glyph pa-card__glyph--air" aria-hidden="true">☁</span>
                                <div>
                                    <h2>Качество воздуха</h2>
                                    <p class="pa-card__status" :class="{ 'is-error': airFailed }">
                                        {{ airFailed ? 'Не удалось загрузить наблюдения' : `Готово · ${demoStations.length} станции` }}
                                    </p>
                                </div>
                            </div>
                            <template v-if="airFailed">
                                <p class="pa-muted">Ошибка блока не скрывает остальные результаты.</p>
                                <button class="pa-outline" type="button" :disabled="airPending" @click="retryAir">
                                    {{ airPending ? 'Проверяем…' : 'Повторить' }} <span aria-hidden="true">↻</span>
                                </button>
                            </template>
                            <template v-else>
                                <p class="pa-card__meta">Ближайшая станция «{{ nearestStation.name }}» · {{ nearestStation.distance_km }} км</p>
                                <p class="pa-card__meta">PM2.5 {{ nearestStation.pm25 }} мкг/м³ · {{ nearestStation.observed_at }}</p>
                                <button class="pa-link" type="button" @click="selectTab('air')">Станции <span aria-hidden="true">›</span></button>
                            </template>
                        </article>

                        <p class="pa-note">Количество объектов — это записи источников, не оценка качества места. Наличие в круге не означает пеший доступ.</p>
                    </template>

                    <template v-else-if="activeTab === 'objects'">
                        <h1 class="pa-title">{{ panelTitle }}</h1>
                        <p class="pa-lead">Найдено {{ poiCount }} объектов. Показаны только четыре согласованные категории.</p>
                        <div class="pa-chips" role="group" aria-label="Категории объектов">
                            <button
                                v-for="category in categoryOrder"
                                :key="category"
                                class="pa-chip"
                                :class="{ 'is-active': activeCategory === category }"
                                type="button"
                                @click="selectCategory(category)"
                            >
                                {{ categoryMeta[category].label }} ({{ counts[category] }})
                            </button>
                        </div>
                        <h2 class="pa-subtitle">{{ categoryMeta[activeCategory].label }} — {{ counts[activeCategory] }} объекта</h2>
                        <ul class="pa-objects">
                            <li v-for="poi in poisForCategory" :key="poi.id">
                                <button class="pa-object" type="button" :aria-expanded="selectedPoiId === poi.id" @click="togglePoi(poi.id)">
                                    <span class="pa-object__glyph" :style="{ backgroundColor: categoryMeta[poi.category].color }">{{ categoryMeta[poi.category].glyph }}</span>
                                    <span class="pa-object__body">
                                        <strong>{{ poi.name }}</strong>
                                        <small>{{ poi.distance_m }} м по прямой</small>
                                    </span>
                                    <span class="pa-object__chevron" aria-hidden="true">{{ selectedPoiId === poi.id ? '⌃' : '›' }}</span>
                                </button>
                                <div v-if="selectedPoiId === poi.id" class="pa-object-details">
                                    <p>{{ poi.name }}</p>
                                    <p>{{ poi.distance_m }} м по прямой до отметки объекта</p>
                                    <p>Часы работы: {{ poi.hours ?? 'не указаны' }}</p>
                                    <p>Источник: {{ poi.source }} · снимок {{ poi.snapshot }}</p>
                                    <p v-if="poi.address">Адрес: {{ poi.address }}</p>
                                    <p class="pa-note">Расстояние до контура — не расстояние до входа.</p>
                                </div>
                            </li>
                        </ul>
                        <p class="pa-note">Наличие в круге не означает пеший доступ. Количество — записи источника, не рейтинг.</p>
                    </template>

                    <template v-else-if="activeTab === 'satellite'">
                        <h1 class="pa-title">{{ panelTitle }}</h1>
                        <div class="pa-mode" role="group" aria-label="Режим спутникового слоя">
                            <button class="pa-mode__button" :class="{ 'is-active': satelliteMode === 'snapshot' }" type="button" @click="satelliteMode = 'snapshot'">Снимок</button>
                            <button class="pa-mode__button" :class="{ 'is-active': satelliteMode === 'ndvi' }" type="button" @click="satelliteMode = 'ndvi'">NDVI</button>
                        </div>
                        <label class="pa-field">
                            <span>Дата снимка</span>
                            <select v-model="satelliteDate" class="pa-select">
                                <option v-for="date in demoDates" :key="date" :value="date">{{ date }}</option>
                            </select>
                        </label>
                        <div class="pa-coverage">
                            <span class="pa-coverage__icon" aria-hidden="true">◱</span>
                            <div>
                                <strong>Пригодные данные: {{ validPercent }}% круга</strong>
                                <p>Неизвестно: {{ unknownPercent }}%</p>
                            </div>
                        </div>
                        <p class="pa-note">Индекс NDVI не равен доле растительности. Штриховка показывает пропуски внутри анализируемого круга.</p>
                        <dl class="pa-meta">
                            <div><dt>Источник</dt><dd>Sentinel-2 (демо)</dd></div>
                            <div><dt>Пространственное разрешение</dt><dd>10 м</dd></div>
                            <div><dt>Дата съёмки</dt><dd>{{ satelliteDate }}</dd></div>
                        </dl>
                        <p class="pa-note">Снимок, маска и значения условны; слой не подтверждает реальное состояние растительности.</p>
                    </template>

                    <template v-else>
                        <h1 class="pa-title">{{ panelTitle }}</h1>
                        <template v-if="airFailed">
                            <div class="pa-error" role="status">
                                <span aria-hidden="true">!</span>
                                <div>
                                    <strong>{{ airPending ? 'Проверяем наблюдения…' : 'Не удалось загрузить наблюдения' }}</strong>
                                    <p>Другие результаты анализа сохранены. Это демонстрационное состояние повтора.</p>
                                </div>
                            </div>
                            <button class="pa-outline" type="button" :disabled="airPending" @click="retryAir">{{ airPending ? 'Проверяем…' : 'Повторить' }} <span aria-hidden="true">↻</span></button>
                        </template>
                        <template v-else>
                            <ul class="pa-stations">
                                <li v-for="station in demoStations" :key="station.id">
                                    <button class="pa-station" :class="{ 'is-selected': selectedStationId === station.id }" type="button" @click="selectStation(station.id)">
                                        <span class="pa-station__number">{{ station.number }}</span>
                                        <span class="pa-station__body"><strong>{{ station.name }}</strong><small>{{ station.distance_km }} км</small></span>
                                        <span class="pa-station__chevron" aria-hidden="true">›</span>
                                    </button>
                                </li>
                            </ul>
                            <section class="pa-station-detail" aria-label="Выбранная станция">
                                <h2>Станция «{{ selectedStation.name }}»</h2>
                                <p class="pa-muted">{{ selectedStation.address }}</p>
                                <div class="pa-pm">
                                    <div><span>PM2.5</span><strong>{{ selectedStation.pm25 }}</strong><small>мкг/м³</small></div>
                                    <p>Наблюдение: {{ selectedStation.observed_at }}</p>
                                    <p class="pa-note">Время источника; часовой пояс не подтверждён.</p>
                                </div>
                                <p class="pa-note">Измерение станции, не выбранной точки.</p>
                                <div class="pa-history">
                                    <div class="pa-history__head"><strong>История PM2.5</strong><span>7 суток</span></div>
                                    <div class="pa-chart">
                                        <div class="pa-chart__bars">
                                            <div v-for="(bar, index) in historyBars" :key="index" class="pa-bar" :class="{ 'is-empty': bar.value === null }" :style="{ height: `${bar.height}%` }" :title="bar.value === null ? 'Нет данных' : `${bar.value} мкг/м³`">
                                                <span v-if="bar.value === null" class="pa-bar__empty">Нет данных</span>
                                            </div>
                                        </div>
                                        <div class="pa-chart__labels">
                                            <span v-for="(label, index) in historyLabels" :key="label" :style="{ gridColumn: `${index * 2 + 1} / span 2` }">{{ label }}</span>
                                        </div>
                                    </div>
                                </div>
                                <p class="pa-note">Пропуски показаны отдельно; ряд условный и не подтверждает качество воздуха.</p>
                            </section>
                        </template>
                    </template>
                </div>
            </aside>

            <section class="pa-map-shell" aria-label="Карта анализа">
                <PlaceAnalysisMap
                    :center="place"
                    :radius="radius"
                    :tab="activeTab"
                    :show-objects="mapShowObjects"
                    :show-satellite="showSatellite"
                    :show-stations="mapShowStations"
                    :show-radius="showRadius"
                    :satellite-mode="mapSatelliteMode"
                    :satellite-opacity="satelliteOpacity"
                    :category-filter="mapCategoryFilter"
                    :selected-station="selectedStationId"
                    :pending-point="pendingPoint"
                    @select-point="onMapPoint"
                />

                <div v-if="pendingPoint" class="pa-point-card" role="dialog" aria-label="Выбранная точка">
                    <div class="pa-point-card__head">
                        <strong>Точка на карте</strong>
                        <button type="button" class="pa-icon-button" aria-label="Закрыть карточку точки" @click="cancelPoint">×</button>
                    </div>
                    <p>Координаты: {{ formatCoord(pendingPoint.lat) }}, {{ formatCoord(pendingPoint.lon) }}</p>
                    <p>Радиус: {{ radius }} м</p>
                    <div class="pa-point-card__actions">
                        <button class="pa-outline" type="button" @click="cancelPoint">Отмена</button>
                        <button class="pa-primary" type="button" @click="analyzePoint">Анализировать</button>
                    </div>
                </div>

                <div class="pa-map-caption" aria-hidden="true">{{ staleLayerNotice }}</div>

                <aside class="pa-layers" aria-label="Слои карты">
                    <h2 class="pa-layers__title"><span aria-hidden="true">≋</span> Слои карты</h2>
                    <label v-if="activeTab !== 'air'" class="pa-layer-row">
                        <input v-model="showObjects" type="checkbox">
                        <span>Объекты (POI)</span>
                        <span class="pa-layer-swatches" aria-hidden="true"><i class="pa-swatch pa-swatch--grocery">М</i><i class="pa-swatch pa-swatch--pharmacy">+</i><i class="pa-swatch pa-swatch--stop">О</i><i class="pa-swatch pa-swatch--park">П</i></span>
                    </label>
                    <label v-if="activeTab !== 'air'" class="pa-layer-row">
                        <input v-model="showSatellite" type="checkbox">
                        <span>{{ activeTab === 'satellite' ? 'NDVI (Sentinel-2, демо)' : 'Спутниковый снимок' }}</span>
                    </label>
                    <label v-if="activeTab === 'air'" class="pa-layer-row">
                        <input v-model="showStations" type="checkbox">
                        <span>Станции мониторинга</span>
                    </label>
                    <label class="pa-layer-row">
                        <input v-model="showRadius" type="checkbox">
                        <span>Радиус анализа ({{ radius }} м)</span>
                    </label>
                    <div class="pa-layer-row pa-layer-row--static">
                        <input type="checkbox" checked disabled>
                        <span>Базовая карта</span>
                    </div>
                    <label v-if="showSatellite && activeTab !== 'air'" class="pa-opacity">
                        <span>Прозрачность:</span>
                        <input v-model.number="satelliteOpacity" type="range" min="0" max="1" step="0.05" aria-label="Прозрачность спутникового слоя">
                        <output>{{ Math.round(satelliteOpacity * 100) }}%</output>
                    </label>

                    <div v-if="activeTab === 'satellite' || (activeTab === 'overview' && showSatellite)" class="pa-legend">
                        <strong class="pa-legend__title">{{ activeTab === 'satellite' && satelliteMode === 'ndvi' ? 'Легенда (NDVI)' : 'Спутниковые данные' }}</strong>
                        <template v-if="activeTab === 'satellite' && satelliteMode === 'ndvi'">
                            <div class="pa-gradient" aria-hidden="true"></div>
                            <div class="pa-legend__scale"><span>−1</span><span>0</span><span>1</span></div>
                        </template>
                        <div class="pa-legend__row"><i class="pa-hatch" aria-hidden="true"></i> Нет данных</div>
                    </div>
                    <div v-else-if="activeTab === 'air'" class="pa-legend">
                        <strong class="pa-legend__title">Условные обозначения</strong>
                        <div class="pa-legend__row"><i class="pa-dot pa-dot--station" aria-hidden="true"></i> Станция мониторинга</div>
                        <div class="pa-legend__row"><i class="pa-dash" aria-hidden="true"></i> Радиус анализа ({{ radius }} м)</div>
                    </div>
                    <div v-else class="pa-legend">
                        <strong class="pa-legend__title">Категории</strong>
                        <div v-for="category in categoryOrder" :key="category" class="pa-legend__row">
                            <i class="pa-dot" :style="{ backgroundColor: categoryMeta[category].color }" aria-hidden="true"></i>
                            {{ categoryMeta[category].label }}
                        </div>
                    </div>
                </aside>
            </section>
        </div>
    </div>
</template>
