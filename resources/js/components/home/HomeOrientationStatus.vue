<script setup lang="ts">
import type { HomeOrientationCell, HomeOrientationGroup } from '@/types/homeOrientations'
defineProps<{ group: HomeOrientationGroup; cell: HomeOrientationCell }>()
</script>
<template>
    <div v-if="group.threshold !== null" class="home-orientation-status" :data-orientation-status="cell.result.status" :data-result-state="cell.state">
        <div class="home-orientation-scale" aria-hidden="true">
            <i v-if="cell.percent !== null" :style="{ width: `${cell.percent}%` }" />
            <b v-if="group.thresholdPercent !== null" :style="{ left: `${group.thresholdPercent}%` }" />
        </div>
        <span>{{ cell.result.status === 'unavailable' ? 'Нет оценки по ориентиру' : cell.result.text }}</span>
        <small>Ориентир {{ group.threshold }} {{ group.unit === 'minutes' ? 'мин' : 'м' }}</small>
    </div>
</template>
