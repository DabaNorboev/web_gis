<script setup lang="ts">
import { formatMetric } from '@/utils/metricDisplay'
import type { MetricResult } from '@/types/profile'
import type { SpatialCoverage } from '@/types/transport'
defineProps<{
    title: string
    metric?: MetricResult
    name?: string | null
    access?: string | null
    coverage?: SpatialCoverage
    error?: string | null
    distanceTo?: string
    selected?: boolean
    mapNote?: string
    mapLabel?: string
}>()
defineEmits<{ retry: []; showMap: [] }>()
</script>

<template>
    <article class="profile-metric" :class="{ 'is-map-selected': selected }">
        <div class="profile-metric-line">
            <h3>{{ title }}</h3>
            <strong v-if="metric">{{ formatMetric(metric) }}</strong>
        </div>
        <div v-if="error" role="alert" class="address-warning">{{ error }} <button type="button" class="profile-action" @click="$emit('retry')">Повторить расчёт</button></div>
        <template v-else-if="metric">
            <p v-if="name" class="profile-object-name">{{ name }}</p>
            <p v-if="metric.value !== null" class="address-note">{{ distanceTo ?? 'По прямой' }}</p>
            <p v-else class="address-warning">{{ metric.quality.reason }}</p>
            <p v-if="metric.quality.freshness === 'STALE'" class="address-warning">Данные устарели.</p>
            <p v-if="coverage && coverage.status !== 'COVERED'" class="address-warning">{{ coverage.reason }}</p>
            <p v-if="access" class="address-warning">Доступ по OSM: {{ access === 'private' ? 'частный' : access === 'no' ? 'запрещён' : access }}.</p>
            <p v-if="mapNote" class="address-note">{{ mapNote }}</p>
            <button v-if="mapLabel" :aria-pressed="selected === undefined ? undefined : selected" type="button" class="profile-action" @click="$emit('showMap')">{{ mapLabel }}</button>
        </template>
    </article>
</template>
