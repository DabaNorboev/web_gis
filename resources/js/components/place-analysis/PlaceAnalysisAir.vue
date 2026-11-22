<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AirSnapshotState } from '@/composables/useAirSnapshotRequest'
import { airDateLabel as dateLabel, airHourLabel as observationLabel, airReadingLabel as rowLabel } from '@/utils/airObservation'
import type { AirObservation, AirStationHistory, AnalysisStation } from '@/types/placeAnalysis'

const props = defineProps<{
    station: AnalysisStation
    state: AirSnapshotState<AirStationHistory>
    selectedHour: string | null
    docked: boolean
}>()
const emit = defineEmits<{ retry: []; 'toggle-dock': []; hour: [literal: string] }>()
const range = defineModel<'recent' | 'archive'>('range', { required: true })
const stationHeading = ref<HTMLHeadingElement | null>(null)
const axisNumber = new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 3, notation: 'compact' })
const releaseTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Krasnoyarsk' })
const releaseUtc = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })

// The API returns one ordered bin per hour up to the exclusive archive end.
const archiveRows = computed(() => props.state.phase === 'ready' ? props.state.data.rows : [])
const rows = computed(() => range.value === 'recent' ? archiveRows.value.slice(-48) : archiveRows.value)
const latest = computed(() => archiveRows.value.filter(row => row.value !== null).at(-1))
const pointer = ref<{ index: number; x: number; y: number } | null>(null)
const activeRow = computed(() => pointer.value && rows.value[pointer.value.index])
const focusedHour = ref<string | null>(null)
const tabHour = computed(() => rows.value.some(row => row.observed_at_raw === focusedHour.value)
    ? focusedHour.value
    : rows.value.find(row => row.observed_at_raw === props.selectedHour)?.observed_at_raw ?? rows.value.at(-1)?.observed_at_raw)
watch(rows, () => { pointer.value = null; focusedHour.value = null })

