<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import OverviewTopics from '@/components/OverviewTopics.vue'
import { useOverviewTopics } from '@/composables/useOverviewTopics'
import ProfileMetric from '@/components/ProfileMetric.vue'
import { formatMetric, formatDate } from '@/utils/metricDisplay'
import { environmentGroups, environmentTitles, isBeyondRadius, profileSources, sourceName, freshnessNames, methodNames, availabilityNames } from '@/utils/profilePresentation'
import { groupStopsByName } from '@/utils/stopGroups'
import type { AddressProfile, EnvironmentKind } from '@/types/profile'
import type { MapLayerKey } from '@/types/mapLayers'
import { mappedNearestId } from '@/utils/mapAnalysis'
const props = withDefaults(defineProps<{ profile: AddressProfile; selectedStopId: number | null; selectedObject?: { layer: MapLayerKey; id: string } | null; view?: 'overview' | 'data' }>(), { view: 'overview' })
defineEmits<{ retry: []; selectStop: [id: number]; focusLayer: [key: MapLayerKey, id?: string] }>()
const root = ref<HTMLElement | null>(null)
watch(() => [props.selectedStopId, props.selectedObject] as const, async () => {
    await nextTick()
    for (const selected of root.value?.querySelectorAll<HTMLElement>('[aria-pressed="true"]') ?? [])
        for (let parent = selected.parentElement; parent && parent !== root.value; parent = parent.parentElement)
            if (parent instanceof HTMLDetailsElement) parent.open = true
})
const { includes, configured } = useOverviewTopics()
const transport = computed(() => props.profile.blocks.transport.data)
const stopGroups = computed(() => groupStopsByName(transport.value?.stops_in_radius.filter(stop => stop.id !== transport.value?.nearest_stop?.id) ?? []))
const selectedMapItem = computed(() => {
    const selection = props.selectedObject
    if (!selection || selection.layer === 'stops') return null
    const data = selection.layer === 'roads' || selection.layer === 'railways' ? props.profile.map.linear_layers?.[selection.layer]?.data : props.profile.map.area_layers?.[selection.layer]?.data
    return data?.features.find(feature => feature.properties.id === selection.id)
})
const sources = computed(() => profileSources(props.profile))
const farStop = computed(() => isBeyondRadius(transport.value?.metrics.nearest_stop_distance, transport.value?.coverage, props.profile.radius_m))
function far(kind: EnvironmentKind) {
    const data = props.profile.blocks[kind].data
    return isBeyondRadius(data?.metrics.nearest_distance, data?.coverage, props.profile.radius_m)
}
function metricProps(kind: EnvironmentKind) {
    const block = props.profile.blocks[kind], data = block.data
    return { title: environmentTitles[kind], metric: data?.metrics.nearest_distance, name: data?.nearest?.name,
        access: data?.nearest?.access, coverage: data?.coverage, error: block.message,
        distanceTo: ['roads', 'railways'].includes(kind) ? 'До линии по прямой' : 'До контура по прямой',
        mapNote: !mappedNearestId(props.profile, kind) && data?.nearest ? 'Геометрии именно этого объекта в ответе нет. Можно показать только слой категории.' : undefined,
        selected: !!props.selectedObject && props.selectedObject.layer === kind && props.selectedObject.id === mappedNearestId(props.profile, kind),
        mapLabel: mappedNearestId(props.profile, kind) ? 'Показать объект на карте' : 'Показать слой на карте' }
}
</script>

