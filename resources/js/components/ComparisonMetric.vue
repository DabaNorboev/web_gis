<script setup lang="ts">
import ProfileMetric from '@/components/ProfileMetric.vue'
import type { SpatialCoverage } from '@/types/transport'
import type { MetricResult } from '@/types/profile'
import { formatMetric, formatDate } from '@/utils/metricDisplay'

defineProps<{ side: string; label: string; metric: MetricResult; nearestName?: string | null; access?: string | null; compact?: boolean; coverage?: SpatialCoverage; beyond?: boolean }>()
const freshness = { CURRENT: 'актуальные', STALE: 'устаревшие', UNKNOWN: 'неизвестна' }
const methods: Record<string, string> = { DIRECT: 'Прямые данные', DERIVED: 'Расчёт по исходным данным', PROXY: 'Косвенная оценка' }
</script>

<template>
    <div class="comparison-metric" :class="{ 'comparison-metric--compact': compact }" :aria-label="`${label}, вариант ${side}`">
        <template v-if="compact">
            <ProfileMetric :title="side" :metric="metric" :name="nearestName" :access="access" :coverage="coverage" :distance-to="metric.unit === 'm' ? undefined : 'В выбранном круге'" />
            <p v-if="beyond" class="comparison-warning">За кругом анализа</p>
        </template>
        <template v-else>
        <p class="comparison-value" :class="{ 'comparison-value--missing': metric.value === null }"><span class="comparison-side">{{ side }} · </span>{{ formatMetric(metric) }}</p>
        <p v-if="nearestName" class="comparison-nearest">{{ nearestName }}</p>
        <p v-if="access" class="comparison-warning">Доступ по OSM: {{ access === 'private' ? 'частный' : access === 'no' ? 'запрещён' : access }}. Вход не подтверждён.</p>
        <p class="comparison-observation">{{ metric.observed_at ? `Наблюдение: ${formatDate(metric.observed_at)}` : 'Дата наблюдения неизвестна' }}</p>
        <p class="comparison-freshness" :class="{ 'comparison-warning': metric.quality.freshness === 'STALE' }">Актуальность: {{ freshness[metric.quality.freshness] }}</p>
        <p v-if="metric.value === null || metric.quality.freshness === 'STALE'" class="comparison-warning">{{ metric.quality.reason }}</p>
        <details class="comparison-source">
            <summary :aria-label="`Источник и ограничения: ${label}, вариант ${side}`">Источник и ограничения</summary>
            <p>{{ metric.source === '24bpd' ? 'Официальный набор остановок' : metric.source }}</p>
            <p>{{ metric.quality.reason }}</p>
            <p>Метод: {{ metric.quality.method ? (methods[metric.quality.method] ?? metric.quality.method) : 'результата нет' }}.</p>
            <p>Версия / публикация: {{ formatDate(metric.source_updated_at) }}. Это не дата наблюдения.</p>
            <p>Снимок: {{ metric.dataset_import_id ?? 'отсутствует' }} · расчёт: {{ formatDate(metric.calculated_at) }} (UTC).</p>
            <p v-if="metric.method_version">Версия методики: {{ metric.method_version }}.</p>
        </details>
        </template>
    </div>
</template>

<style scoped>
.comparison-metric--compact :deep(.profile-metric) { padding: 0; }
.comparison-metric--compact :deep(.profile-metric-line) { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
.comparison-metric--compact :deep(h3) { font-size: 11px; color: #637769; }
.comparison-metric--compact :deep(strong) { font-size: 20px; font-weight: 650; }
.comparison-metric--compact :deep(p) { font-size: 11px; line-height: 1.5; margin-top: 3px; }
.comparison-metric { min-width: 0; overflow-wrap: anywhere; }
.comparison-value { font-size: 21px; font-weight: 650; line-height: 1.3; }
.comparison-value--missing { font-size: 14px; }
.comparison-side { margin-right: 5px; font-size: 11px; font-weight: 600; color: #637769; }
.comparison-nearest { margin-top: 4px; font-size: 12px; line-height: 1.45; }
.comparison-observation, .comparison-freshness { margin-top: 4px; color: #526458; font-size: 11px; line-height: 1.45; }
.comparison-freshness { margin-top: 0; }
.comparison-warning { margin-top: 4px; color: #705629; font-size: 12px; line-height: 1.5; }
.comparison-source { margin-top: 6px; color: #526458; font-size: 11px; line-height: 1.6; }
.comparison-source summary { cursor: pointer; min-height: 28px; padding-block: 4px; text-decoration: underline; text-underline-offset: 3px; }
.comparison-source p { margin-top: 6px; }
@media (max-width: 767px) {
    .comparison-source summary { min-height: 36px; }
}
</style>
