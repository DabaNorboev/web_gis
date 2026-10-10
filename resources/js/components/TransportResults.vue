<script setup lang="ts">
import type { TransportAnalysis, MetricKey, Coordinates } from '@/types/transport'

defineProps<{
    point: Coordinates
    analysis: TransportAnalysis | null
    status: 'idle' | 'loading' | 'ready' | 'error'
}>()
defineEmits<{ retry: []; reset: [] }>()
const labels: Record<MetricKey, string> = {
    nearest_stop_distance: 'До ближайшей остановки',
    stops_count: 'Остановки в 500 м',
    unique_routes_count: 'Уникальные маршруты в 500 м',
    identified_routes_count: 'Ключи с определённым видом транспорта',
}
const keys: MetricKey[] = ['nearest_stop_distance', 'stops_count', 'unique_routes_count']
function date(value: string | null) {
    return value ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC' }).format(new Date(value)) : 'неизвестна'
}
</script>

<template>
    <section class="transport-results" aria-labelledby="transport-title" aria-live="polite" :aria-busy="status === 'loading'">
        <div class="flex items-center justify-between gap-2">
            <h2 id="transport-title" class="text-base font-semibold">Транспорт рядом</h2>
            <button type="button" class="result-action" @click="$emit('reset')">Сбросить</button>
        </div>
        <p class="mt-1 text-xs text-[#637769]">Точка: {{ point.lat.toFixed(5) }}, {{ point.lon.toFixed(5) }}</p>
        <p v-if="status === 'loading'" class="mt-4 text-sm" role="status">Рассчитываем окружение…</p>
        <div v-else-if="status === 'error'" class="result-notice mt-4" role="alert">
            <p>Не удалось получить данные транспорта.</p>
            <button type="button" class="result-action mt-2" @click="$emit('retry')">Повторить запрос</button>
        </div>
        <template v-else-if="analysis">
            <p v-if="analysis.nearest_stop" class="mt-4 text-sm font-medium">{{ analysis.nearest_stop.name }}</p>
            <dl class="mt-3 space-y-3">
                <div v-for="key in keys" :key="key" class="result-metric">
                    <dt class="text-xs text-[#637769]">{{ labels[key] }}</dt>
                    <dd class="mt-1 text-xl font-semibold">
                        <template v-if="analysis.metrics[key].value !== null">
                            {{ new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(analysis.metrics[key].value) }}{{ key === 'nearest_stop_distance' ? ' м' : '' }}
                        </template>
                        <span v-else class="text-sm font-medium">{{ analysis.metrics[key].quality.availability === 'UNAVAILABLE' ? 'Данные недоступны' : 'Недостаточно данных' }}</span>
                    </dd>
                    <p class="mt-1 text-xs leading-5 text-[#637769]">{{ analysis.metrics[key].quality.reason }}</p>
                </div>
            </dl>
            <p v-if="analysis.metrics.unique_routes_count.value === null && analysis.metrics.identified_routes_count.value !== null" class="result-notice mt-3">
                Определены ключи маршрутов: {{ analysis.metrics.identified_routes_count.value }}. Это частичный результат, а не полное число действующих маршрутов.
            </p>
            <details class="mt-4 text-xs leading-5 text-[#637769]">
                <summary class="cursor-pointer font-medium">Источник и качество данных</summary>
                <p class="mt-2">Источник: официальный набор остановок Красноярского края.</p>
                <p>Дата наблюдения: {{ date(analysis.metrics.stops_count.observed_at) }}.</p>
                <p>Актуальность: {{ { CURRENT: 'актуальные', STALE: 'устаревшие', UNKNOWN: 'неизвестна' }[analysis.metrics.stops_count.quality.freshness] }}.</p>
                <p>Снимок: {{ analysis.metrics.stops_count.dataset_import_id ?? 'отсутствует' }}. Расчёт: {{ date(analysis.metrics.stops_count.calculated_at) }}.</p>
                <p>Показатели рассчитаны по импортированному набору. Полнота действующей сети не подтверждена.</p>
            </details>
        </template>
    </section>
</template>
