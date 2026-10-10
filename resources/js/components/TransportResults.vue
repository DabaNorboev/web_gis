<script setup lang="ts">
import type { TransportAnalysis, Coordinates } from '@/types/transport'

defineProps<{
    point: Coordinates
    analysis: TransportAnalysis | null
    status: 'idle' | 'loading' | 'ready' | 'error'
}>()
defineEmits<{ retry: []; reset: [] }>()
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
            <h2 id="transport-title" class="text-base font-semibold">Транспорт рядом</h2>
            <button type="button" class="result-action" @click="$emit('reset')">Сбросить</button>
        </div>
        <p v-if="status === 'loading'" class="mt-4 text-sm" role="status">Рассчитываем окружение…</p>
        <div v-else-if="status === 'error'" class="result-notice mt-4" role="alert">
            <p>Не удалось получить данные транспорта.</p>
            <button type="button" class="result-action mt-2" @click="$emit('retry')">Повторить запрос</button>
        </div>
        <template v-else-if="analysis">
            <dl class="mt-4 space-y-3">
                <div class="result-metric">
                    <dt class="text-xs text-[#637769]">Ближайшая остановка</dt>
                    <dd class="mt-2">
                        <p v-if="analysis.nearest_stop" class="text-sm font-medium">{{ analysis.nearest_stop.name }}</p>
                        <p v-if="analysis.metrics.nearest_stop_distance.value !== null" class="mt-2 text-3xl font-semibold">
                            {{ number(analysis.metrics.nearest_stop_distance.value) }} м
                        </p>
                        <p v-else class="mt-1 text-sm font-medium">{{ unavailable(analysis.metrics.nearest_stop_distance.quality.availability) }}</p>
                    </dd>
                    <p v-if="analysis.metrics.nearest_stop_distance.value !== null" class="mt-1 text-xs text-[#637769]">По прямой</p>
                </div>
                <div class="result-metric">
                    <dt class="text-xs text-[#637769]">Точек остановок в радиусе 500 м</dt>
                    <dd class="mt-1">
                        <span v-if="analysis.metrics.stops_count.value !== null" class="text-xl font-semibold">{{ number(analysis.metrics.stops_count.value) }}</span>
                        <span v-else class="text-sm font-medium">{{ unavailable(analysis.metrics.stops_count.quality.availability) }}</span>
                    </dd>
                </div>
                <div class="result-metric">
                    <dt class="text-xs text-[#637769]">Маршруты</dt>
                    <dd class="mt-1 text-sm font-medium">{{ unavailable(analysis.metrics.unique_routes_count.quality.availability) }}</dd>
                </div>
            </dl>
            <details class="mt-4 text-xs leading-5 text-[#637769]">
                <summary class="cursor-pointer font-medium">ⓘ Источник и качество данных</summary>
                <p class="mt-2">Источник: официальный набор остановок Красноярского края.</p>
                <p>Дата наблюдения: {{ date(analysis.metrics.stops_count.observed_at) }}.</p>
                <p>Актуальность: {{ { CURRENT: 'актуальные', STALE: 'устаревшие', UNKNOWN: 'неизвестна' }[analysis.metrics.stops_count.quality.freshness] }}.</p>
                <p>Считаются отдельные точки из набора, а не остановочные зоны. Точки одного названия и разных направлений не объединяются.</p>
                <p>{{ analysis.metrics.nearest_stop_distance.quality.reason }}</p>
                <p>{{ analysis.metrics.stops_count.quality.reason }}</p>
                <p>Сведения о действующих маршрутах ещё не подтверждены. {{ analysis.metrics.unique_routes_count.quality.reason }}</p>
                <p>Точка анализа: {{ point.lat.toFixed(5) }}, {{ point.lon.toFixed(5) }}.</p>
                <p>Снимок: {{ analysis.metrics.stops_count.dataset_import_id ?? 'отсутствует' }}. Расчёт: {{ date(analysis.metrics.stops_count.calculated_at) }}.</p>
            </details>
        </template>
    </section>
</template>
