<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import PointAddressLabel from '@/components/PointAddressLabel.vue'
import { groupStopsByName } from '@/utils/stopGroups'
import type { TransportAnalysis, Coordinates } from '@/types/transport'

const props = defineProps<{
    radius: number
    selectedStopId: number | null
    point: Coordinates
    analysis: TransportAnalysis | null
    status: 'idle' | 'loading' | 'ready' | 'error'
}>()
defineEmits<{ retry: []; reset: []; radius: [value: number]; selectStop: [id: number] }>()
const stopGroups = computed(() => groupStopsByName(props.analysis?.stops_in_radius ?? []))
const expandedGroupKey = ref<string | null>(null)
watch(() => props.analysis, () => { expandedGroupKey.value = null })
watch(() => props.selectedStopId, id => {
    expandedGroupKey.value = id === null ? null : stopGroups.value.find(group => group.stops.some(stop => stop.id === id))?.key ?? null
})
function toggleGroup(key: string, event: Event) {
    if ((event.target as HTMLDetailsElement).open) expandedGroupKey.value = key
    else if (expandedGroupKey.value === key) expandedGroupKey.value = null
}
function pointCount(count: number) {
    const word = { one: 'точка', few: 'точки', many: 'точек', other: 'точки', zero: 'точек', two: 'точки' }[new Intl.PluralRules('ru-RU').select(count)]
    return `${count} ${word}`
}
function date(value: string | null) {
    return value ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC' }).format(new Date(value)) : 'неизвестна'
}
function number(value: number) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)
}
function unavailable(availability: string) {
    return availability === 'UNAVAILABLE' ? 'Данные недоступны' : 'Недостаточно данных'
}
</script>

