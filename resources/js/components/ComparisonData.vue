<script setup lang="ts">
import { computed } from 'vue'
import type { AddressProfile } from '@/types/profile'
import { profileSources, sourceName, freshnessNames, methodNames, availabilityNames } from '@/utils/profilePresentation'
import { formatDate } from '@/utils/metricDisplay'
const props = defineProps<{ profile: AddressProfile; side: string }>()
const sources = computed(() => profileSources(props.profile, { includeAreas: true }))
</script>
<template>
    <section class="comparison-data-side" :aria-label="`О данных варианта ${side}`">
        <h2>{{ side }} · {{ profile.address.label }}</h2>
        <details class="comparison-source"><summary>Адрес и точка · {{ side }}</summary>
            <p>{{ profile.address.source }} · дата наблюдения: {{ formatDate(profile.address.observed_at) }}.</p>
            <p>Версия / публикация: {{ formatDate(profile.address.source_updated_at) }}. Это не дата наблюдения.</p>
            <p>{{ profile.address.reason }} Контур не обозначает вход.</p>
            <p>Точка: {{ profile.point.lat.toFixed(6) }}, {{ profile.point.lon.toFixed(6) }}. Снимок адресов: {{ profile.address.dataset_import_id }}.</p>
        </details>
        <section v-for="(section, index) in sources.sections" :key="index" class="comparison-source">
            <h3>{{ sourceName(section.metric.source) }}</h3>
            <p>{{ section.rows.flatMap(row => row.labels).join(' · ') }}</p>
            <p>{{ section.metric.observed_at ? `Наблюдение: ${formatDate(section.metric.observed_at)}` : 'Дата наблюдения неизвестна' }} · актуальность: {{ freshnessNames[section.metric.quality.freshness] }}.</p>
            <p>{{ availabilityNames[section.metric.quality.availability] }}. {{ section.coverage.reason }}</p>
            <details><summary>Метод, даты и ограничения · {{ side }}</summary>
                <div v-for="row in section.rows" :key="row.labels.join()"><h4>{{ row.labels.join(' · ') }}</h4><p>{{ row.metric.quality.method ? methodNames[row.metric.quality.method] : 'Результата нет' }}. {{ row.metric.quality.reason }}</p></div>
                <p>Версия / публикация: {{ formatDate(section.metric.source_updated_at) }}. Это не дата наблюдения.</p>
                <p>Снимок: {{ section.metric.dataset_import_id ?? 'неизвестен' }} · расчёт: {{ section.metric.calculated_at }} (UTC).</p>
                <p>Версия методики: {{ section.metric.method_version ?? 'неизвестна' }}. Покрытие: {{ section.coverage.status }}.</p>
                <p>Подтверждённый радиус: {{ section.coverage.available_radius_m === null ? 'неизвестен' : `${section.coverage.available_radius_m} м` }}. Буфер: {{ section.coverage.buffer_m === null ? 'неизвестен' : `${section.coverage.buffer_m} м` }}.</p>
            </details>
        </section>
        <p v-for="error in sources.errors" :key="error.title" role="alert">{{ error.title }}: {{ error.message }}</p>
        <p>Расчёт профиля: {{ formatDate(profile.calculated_at) }} (UTC). Ссылка открывает текущие данные.</p>
    </section>
</template>
<style scoped>
.comparison-data-side { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
h2 { font-weight: 650; margin-top: 16px; }
h3, h4 { font-weight: 600; }
.comparison-source { padding-block: 10px; border-bottom: 1px solid #dce4d7; }
p { margin-top: 5px; color: #526458; }
summary { cursor: pointer; padding-block: 6px; color: #2d6450; }
</style>
