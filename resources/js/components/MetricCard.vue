<script setup lang="ts">
import type { MetricResult } from '@/types/profile'
import { formatMetric, formatDate } from '@/utils/metricDisplay'
defineProps<{ label: string; metric: MetricResult; nearestName?: string | null; access?: string | null }>()
const freshness = { CURRENT: 'актуальные', STALE: 'устаревшие', UNKNOWN: 'неизвестна' }
const methods: Record<string, string> = { DIRECT: 'Прямые данные', DERIVED: 'Расчёт по исходным данным', PROXY: 'Косвенная оценка' }
</script>

<template>
    <article class="metric-card">
        <h3 class="text-sm leading-5 text-[#637769]">{{ label }}</h3>
        <p class="mt-3 font-semibold" :class="metric.value === null ? 'text-base' : 'text-2xl'">{{ formatMetric(metric) }}</p>
        <p v-if="nearestName" class="mt-2 text-sm">{{ nearestName }}</p>
        <p v-if="access" class="mt-1 text-xs text-[#705629]">Доступ по OSM: {{ access === 'private' ? 'частный' : access === 'no' ? 'запрещён' : access }}. Вход не подтверждён.</p>
        <details class="mt-3 text-xs leading-5 text-[#637769]">
            <summary class="cursor-pointer font-medium">Источник и ограничения</summary>
            <p class="mt-3">{{ metric.source === '24bpd' ? 'Официальный набор остановок' : metric.source }} · наблюдение: {{ formatDate(metric.observed_at) }}</p>
            <p class="mt-1">Актуальность: {{ freshness[metric.quality.freshness] }}</p>
            <p class="mt-2">{{ metric.quality.reason }}</p>
            <p>Метод: {{ metric.quality.method ? (methods[metric.quality.method] ?? metric.quality.method) : 'результата нет' }}.</p>
            <p>Версия / публикация источника: {{ formatDate(metric.source_updated_at) }}. Это не дата наблюдения.</p>
            <p>Снимок: {{ metric.dataset_import_id ?? 'отсутствует' }} · расчёт: {{ formatDate(metric.calculated_at) }} (UTC).</p>
            <p v-if="metric.method_version">Версия методики: {{ metric.method_version }}.</p>
        </details>
    </article>
</template>