<template>
    <section class="transport-results" aria-labelledby="transport-title" aria-live="polite" :aria-busy="status === 'loading'">
        <div class="flex items-center justify-between gap-2">
            <h1 id="transport-title" class="text-base font-semibold">Остановки в радиусе {{ radius }} м от выбранной точки</h1>
            <button type="button" class="result-action" @click="$emit('reset')">Сбросить</button>
        </div>
        <p class="mt-2 text-xs leading-5 text-[#637769]">Выбранная точка: {{ point.lat.toFixed(6) }}, {{ point.lon.toFixed(6) }} (широта, долгота).</p>
        <PointAddressLabel :point="point" class="mt-3" />
        <fieldset class="mt-4">
            <legend class="text-xs text-[#637769]">Радиус по прямой</legend>
            <div class="mt-2 flex gap-2">
                <button v-for="value in [300, 500]" :key="value" type="button" class="rounded-md border px-3 py-2 text-sm" :class="radius === value ? 'bg-[#2d6450] text-white' : 'bg-white'" :aria-pressed="radius === value" @click="$emit('radius', value)">{{ value }} м</button>
            </div>
        </fieldset>
        <p class="mt-3 text-xs text-[#637769]">Расстояния по прямой. Переходы, препятствия и возможность прохода не учитываются.</p>
        <p v-if="status === 'loading'" class="mt-4 text-sm" role="status">Рассчитываем окружение…</p>
        <div v-else-if="status === 'error'" class="result-notice mt-4" role="alert">
            <p>Не удалось получить данные транспорта.</p>
            <button type="button" class="result-action mt-2" @click="$emit('retry')">Повторить запрос</button>
        </div>
        <template v-else-if="analysis">
            <div v-if="analysis.coverage.status !== 'COVERED'" class="result-notice mt-4" role="status">
                <p class="font-medium">{{ analysis.coverage.status === 'OUTSIDE_SERVICE_AREA' ? 'Вне покрытия' : analysis.coverage.status === 'PARTIAL' ? 'Неполное покрытие радиуса' : 'Покрытие не подтверждено' }}</p>
                <p class="mt-1 text-sm">{{ analysis.coverage.reason }}</p>
                <p v-if="analysis.coverage.status === 'PARTIAL' && stopGroups.length" class="mt-1 text-sm">Ниже показаны найденные точки; полный подсчёт недоступен.</p>
            </div>
            <template v-if="analysis.coverage.status !== 'OUTSIDE_SERVICE_AREA'">
            <dl class="mt-4 space-y-3">
                <div class="result-metric">
                    <dt class="text-xs text-[#637769]">Ближайшая остановка</dt>
                    <dd class="mt-2">
                        <p v-if="analysis.nearest_stop" class="text-sm font-medium">{{ analysis.nearest_stop.name || 'Без названия' }}</p>
                        <p v-if="analysis.metrics.nearest_stop_distance.value !== null" class="mt-2 text-3xl font-semibold">
                            {{ number(analysis.metrics.nearest_stop_distance.value) }} м
                        </p>
                        <p v-else class="mt-1 text-sm font-medium">{{ unavailable(analysis.metrics.nearest_stop_distance.quality.availability) }}</p>
                    </dd>
                    <p v-if="analysis.metrics.nearest_stop_distance.value !== null" class="mt-1 text-xs text-[#637769]">По прямой</p>
                </div>
                <div class="result-metric">
                    <dt class="text-xs text-[#637769]">Точек остановок в радиусе {{ radius }} м</dt>
                    <dd class="mt-1">
                        <span v-if="analysis.metrics.stops_count.value !== null" class="text-xl font-semibold">{{ number(analysis.metrics.stops_count.value) }}</span>
                        <span v-else class="text-sm font-medium">{{ unavailable(analysis.metrics.stops_count.quality.availability) }}</span>
                    </dd>
                </div>
            </dl>
            <p v-if="analysis.metrics.stops_count.value === 0" class="mt-4 text-sm">В выбранном радиусе нет остановок из набора. {{ radius === 300 ? 'Попробуйте радиус 500 м.' : 'Можно выбрать другую точку. Полнота набора не гарантируется.' }}</p>
            <p v-if="stopGroups.length" class="mt-4 text-xs text-[#637769]">Названий в списке: {{ stopGroups.length }}. Одноимённые точки собраны в карточки.</p>
            <ul v-if="stopGroups.length" class="mt-2 max-h-72 space-y-2 overflow-y-auto" aria-label="Остановки по расстоянию">
                <li v-for="group in stopGroups" :key="group.key" class="rounded-md border" :class="group.stops.some(stop => stop.id === selectedStopId) ? 'border-[#2d6450]' : 'border-[#dce3da]'">
                    <button v-if="group.stops.length === 1" type="button" class="w-full rounded-md p-3 text-left text-sm" :class="selectedStopId === group.stops[0]!.id ? 'bg-[#eaf2df]' : ''" :aria-pressed="selectedStopId === group.stops[0]!.id" @click="$emit('selectStop', group.stops[0]!.id)">
                        <span class="block font-medium">{{ group.name }}</span>
                        <span class="text-xs text-[#637769]">{{ number(group.stops[0]!.distance_m) }} м по прямой</span>
                    </button>
                    <details v-else :open="expandedGroupKey === group.key" @toggle="toggleGroup(group.key, $event)">
                        <summary class="cursor-pointer p-3 text-sm">
                            <span class="font-medium">{{ group.name }}</span>
                            <span class="mt-1 block text-xs text-[#637769]">{{ pointCount(group.stops.length) }} · ближайшая {{ number(group.stops[0]!.distance_m) }} м по прямой</span>
                        </summary>
                        <ul class="space-y-1 border-t border-[#dce3da] p-2" :aria-label="`Точки остановки ${group.name}`">
                            <li v-for="stop in group.stops" :key="stop.id">
                                <button type="button" class="w-full rounded-md p-2 text-left text-sm" :class="selectedStopId === stop.id ? 'bg-[#eaf2df]' : 'hover:bg-[#f1f4ed]'" :aria-pressed="selectedStopId === stop.id" @click="$emit('selectStop', stop.id)">
                                    <span class="block font-medium">{{ number(stop.distance_m) }} м по прямой</span>
                                    <span class="text-xs text-[#637769]">Точка на карте: {{ stop.lat.toFixed(5) }}, {{ stop.lon.toFixed(5) }}</span>
                                </button>
                            </li>
                        </ul>
                    </details>
                </li>
            </ul>
            </template>
            <details class="mt-4 text-xs leading-5 text-[#637769]">
                <summary class="cursor-pointer font-medium">ⓘ Источник и качество данных</summary>
                <p class="mt-2">Источник: официальный набор остановок Красноярского края.</p>
                <p>Дата наблюдения: {{ date(analysis.metrics.stops_count.observed_at) }}.</p>
                <p>Актуальность: {{ { CURRENT: 'актуальные', STALE: 'устаревшие', UNKNOWN: 'неизвестна' }[analysis.metrics.stops_count.quality.freshness] }}.</p>
                <p>{{ analysis.coverage.reason }}</p>
                <p>Считаются отдельные точки из набора, а не остановочные зоны. Одинаковые названия сгруппированы только в списке; точки на карте и их количество сохранены. Они могут относиться к разным сторонам дороги. Направления в наборе не указаны.</p>
                <p>{{ analysis.metrics.nearest_stop_distance.quality.reason }}</p>
                <p>{{ analysis.metrics.stops_count.quality.reason }}</p>
                <p>Точка анализа: {{ point.lat.toFixed(5) }}, {{ point.lon.toFixed(5) }}.</p>
                <p>Снимок: {{ analysis.metrics.stops_count.dataset_import_id ?? 'отсутствует' }}. Расчёт: {{ date(analysis.metrics.stops_count.calculated_at) }}.</p>
            </details>
        </template>
    </section>
</template>