<template>
    <div ref="root" class="address-summary">
        <div id="profile-overview" role="tabpanel" aria-labelledby="profile-tab-overview" tabindex="0" :hidden="view !== 'overview'">
            <p class="address-note">Расстояния по прямой — не пеший путь и не время в дороге.</p>

            <OverviewTopics />
            <component :is="all ? 'details' : 'div'" v-for="all in [false, true]" :key="String(all)" :class="{ 'profile-disclosure': all }">
                <summary v-if="all">Все показатели</summary>
                <p v-if="all" class="address-note">Здесь доступны скрытые темы и дополнительные сведения. Выбор тем не меняет расчёты.</p>
                <section v-if="all ? !includes('transport') : includes('transport')" class="profile-group" aria-label="Транспорт">
                    <h2>Транспорт</h2>
                    <div v-if="profile.blocks.transport.status === 'ERROR'" role="alert" class="address-warning">{{ profile.blocks.transport.message }} <button type="button" class="profile-action" @click="$emit('retry')">Повторить расчёт</button></div>
                    <template v-else-if="transport">
                        <template v-if="!farStop">
                            <ProfileMetric title="Ближайшая остановка" :metric="transport.metrics.nearest_stop_distance" :name="transport.nearest_stop?.name" :coverage="transport.coverage" @retry="$emit('retry')" />
                            <button v-if="transport.nearest_stop && transport.stops_in_radius.some(stop => stop.id === transport!.nearest_stop!.id)" type="button" class="profile-action" :aria-pressed="selectedStopId === transport.nearest_stop.id" @click="$emit('selectStop', transport.nearest_stop.id)">Показать остановку на карте</button>
                            <p v-if="transport.nearest_stop && !transport.stops_in_radius.some(stop => stop.id === transport!.nearest_stop!.id)" class="address-note">Геометрии именно этой остановки в слое нет; показать её на карте нельзя.</p>
                        </template>
                        <details v-else class="profile-disclosure">
                            <summary>Ближайшая остановка — за кругом {{ profile.radius_m }} м</summary>
                            <ProfileMetric title="Ближайшая остановка" :metric="transport.metrics.nearest_stop_distance" :name="transport.nearest_stop?.name" :coverage="transport.coverage" />
                            <p class="address-note">За пределами слоя карты; точку на карте не показываем.</p>
                        </details>
                        <details class="profile-disclosure">
                            <summary>Другие остановки и число в круге</summary>
                            <p class="address-note">В круге {{ profile.radius_m }} м: <strong>{{ formatMetric(transport.metrics.stops_count) }}</strong> точек остановок.</p>
                            <p v-if="transport.metrics.stops_count.value === null" class="address-warning">{{ transport.metrics.stops_count.quality.reason }}</p>
                            <p v-if="transport.metrics.stops_count.quality.freshness === 'STALE'" class="address-warning">Данные о числе остановок устарели.</p>
                            <p v-if="!stopGroups.length && transport.metrics.stops_count.value !== null" class="address-note">Других остановок в загруженном списке нет.</p>
                            <ul v-else class="profile-stops" aria-label="Остальные остановки профиля">
                                <li v-for="group in stopGroups" :key="group.key">
                                    <p v-if="group.stops.length > 1" class="profile-stop-name">{{ group.name }} · объектов: {{ group.stops.length }}</p>
                                    <button v-for="(stop, index) in group.stops" :key="stop.id" type="button" class="profile-stop-button" :aria-pressed="selectedStopId === stop.id" @click="$emit('selectStop', stop.id)">
                                        <span>{{ group.stops.length > 1 ? `Объект ${index + 1} · ${group.name}` : group.name }}</span><strong>{{ Math.round(stop.distance_m) }} м</strong><small>По прямой · на карте</small>
                                    </button>
                                </li>
                            </ul>
                            <p v-if="stopGroups.some(group => group.stops.length > 1)" class="address-note">Одинаковое название не определяет направление движения. Каждая кнопка выбирает отдельный объект.</p>
                            <button type="button" class="profile-action" @click="$emit('focusLayer', 'stops')">Показать слой остановок</button>
                        </details>
                        <p class="address-note profile-caveat">Подход к остановке и нужные направления не проверены.</p>
                    </template>
                </section>
                <section v-for="group in environmentGroups.filter(group => group.kinds.some(kind => all ? !includes(kind) : includes(kind)))" :key="group.title" class="profile-group" :aria-label="group.title">
                    <h2>{{ group.title }}</h2>
                    <template v-for="kind in group.kinds.filter(kind => all ? !includes(kind) : includes(kind))" :key="kind">
                        <ProfileMetric v-if="!far(kind)" v-bind="metricProps(kind)" @retry="$emit('retry')" @show-map="$emit('focusLayer', kind, mappedNearestId(profile, kind))" />
                        <details v-else class="profile-disclosure profile-far">
                            <summary>{{ environmentTitles[kind] }} — за кругом {{ profile.radius_m }} м</summary>
                            <ProfileMetric v-bind="metricProps(kind)" @retry="$emit('retry')" @show-map="$emit('focusLayer', kind, mappedNearestId(profile, kind))" />
                            <p class="address-note">Ближайший объект за кругом анализа может отсутствовать в слое карты.</p>
                        </details>
                    </template>
                    <p class="address-note profile-caveat">{{ group.title === 'Парки и вода' ? 'Вход в парк и доступ к берегу не подтверждены.' : 'Близость дорог и путей не определяет шум или загрязнение. Движение поездов не подтверждено.' }}</p>
                </section>
                <details v-if="all" class="profile-disclosure profile-extra">
                    <summary>Растительные территории и доли круга</summary>
                    <ProfileMetric v-bind="metricProps('vegetation')" @retry="$emit('retry')" @show-map="$emit('focusLayer', 'vegetation', mappedNearestId(profile, 'vegetation'))" />
                    <p class="address-note">Контуры OpenStreetMap внутри {{ profile.radius_m }} м. Это не оценка места и не измерение растительности. Категории могут пересекаться; доли не складываются.</p>
                    <dl class="profile-shares">
                        <div v-for="kind in (['parks', 'vegetation', 'water'] as const)" :key="kind"><dt>{{ environmentTitles[kind] }}</dt><dd>{{ profile.blocks[kind].data?.metrics.share ? formatMetric(profile.blocks[kind].data!.metrics.share!) : 'Расчёт недоступен' }}</dd></div>
                    </dl>
                </details>
                <p v-if="all === configured && (profile.blocks.vegetation.status === 'ERROR' || profile.blocks.vegetation.data?.coverage.status !== 'COVERED' || profile.blocks.vegetation.data?.metrics.nearest_distance?.value === null)" class="address-warning">Растительные территории: {{ profile.blocks.vegetation.message ?? (profile.blocks.vegetation.data?.coverage.status !== 'COVERED' ? profile.blocks.vegetation.data?.coverage.reason : profile.blocks.vegetation.data?.metrics.nearest_distance?.quality.reason) }} Подробности в раскрытии выше.</p>
            </component>
            <div v-if="selectedMapItem && selectedObject" class="result-notice" role="status">
                <p>Выбрано на карте: <strong>{{ selectedMapItem.properties.name || 'Объект без названия' }}</strong></p>
                <button type="button" class="profile-action" aria-pressed="true" @click="$emit('focusLayer', selectedObject.layer, selectedObject.id)">Показать выбранный объект ещё раз</button>
            </div>
        </div>
        <div id="profile-sources" role="tabpanel" aria-labelledby="profile-tab-data" tabindex="0" :hidden="view !== 'data'">
            <p class="address-note">Локальные данные: официальный набор остановок и OpenStreetMap. Полнота объектов, входы и доступ на местности не проверены. Подложка карты — отдельный источник и может требовать интернет.</p>
            <section class="address-source">
                <h2>Адрес и точка</h2>
                <p>{{ profile.address.source }} · дата наблюдения: {{ formatDate(profile.address.observed_at) }}.</p>
                <p>Версия / публикация: {{ formatDate(profile.address.source_updated_at) }}.</p>
                <details class="profile-disclosure"><summary>Как выбрана точка</summary><p>{{ profile.address.reason }}</p><p>Координаты: {{ profile.point.lat.toFixed(6) }}, {{ profile.point.lon.toFixed(6) }}. Точка внутри контура не обозначает вход.</p><p>ID снимка адресов: {{ profile.address.dataset_import_id }}.</p></details>
            </section>
            <section v-for="(section, index) in sources.sections" :key="index" class="address-source">
                <h2>{{ sourceName(section.metric.source) }}</h2>
                <p class="profile-source-labels">{{ section.rows.flatMap(row => row.labels).join(' · ') }}</p>
                <p>Дата наблюдения: {{ formatDate(section.metric.observed_at) }} · актуальность: {{ freshnessNames[section.metric.quality.freshness] }}.</p>
                <p>Версия / публикация: {{ formatDate(section.metric.source_updated_at) }}.</p>
                <p>{{ availabilityNames[section.metric.quality.availability] }}. {{ section.coverage.status === 'COVERED' ? 'Круг входит в область загруженных данных; полнота объектов не гарантируется.' : section.coverage.reason }}</p>
                <details class="profile-disclosure">
                    <summary>Метод и технические сведения</summary>
                    <div v-for="row in section.rows" :key="row.labels.join()" class="profile-source-method">
                        <h3>{{ row.labels.join(' · ') }}</h3>
                        <p>{{ row.metric.quality.method ? methodNames[row.metric.quality.method] ?? row.metric.quality.method : 'Результата нет' }}. {{ row.metric.quality.reason }}</p>
                    </div>
                    <p>Покрытие: {{ section.coverage.status }}. {{ section.coverage.reason }}</p>
                    <p>ID снимка: {{ section.metric.dataset_import_id ?? 'неизвестен' }}. Метод: {{ section.metric.method_version ?? section.metric.quality.method ?? 'нет результата' }}.</p>
                    <p>Расчёт показателя: {{ section.metric.calculated_at }} (UTC).</p>
                    <p>Подтверждённый радиус: {{ section.coverage.available_radius_m === null ? 'неизвестен' : `${section.coverage.available_radius_m} м` }}. Буфер данных: {{ section.coverage.buffer_m === null ? 'неизвестен' : `${section.coverage.buffer_m} м` }}.</p>
                </details>
            </section>
            <section v-for="error in sources.errors" :key="error.title" class="address-source" role="alert"><h2>{{ error.title }}</h2><p>{{ error.message }}</p><button type="button" class="profile-action" @click="$emit('retry')">Повторить расчёт</button></section>
            <details class="profile-disclosure">
                <summary>Как читать расстояния и карту</summary>
                <p class="address-note">До остановок — по прямой до точки, до парков и воды — до контура (внутри него — 0 м), до дорог и путей — до линии. Радиус {{ profile.radius_m }} м задаёт круг подсчёта и начальную видимость результатов, а не предел поиска ближайшего объекта. Слои ограничены кругом: дальний объект может в них не попасть. Крупные дороги: motorway, trunk, primary, secondary. Растительные контуры не подтверждают место для прогулки.</p>
            </details>
            <p class="address-note profile-caveat">Даты указаны в UTC. Дата версии / публикации не заменяет дату наблюдения или проверки объекта. Расчёт профиля: {{ formatDate(profile.calculated_at) }}. Ссылка открывает текущие локальные данные.</p>
        </div>
    </div>
</template>