const archivePeriod = computed(() => formatPeriod(archiveRows.value, false))
const selectedPeriod = computed(() => formatPeriod(rows.value, true))
const timeTicks = computed(() => {
    if (rows.value.length < 8) return []
    return [0.25, 0.5, 0.75].map(fraction => {
        const index = Math.floor(rows.value.length * fraction)
        return { time: rows.value[index]!.observed_at_raw, position: 100 * (index + 0.5) / rows.value.length }
    })
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
    const ticks = !values.length ? [] : min === max ? [0] :
        [1, 0.75, 0.5, 0.25, 0].map(fraction => (1 - fraction) * min + fraction * max)
    return {
        valueCount: values.length, ticks, zero,
        bars: rows.value.map(row => {
            if (row.value === null) return null
            if (row.value === 0) return { bottom: `min(${zero}%, calc(100% - 2px))`, height: '2px' }
            const reading = position(row.value)
            return { bottom: `${Math.min(zero, reading)}%`, height: `${Math.abs(reading - zero)}%` }
        }),
    }
})
function formatPeriod(series: AirObservation[], withTime: boolean) {
    const first = series[0]?.observed_at_raw
    const last = series.at(-1)?.observed_at_raw
    if (!first || !last) return ''
    const sameDate = first.slice(0, 10) === last.slice(0, 10)
    const differentYears = first.slice(0, 4) !== last.slice(0, 4)
    if (!withTime) {
        return sameDate ? dateLabel(last) : `${dateLabel(first, differentYears)} — ${dateLabel(last)}`
    }
    if (first === last) return observationLabel(last, false)
    if (sameDate) return `${observationLabel(first, false)}–${last.slice(11, 16)}`
    return `${observationLabel(first, differentYears)} — ${observationLabel(last, differentYears)}`
}
function readHour(event: PointerEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    pointer.value = { index: Math.min(rows.value.length - 1, Math.floor(x * rows.value.length)), x, y }
}
function moveHourFocus(event: KeyboardEvent) {
    const index = rows.value.findIndex(row => row.observed_at_raw === tabHour.value)
    const last = rows.value.length - 1
    const nextByKey: Partial<Record<string, number>> = {
        ArrowLeft: Math.max(0, index - 1), ArrowRight: Math.min(last, index + 1), Home: 0, End: last,
    }
    const next = nextByKey[event.key]
    if (next === undefined) return
    event.preventDefault()
    const plot = event.currentTarget as HTMLElement
    plot.querySelectorAll('button')[next]?.focus()
}
function clearHour(event: PointerEvent) {
    if (event.pointerType !== 'touch') pointer.value = null
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
            <button id="pa-air-dock-toggle" class="pa-outline" type="button"
                :aria-label="docked ? 'Вернуть в боковую панель' : undefined" @click="emit('toggle-dock')">
                {{ docked ? 'В боковую панель' : 'Открыть график внизу' }}
            </button>
        </div>
        <div class="pa-station-detail__body">
            <div class="pa-air-status" role="status">
                <p v-if="state.phase === 'loading'">Загрузка истории…</p>
                <p v-else-if="state.phase === 'snapshot-changed'">Локальный снимок изменился. Нажмите «Обновить» рядом со списком станций.</p>
                <p v-else-if="state.phase === 'error'">Не удалось загрузить историю станции.</p>
            </div>
            <button v-if="state.phase === 'error'" class="pa-outline" type="button" @click="retry">Повторить загрузку истории</button>
            <section v-else-if="state.phase === 'ready'" class="pa-history" aria-labelledby="pa-air-history">
                <div class="pa-history__overview">
                    <div class="pa-history__summary">
                        <div class="pa-air-latest">
                            <p>Последнее значение PM₂.₅ в архиве</p>
                            <template v-if="latest">
                                <strong>{{ rowLabel(latest) }} мкг/м³</strong>
                                <time class="pa-air-hour" :datetime="latest.observed_at_raw.replace(' ', 'T')">
                                    <span class="sr-only">Время по источнику: </span>{{ observationLabel(latest.observed_at_raw) }}
                                </time>
                            </template>
                            <p v-else>У станции нет числовых значений в архиве.</p>
                        </div>
                        <div class="pa-air-meta">
                            <p v-if="range === 'recent' && selectedPeriod" class="pa-note">График: {{ selectedPeriod }}</p>
                            <p v-if="archivePeriod" class="pa-note">Архив: {{ archivePeriod }}</p>
                            <p class="pa-note">
                                Обновлено:
                                <time :datetime="state.data.last_success_at" :title="`${releaseUtc.format(new Date(state.data.last_success_at))} UTC`">
                                    {{ releaseTime.format(new Date(state.data.last_success_at)) }} (Красноярск)
                                </time>
                            </p>
                        </div>
                    </div>
                    <div class="pa-history__main">
                        <div class="pa-history__heading">
                            <div>
                                <h3 id="pa-air-history">История PM2.5</h3>
                                <p class="pa-note pa-air-coverage" role="status">{{ chart.valueCount }} из {{ rows.length }} часов со значениями</p>
                            </div>
                            <select v-model="range" class="pa-outline" aria-label="Период графика PM2.5">
                                <option value="recent">48 часов</option>
                                <option value="archive">Весь архив</option>
                            </select>
                        </div>
                        <div v-if="rows.length" class="pa-chart">
                            <span class="pa-chart__unit">мкг/м³</span>
                            <div class="pa-chart__plot">
                                <div class="pa-chart__scale" aria-hidden="true">
                                    <span v-for="(tick, index) in chart.ticks" :key="index">{{ axisNumber.format(tick) }}</span>
                                </div>
                                <div class="pa-chart__series">
                                    <div v-if="chart.ticks.length > 1" class="pa-chart__grid">
                                        <span v-for="(_, index) in chart.ticks" :key="index"></span>
                                    </div>
                                    <div v-if="chart.valueCount" class="pa-chart__baseline" :style="{ bottom: `${chart.zero}%` }"></div>
                                    <div class="pa-chart__bars" :style="{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }"
                                        role="group" aria-label="Выбор часа PM₂.₅" @keydown="moveHourFocus"
                                        @pointermove="readHour" @pointerdown="readHour" @pointerleave="clearHour" @pointercancel="pointer = null">
                                        <button v-for="(row, index) in rows" :key="row.observed_at_raw" type="button" class="pa-chart__bin"
                                            :class="{ 'is-active': pointer?.index === index }" :data-missing-reason="row.missing_reason"
                                            :tabindex="tabHour === row.observed_at_raw ? 0 : -1" :aria-pressed="selectedHour === row.observed_at_raw"
                                            :aria-label="`${observationLabel(row.observed_at_raw)} · ${rowLabel(row)}${row.value === null ? '' : ' мкг/м³'}`"
                                            @focus="focusedHour = row.observed_at_raw" @click="emit('hour', row.observed_at_raw)">
                                            <span v-if="chart.bars[index]" class="pa-bar" :class="{ 'is-zero': row.value === 0 }"
                                                :style="chart.bars[index]"></span>
                                        </button>
                                    </div>
                                    <div v-if="activeRow && pointer" class="pa-chart__reading" aria-hidden="true"
                                        :class="{ 'is-left': pointer.x > 0.5, 'is-above': pointer.y > 0.5 }"
                                        :style="{ '--pointer-x': `${pointer.x * 100}%`, '--pointer-y': `${pointer.y * 100}%` }">
                                        <time :datetime="activeRow.observed_at_raw.replace(' ', 'T')">{{ observationLabel(activeRow.observed_at_raw) }}</time>
                                        <strong>{{ rowLabel(activeRow) }}{{ activeRow.value === null ? '' : ' мкг/м³' }}</strong>
                                    </div>
                                </div>
                                <div class="pa-chart__labels" aria-hidden="true">
                                    <span>{{ observationLabel(rows[0]!.observed_at_raw, false) }}</span>
                                    <span v-for="tick in timeTicks" :key="tick.time" class="pa-chart__tick" :style="{ left: `${tick.position}%` }">
                                        {{ observationLabel(tick.time, false) }}
                                    </span>
                                    <span v-if="rows.length > 1">{{ observationLabel(rows.at(-1)!.observed_at_raw, false) }}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <details class="pa-air-values">
                    <summary>Часовые значения и пропуски</summary>
                    <table>
                        <caption class="sr-only">Часовые значения PM2.5: {{ station.name }}</caption>
                        <thead><tr><th scope="col">Время источника</th><th scope="col">PM2.5, мкг/м³</th></tr></thead>
                        <tbody>
                            <tr v-for="row in rows" :key="row.observed_at_raw">
                                <td>{{ observationLabel(row.observed_at_raw) }}</td><td>{{ rowLabel(row) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </details>
            </section>
            <p class="pa-note">Источник: <a href="https://air.krasn.ru/" target="_blank" rel="noopener noreferrer">{{ station.source }}</a></p>
            <p class="pa-note">Архивные измерения на станции. Часовой пояс исходных меток и контроль качества неизвестны.</p>
            <p v-if="station.crs !== 'EPSG:4326'" class="pa-note">Для этого выпуска положение станции неизвестно.</p>
        </div>
    </section>
</template>
