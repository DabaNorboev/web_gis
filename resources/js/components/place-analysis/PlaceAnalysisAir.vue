<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AirHistoryState } from '@/composables/useAirStationHistory'
import type { AirObservation, AnalysisStation } from '@/types/placeAnalysis'

const props = defineProps<{
    station: AnalysisStation
    state: AirHistoryState
    docked: boolean
}>()
const emit = defineEmits<{ retry: []; 'toggle-dock': [] }>()
const stationHeading = ref<HTMLHeadingElement | null>(null)
const number = new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 15 })

const rows = computed(() => props.state.phase === 'ready' ? props.state.history.rows : [])
const activeHour = ref<number | null>(null)
const activeRow = computed(() => activeHour.value === null ? null : rows.value[activeHour.value])
watch(rows, () => { activeHour.value = null })
const period = computed(() => {
    const present = rows.value.filter(row => row.row_present)
    const first = present[0]?.observed_at_raw
    const last = present.at(-1)?.observed_at_raw
    return first === last ? first : `${first} — ${last}`
})
const chart = computed(() => {
    const values = rows.value.flatMap(row => row.value === null ? [] : [row.value])
    const min = Math.min(0, ...values)
    const max = Math.max(0, ...values)
    // Scale around zero even if a source supplied a negative reading.
    const scale = Math.max(-min, max) || 1
    const range = max / scale - min / scale || 1
    const position = (value: number) => 100 * (value / scale - min / scale) / range
    const zero = position(0)
    return {
        hasValues: values.length > 0, min, max, zero,
        bars: rows.value.map(row => {
            if (row.value === null) return null
            if (row.value === 0) return { bottom: `min(${zero}%, calc(100% - 2px))`, height: '2px' }
            const reading = position(row.value)
            return { bottom: `${Math.min(zero, reading)}%`, height: `${Math.abs(reading - zero)}%` }
        }),
    }
})
function rowLabel(row: AirObservation) {
    if (row.value !== null) return number.format(row.value)
    return row.missing_reason === 'SOURCE_ROW_MISSING' ? 'Пропущен час' : 'Пустое значение'
}
function readHour(event: PointerEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    if (bounds.width <= 0) return
    const hour = Math.floor((event.clientX - bounds.left) / bounds.width * rows.value.length)
    activeHour.value = Math.max(0, Math.min(rows.value.length - 1, hour))
}
function clearHour(event: PointerEvent) {
    if (event.pointerType !== 'touch') activeHour.value = null
}
function retry() {
    stationHeading.value?.focus()
    emit('retry')
}
</script>

<template>
    <section class="pa-station-detail" aria-labelledby="pa-air-station">
        <div class="pa-station-detail__header">
            <h2 id="pa-air-station" ref="stationHeading" tabindex="-1">{{ station.name }}</h2>
            <button id="pa-air-dock-toggle" class="pa-outline" type="button" @click="emit('toggle-dock')">
                {{ docked ? 'Вернуть в боковую панель' : 'Открыть график внизу' }}
            </button>
        </div>
        <p class="pa-note">Источник: {{ station.source }}</p>
        <p v-if="station.crs !== 'EPSG:4326'" class="pa-note">Для этого выпуска положение станции неизвестно.</p>
        <p class="pa-note">Архивные измерения на станции. Часовой пояс исходных меток и контроль качества неизвестны.</p>
        <div class="pa-air-status" role="status">
            <p v-if="state.phase === 'loading'">Загрузка истории…</p>
            <p v-else-if="state.phase === 'snapshot-changed'">Локальный снимок изменился. Нажмите «Обновить» рядом со списком станций.</p>
            <p v-else-if="state.phase === 'error'">Не удалось загрузить историю станции.</p>
        </div>
        <button v-if="state.phase === 'error'" class="pa-outline" type="button" @click="retry">Повторить загрузку истории</button>
        <section v-else-if="state.phase === 'ready'" class="pa-history" aria-labelledby="pa-air-history">
            <h3 id="pa-air-history">История PM2.5</h3>
            <p v-if="period" class="pa-note">Период наблюдений: {{ period }}</p>
            <p v-if="!chart.hasValues" class="pa-note">В этом выпуске у станции нет часовых значений PM2.5.</p>
            <div v-if="rows.length" class="pa-chart" aria-hidden="true">
                <div class="pa-chart__readout">
                    <span>мкг/м³</span>
                    <div v-if="activeRow" class="pa-chart__reading">
                        <time>{{ activeRow.observed_at_raw }}</time>
                        <strong>{{ rowLabel(activeRow) }}{{ activeRow.value === null ? '' : ' мкг/м³' }}</strong>
                    </div>
                </div>
                <div class="pa-chart__plot">
                    <div class="pa-chart__scale">
                        <span>{{ number.format(chart.max) }}</span>
                        <span v-if="chart.max !== chart.min">{{ number.format(chart.min) }}</span>
                    </div>
                    <div class="pa-chart__series">
                        <div class="pa-chart__baseline" :style="{ bottom: `${chart.zero}%` }"></div>
                        <div class="pa-chart__bars" :style="{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }"
                            @pointermove="readHour" @pointerdown="readHour" @pointerleave="clearHour" @pointercancel="activeHour = null">
                            <div v-for="(row, index) in rows" :key="row.observed_at_raw" class="pa-chart__bin"
                                :class="{ 'is-active': activeHour === index }" :data-missing-reason="row.missing_reason">
                                <div v-if="chart.bars[index]" class="pa-bar" :class="{ 'is-zero': row.value === 0 }"
                                    :style="chart.bars[index]"></div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="pa-chart__labels">
                    <span>{{ rows[0]?.observed_at_raw.slice(0, 16) }}</span>
                    <span v-if="rows.length > 1">{{ rows.at(-1)?.observed_at_raw.slice(0, 16) }}</span>
                </div>
            </div>
            <details class="pa-air-values">
                <summary>Часовые значения и пропуски</summary>
                <table>
                    <caption class="sr-only">Часовые значения PM2.5: {{ station.name }}</caption>
                    <thead><tr><th scope="col">Время источника</th><th scope="col">PM2.5, мкг/м³</th></tr></thead>
                    <tbody>
                        <tr v-for="row in rows" :key="row.observed_at_raw">
                            <td>{{ row.observed_at_raw }}</td><td>{{ rowLabel(row) }}</td>
                        </tr>
                    </tbody>
                </table>
            </details>
        </section>
    </section>
</template>
