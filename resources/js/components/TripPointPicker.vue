<script setup lang="ts">
import { computed, watch, useId, onBeforeUnmount } from 'vue'
import type { AddressMapState } from '@/utils/addressMap'
import AddressSearch from '@/components/AddressSearch.vue'
import { useAddressChoice } from '@/composables/useAddressChoice'
import { usePointAddress } from '@/composables/usePointAddress'
import type { Coordinates } from '@/types/transport'
const props = defineProps<{ point: Coordinates | null; label: string; compact?: boolean; previewActive?: boolean }>()
const emit = defineEmits<{ select: [point: Coordinates]; edit: []; addressLabel: [label: string, point: Coordinates]; mapState: [state: AddressMapState, actions: { select: (id: string) => void; highlight: (id: string | null) => void }] }>()
const { matches, pending, selected: object, highlightedId, highlightedGroupId, groups, mapState, chooseGroup, chooseObject, clear } = useAddressChoice(id => {
    const value = pending.value?.objects.find(item => item.id === id)
    if (value) {
        const point = { lon: value.lon, lat: value.lat }
        emit('select', point)
        emit('addressLabel', pending.value!.label, point)
    }
})
const choicesId = `trip-choice-${useId()}`
let alive = true
onBeforeUnmount(() => { alive = false })
function highlight(id: string | null) { highlightedId.value = id && groups.value.some(group => group.objects.some(item => item.id === id)) ? id : null }
watch([mapState, () => props.previewActive], ([state]) => {
    if (!props.previewActive) return
    const current = () => alive && props.previewActive && mapState.value === state
    emit('mapState', state, {
        select: id => { if (current()) chooseObject(id) },
        highlight: id => { if (current()) highlight(id) },
    })
}, { flush: 'post' })
function move(index: number, direction: number) {
    const objects = pending.value?.objects ?? []
    const item = objects[(index + direction + objects.length) % objects.length]
    if (item) document.getElementById(`${choicesId}-${item.id}`)?.focus()
}
const { result, status, selected, selectedId, choose, retry } = usePointAddress(() => props.point)
const confirmed = computed(() => object.value && props.point?.lon === object.value.lon && props.point?.lat === object.value.lat ? object.value : null)
const signature = computed(() => `${props.point?.lon}|${props.point?.lat}`)
</script>
<template>
    <section class="trip-point-picker" :class="{ 'trip-point-picker--compact': compact }" :aria-label="`Поиск и подпись: ${label}`">
        <p v-if="compact" class="trip-address-heading">Адрес цели</p>
        <AddressSearch hide-source :reset-key="0" @select="chooseGroup" @results="matches = $event" @highlight="highlightedGroupId = $event" @edit="clear(); emit('edit')" />
        <component :is="compact && confirmed ? 'details' : 'div'" v-if="pending && pending.objects.length > 1" class="trip-address-objects">
            <summary v-if="compact && confirmed">Изменить адресный объект</summary>
            <p role="status">{{ pending.label }}: выберите адресный объект. Это не выбор дороги.</p>
            <button v-for="(item, index) in pending.objects" :key="item.id" :id="`${choicesId}-${item.id}`" :data-address-id="item.id" :class="{ 'is-highlighted': highlightedId === item.id }" @pointerenter="$event.pointerType !== 'touch' && highlight(item.id)" @pointerleave="highlight(null)" @focus="highlight(item.id)" @blur="highlight(null)" @keydown.down.prevent="move(index, 1)" @keydown.up.prevent="move(index, -1)" @keydown.esc.prevent="highlight(null)" type="button" :aria-pressed="object?.id === item.id" @click="chooseObject(item.id)">Объект {{ index + 1 }} · {{ item.object_type === 'building' ? 'Здание' : item.object_type === 'address_point' ? 'Адресная точка' : 'Территория' }}</button>
        </component>
        <p v-if="compact && confirmed" class="trip-confirmed" role="status"><strong>{{ pending?.label }}</strong><br />Адрес выбран · {{ confirmed.object_type === 'building' ? 'здание' : 'адресный объект' }} {{ pending && pending.objects.length > 1 ? pending.objects.findIndex(item => item.id === confirmed?.id) + 1 : '' }}</p>
        <p v-else-if="compact && pending" role="status">Адрес не выбран. Выберите конкретный объект.</p>
        <p v-if="compact && point && !confirmed"><strong>Точка на карте</strong><span v-if="selected"> · {{ selected.label }}</span></p>
        <div v-if="point && !compact" :key="signature" class="trip-point-label" :aria-busy="status === 'loading'">
            <p role="status" aria-live="polite"><strong>{{ selected ? `${result?.data.match === 'NEARBY' ? 'Рядом с ' : ''}${selected.label}` : 'Точка на карте' }}</strong></p>
            <p v-if="status === 'loading'" role="status">Определяем подпись…</p>
            <p v-else-if="status === 'error'">Подпись недоступна. Точка сохранена. <button type="button" @click="retry">Повторить подпись</button></p>
            <fieldset v-if="result?.data.requires_choice"><legend>Адресная подпись — координаты сохранятся</legend>
                <label v-for="candidate in result.data.candidates" :key="candidate.id"><input type="radio" :name="`trip-label-${label}`" :checked="selectedId === candidate.id" @change="choose(candidate.id)" />{{ candidate.label }} · {{ candidate.object_type === 'building' ? 'здание' : 'адресный объект' }} · {{ candidate.id }}</label>
            </fieldset>
            <p v-if="selected && result?.data.match === 'NEARBY'">До адресного объекта {{ Math.round(selected.distance_m) }} м по прямой.</p>
            <p class="trip-picker-hint">Подпись не переносит точку и не подтверждает вход или въезд.</p>
            <details v-if="result"><summary>О подписи</summary><p>{{ result.meta.source }} · снимок {{ result.meta.dataset_import_id ?? 'нет' }}. Дата наблюдения: {{ result.meta.observed_at ?? 'неизвестна' }}. Актуальность: {{ result.meta.quality.freshness === 'UNKNOWN' ? 'неизвестна' : result.meta.quality.freshness }}. {{ result.meta.quality.reason }} {{ result.meta.coverage.reason }} Адресный поиск в пределах 100 м не является проверкой пешего или автомобильного доступа.</p></details>
        </div>
    </section>
