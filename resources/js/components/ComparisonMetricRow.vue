<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import ComparisonMetric from '@/components/ComparisonMetric.vue'
import { comparisonMetric, bothBeyondRadius, type ComparisonRow } from '@/utils/comparisonPresentation'
import { comparisonDifferences, type SideKey } from '@/utils/comparison'
import { comparisonRowId } from '@/utils/comparisonFacts'
import { mappedNearestId } from '@/utils/mapAnalysis'
import type { MapLayerKey } from '@/types/mapLayers'
import { isBeyondRadius } from '@/utils/profilePresentation'
import type { ComparisonSide } from '@/composables/useAddressComparison'
const props = defineProps<{ row: ComparisonRow; sides: Record<SideKey, ComparisonSide>; radius: number; selectedObjects?: Record<SideKey, { layer: MapLayerKey; id: string } | null>; selectedStops?: Record<SideKey, number | null> }>()
defineEmits<{ retry: [side: SideKey]; showMap: [side: SideKey] }>()
const root = ref<HTMLElement | null>(null)
watch(() => [props.selectedObjects, props.selectedStops], async () => { await nextTick(); if (keys.some(selected)) { const details = root.value?.querySelector<HTMLDetailsElement>(':scope > details'); if (details) details.open = true } }, { deep: true })
const keys: SideKey[] = ['left', 'right']
const names = { left: 'А', right: 'Б' }
const data = (key: SideKey) => props.sides[key].profile?.blocks[props.row.category].data
const metric = (key: SideKey) => comparisonMetric(props.sides[key].profile, props.row)
const notes = computed(() => comparisonDifferences(metric('left'), metric('right'), data('left')?.coverage, data('right')?.coverage))
const far = computed(() => props.row.key.includes('distance') && bothBeyondRadius(metric('left'), metric('right'), data('left')?.coverage, data('right')?.coverage, props.radius))
function nearestName(key: SideKey) {
    const profile = props.sides[key].profile
    return props.row.category === 'transport' ? profile?.blocks.transport.data?.nearest_stop?.name : profile?.blocks[props.row.category].data?.nearest?.name
}
function selected(key: SideKey) {
    return props.row.category === 'transport' ? props.selectedStops?.[key] != null && props.selectedStops[key] === props.sides[key].profile?.blocks.transport.data?.nearest_stop?.id : props.selectedObjects?.[key]?.layer === props.row.category && props.selectedObjects[key]?.id === mappedNearestId(props.sides[key].profile, props.row.category)
}
function access(key: SideKey) { return props.row.category === 'transport' ? null : props.sides[key].profile?.blocks[props.row.category].data?.nearest?.access }
</script>
<template>
    <div :id="comparisonRowId(row)" tabindex="-1" ref="root" class="comparison-row" :class="{ 'comparison-row--far': far }" role="group" :aria-label="row.label">
        <component :is="far ? 'details' : 'div'">
            <summary v-if="far">{{ row.label }} — у обоих за кругом {{ radius }} м</summary>
            <h3 v-else tabindex="-1">{{ row.label }}</h3>
            <div class="comparison-row-values">
                <div v-for="key in keys" :key="key">
                    <ComparisonMetric v-if="metric(key)" compact :side="names[key]" :label="row.label" :metric="metric(key)!" :nearest-name="row.key.includes('distance') ? nearestName(key) : null" :access="row.key.includes('distance') ? access(key) : null" :coverage="data(key)?.coverage" :beyond="row.key.includes('distance') && isBeyondRadius(metric(key), data(key)?.coverage, radius)" />
                    <div v-else class="comparison-metric-empty" :aria-label="`${row.label}, вариант ${names[key]}`"><strong>{{ names[key] }}</strong><p>{{ sides[key].profile?.blocks[row.category].message ?? (sides[key].status === 'loading' ? 'Загрузка…' : 'Профиль не загружен') }}</p><button v-if="sides[key].profile?.blocks[row.category].status === 'ERROR'" type="button" class="profile-action" @click="$emit('retry', key)">Повторить расчёт {{ names[key] }}</button></div>
                    <p v-if="row.key.includes('distance') && data(key) && (row.category === 'transport' ? !sides[key].profile?.map?.stops_in_radius?.some(stop => stop.id === sides[key].profile?.blocks.transport.data?.nearest_stop?.id) : !mappedNearestId(sides[key].profile, row.category))" class="address-note">Геометрии именно ближайшего объекта в ответе нет. На карте — только слой категории.</p>
                    <button v-if="row.key.includes('distance') && data(key)" type="button" class="profile-action comparison-row-map" :aria-pressed="selected(key)" :aria-label="`${row.label}: на карте ${names[key]}`" @click="$emit('showMap', key)">На карте {{ names[key] }}</button>
                </div>
            </div>
            <ul v-if="notes.length" class="comparison-differences" aria-label="Различия условий сравнения"><li v-for="note in notes" :key="note">{{ note }}</li></ul>
        </component>
    </div>
</template>
<style scoped>
.comparison-row:focus { outline: 3px solid #2d6450; outline-offset: 2px; }
.comparison-row { padding: 12px 0; border-bottom: 1px solid #e0e7dc; }
h3, summary { font-size: 13px; font-weight: 550; line-height: 1.5; }
summary { cursor: pointer; padding-block: 6px; color: #526458; }
.comparison-row-values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 8px; }
.comparison-row-values > div { min-width: 0; overflow-wrap: anywhere; }
.comparison-metric-empty { font-size: 12px; color: #705629; }
.comparison-differences { padding: 6px 8px; margin-top: 8px; background: #f6efdf; border-radius: 6px; color: #705629; font-size: 11px; line-height: 1.5; }
.comparison-row-map { margin-top: 4px; font-size: 11px; }
</style>
