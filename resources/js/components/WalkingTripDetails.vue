<script setup lang="ts">
import { coordinateLabel, snapDistance, tripDistance, tripDuration } from '@/utils/trips'
import type { TripResult } from '@/types/trips'

defineProps<{ row: TripResult }>()
</script>

<template>
    <div class="walking-trip-details">
        <p class="walking-scope"><strong>Дорожная часть между выбранными уличными точками</strong></p>
        <template v-if="row.status === 'AVAILABLE' && row.route">
            <p class="walking-values">{{ row.metrics.distance.value === null ? 'Расстояние неизвестно' : tripDistance(row.metrics.distance.value) }}</p>
            <p>{{ row.metrics.duration.value === null ? 'Время неизвестно' : tripDuration(row.metrics.duration.value) }} — модельное время уличной части. Ожидание переходов и подходы не учтены.</p>
        </template>
        <p>Полный путь между исходными объектами неизвестен: расстояние и время не рассчитаны. Расстояние и время подхода неизвестны. Вход и его доступность не подтверждены.</p>
        <p v-if="row.selection_kind === 'DIFFERENT_STREET_POINTS'" class="walking-different">Выбраны другие уличные точки: смещение от исходного объекта превышает 20 м. Это отдельный выбор улицы; достижимость исходного объекта не подтверждена.</p>
        <details class="walking-points"><summary>Исходные объекты и выбранные улицы</summary>
        <div v-for="end in (['start', 'target'] as const)" :key="end" class="walking-endpoint">
            <p><strong>{{ end === 'start' ? 'Старт' : 'Место' }}</strong><br />Исходный объект: {{ coordinateLabel(row[end === 'start' ? 'start' : 'target']) }}<br />Выбранная улица: {{ row.street_points?.[end] ? coordinateLabel(row.street_points[end]) : 'неизвестна' }}</p>
            <p>Геометрическое смещение объекта к улице: {{ row.approaches?.[end]?.selection_shift_m == null ? 'неизвестно' : snapDistance(row.approaches[end].selection_shift_m!) }}. Это не расстояние подхода.</p>
            <p>{{ row.approaches?.[end]?.status === 'NOT_INCLUDED' ? 'Отдельный подход не включён: введена уличная точка.' : 'Подход от объекта к улице неизвестен.' }} Расстояние и время подхода неизвестны. Вход и его доступность не подтверждены.</p>
        </div>
        <p>Успех уличной части не подтверждает доступ к входу или доступность для коляски.</p>
        </details>
    </div>
</template>

<style scoped>
.walking-trip-details{font-size:13px;line-height:1.65}.walking-trip-details p{margin-top:10px}.walking-scope{color:#2d6450}.walking-values{font-size:25px;font-weight:600;color:#2d6450}.walking-endpoint{margin-top:14px;padding-top:2px;border-top:1px solid #dfe5d9}.walking-different{padding:12px;border:1px solid #c69d4b;border-radius:8px;background:#fff5df;color:#513b16}
.walking-points{margin-top:12px}.walking-points summary{cursor:pointer;min-height:36px;padding-top:7px;color:#2d6450}.walking-points summary:focus-visible{outline:3px solid #2d6450;outline-offset:2px}
</style>
