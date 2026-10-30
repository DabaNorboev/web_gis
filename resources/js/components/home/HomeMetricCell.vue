<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { ComparisonSide } from '@/composables/useAddressComparison'
import type { AddressProfile } from '@/types/profile'
import { comparisonMetric, type ComparisonRow } from '@/utils/comparisonPresentation'
import { formatMetric } from '@/utils/metricDisplay'
import { mappedNearestId } from '@/utils/mapAnalysis'
import { homeMetricDetails, homeMetricPresentation, homeMetricStateText } from '@/utils/homeMetricPresentation'
import type { SideKey } from '@/utils/comparison'

const props = defineProps<{ row: ComparisonRow; side: SideKey; profile: AddressProfile | null; status: ComparisonSide['status']; radius: number }>()
const emit = defineEmits<{ retry: []; showMap: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
let returnFocus = true
const sideName = computed(() => props.side === 'left' ? 'А' : 'Б')
const block = computed(() => props.profile?.blocks[props.row.category])
const blockError = computed(() => block.value?.status === 'ERROR' ? block.value.message : null)
const ready = computed(() => props.status === 'ready' && block.value?.status === 'READY')
const presentation = computed(() => ready.value ? homeMetricPresentation(props.profile, props.row, props.radius) : null)
const metric = computed(() => ready.value ? comparisonMetric(props.profile, props.row) : undefined)
const details = computed(() => metric.value ? homeMetricDetails(metric.value, presentation.value?.coverage) : null)
const hasGeometry = computed(() => {
    if (!props.profile || !props.row.key.includes('distance')) return false
    if (props.row.category === 'transport') {
        const id = props.profile.blocks.transport.status === 'READY' ? props.profile.blocks.transport.data.nearest_stop?.id : null
        return id != null && props.profile.map.stops_in_radius.some(stop => stop.id === id)
    }
    return mappedNearestId(props.profile, props.row.category) != null
})
function openDetails(event: MouseEvent) { returnFocus = true; trigger.value = event.currentTarget as HTMLButtonElement; dialog.value?.showModal() }
async function restoreFocus() { if (!returnFocus) return; await nextTick(); trigger.value?.focus() }
function showMap() { returnFocus = false; dialog.value?.close(); emit('showMap') }
const statusText = computed(() => homeMetricStateText(props.status, null))
</script>

<template>
    <div class="home-metric-cell">
        <template v-if="ready && metric">
            <strong class="home-cell-value" :class="{ 'home-cell-value--missing': metric.value === null }">{{ formatMetric(metric) }}</strong>
            <div class="home-cell-note">
                <span v-if="presentation?.nearestName">{{ presentation.nearestName }}</span>
                <span v-if="presentation?.beyond">Дальше круга {{ radius }} м.</span>
                <span v-if="metric.value === null" role="note">{{ metric.quality.reason }}</span>
                <span v-if="metric.quality.freshness === 'STALE'" role="note">Данные устарели: {{ metric.quality.reason }}</span>
                <span v-if="presentation?.coverage && presentation.coverage.status !== 'COVERED'" role="note">{{ presentation.coverage.reason }}</span>
                <span v-if="presentation?.access" role="note">Доступ по OSM: {{ presentation.access === 'private' ? 'частный' : presentation.access === 'no' ? 'запрещён' : presentation.access }}. Вход не подтверждён.</span>
            </div>
        </template>
        <div v-else-if="blockError" class="home-cell-note" role="alert">
            <span>{{ blockError }}</span>
            <button class="home-cell-actions" type="button" @click="emit('retry')">Повторить расчёт</button>
        </div>
        <p v-else class="home-cell-note">{{ statusText }}</p>
        <div class="home-cell-actions"><button type="button" :aria-label="`Подробности: ${row.label}, ${sideName}`" @click="openDetails">ⓘ</button></div>
        <dialog ref="dialog" class="home-result-dialog" :aria-labelledby="`home-details-${side}-${row.category}-${row.key}`" @close="restoreFocus">
            <div class="home-result-dialog-content">
                <h2 :id="`home-details-${side}-${row.category}-${row.key}`">{{ row.label }} · вариант {{ sideName }}</h2>
                <template v-if="metric && details">
                    <p>{{ presentation?.explanation.full }}</p>
                    <p><strong>Результат:</strong> {{ formatMetric(metric) }}. <strong>Причина/ограничение:</strong> {{ details.reason }}</p>
                    <p><strong>Метод:</strong> {{ details.method }}. <strong>Доступность:</strong> {{ details.availability }}. <strong>Актуальность:</strong> {{ details.freshness }}.</p>
                    <p><strong>Источник:</strong> {{ details.source }}. <strong>Снимок:</strong> {{ details.snapshot }}. <strong>Версия методики:</strong> {{ details.methodVersion }}.</p>
                    <p><strong>Наблюдение:</strong> {{ details.observationDate }}. <strong>Публикация/версия источника:</strong> {{ details.publicationDate }} (не дата наблюдения). <strong>Расчёт:</strong> {{ details.calculationDate }} (UTC).</p>
                    <p><strong>Охват:</strong> {{ details.coverageStatus }} · {{ details.coverageReason }} <strong>Радиус:</strong> {{ details.coverageRadius }} м. <strong>Буфер:</strong> {{ details.coverageBuffer }} м.</p>
                    <p v-if="presentation?.access">Доступ по OSM: {{ presentation.access }}. Он не подтверждает фактическую доступность входа.</p>
                    <template v-if="row.key.includes('distance')">
                        <p v-if="!hasGeometry">Геометрии ближайшего объекта в ответе нет. На карте можно показать только слой категории.</p>
                        <button type="button" class="home-cell-actions" @click="showMap">На карте {{ sideName }}</button>
                    </template>
                </template>
                <template v-else>
                    <p>{{ blockError ?? statusText }}</p>
                    <p>{{ homeMetricPresentation(profile, row, radius).explanation.full }}</p>
                    <button v-if="blockError" type="button" class="home-cell-actions" @click="emit('retry')">Повторить расчёт</button>
                </template>
                <button type="button" class="home-cell-actions" @click="dialog?.close()">Закрыть</button>
            </div>
        </dialog>
    </div>
</template>