</template>
<style scoped>
.trip-address-objects button.is-highlighted{outline:2px solid #7058a5;background:#f4f1f8}
.trip-address-heading{font-weight:500}
.trip-confirmed{padding:8px 10px;background:#f4f1f8;border-radius:7px;color:#594779}
.trip-point-picker--compact :deep(.search-availability){display:none}
.trip-point-picker--compact :deep(.search-box){border-color:#dfe1dd;border-radius:7px;box-shadow:none;background:#fff;gap:5px;padding:4px 5px;height:44px}
.trip-point-picker--compact :deep(.search-box input){border:0;padding:0;border-radius:0;min-height:32px;width:0}
.trip-point-picker--compact :deep(.search-submit){background:#7058a5;color:white;border:0;padding:4px;min-height:32px;width:32px;height:32px;margin:0}
.trip-point-picker--compact :deep(.search-clear){border:0;padding:4px;min-height:32px;width:24px;height:32px;margin:0}
.trip-point-picker--compact :deep(.search-box svg){width:16px;height:16px;flex-shrink:0}
.trip-point-picker--compact .trip-point-label{padding:0;margin:4px 0}
.trip-point-picker--compact .trip-point-label>summary{padding-block:4px;min-height:32px}
.trip-point-picker--compact :deep(.search-box input){font-size:13px}
@media(max-width:767px){.trip-point-picker--compact :deep(.search-box){height:50px}
.trip-point-picker--compact :deep(.search-submit),.trip-point-picker--compact :deep(.search-clear){width:44px;height:44px;min-height:44px}}
.trip-point-picker{min-width:0;font-size:13px;margin:10px 0}
.trip-point-label{padding:10px 0}
.trip-point-label p{margin:4px 0;overflow-wrap:anywhere}
.trip-picker-hint,details{font-size:12px;color:#607366}summary{cursor:pointer;min-height:32px}
.trip-address-objects button{display:block;text-align:left;width:100%;min-height:44px;padding:8px;border:1px solid #bfcebd;border-radius:8px;margin-top:6px;background:white}
.trip-point-label fieldset{min-width:0;margin:8px 0}
.trip-point-label label{display:flex;align-items:start;gap:8px;padding:8px;overflow-wrap:anywhere}
.trip-point-label input{margin-top:3px}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #2d6450;outline-offset:2px}
</style>
