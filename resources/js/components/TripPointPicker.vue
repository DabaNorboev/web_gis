<script setup lang="ts">
import { computed } from 'vue'
import AddressSearch from '@/components/AddressSearch.vue'
import { useAddressChoice } from '@/composables/useAddressChoice'
import { usePointAddress } from '@/composables/usePointAddress'
import type { Coordinates } from '@/types/transport'
const props = defineProps<{ point: Coordinates | null; label: string }>()
const emit = defineEmits<{ select: [point: Coordinates]; edit: [] }>()
const { matches, pending, selected: object, chooseGroup, chooseObject, clear } = useAddressChoice(id => {
    const value = pending.value?.objects.find(item => item.id === id)
    if (value) emit('select', { lon: value.lon, lat: value.lat })
})
const { result, status, selected, selectedId, choose, retry } = usePointAddress(() => props.point)
const signature = computed(() => `${props.point?.lon}|${props.point?.lat}`)
</script>
<template>
    <section class="trip-point-picker" :aria-label="`Поиск и подпись: ${label}`" @input="emit('edit')">
        <AddressSearch :reset-key="0" @select="chooseGroup" @results="matches = $event" @edit="clear" />
        <div v-if="pending && pending.objects.length > 1" class="trip-address-objects">
            <p>{{ pending.label }}: выберите адресный объект. Это не выбор дороги.</p>
            <button v-for="(item, index) in pending.objects" :key="item.id" type="button" :aria-pressed="object?.id === item.id" @click="chooseObject(item.id)">Объект {{ index + 1 }} · {{ item.object_type === 'building' ? 'Здание' : item.object_type === 'address_point' ? 'Адресная точка' : 'Территория' }}</button>
        </div>
        <div v-if="point" :key="signature" class="trip-point-label" :aria-busy="status === 'loading'">
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
.trip-point-picker{min-width:0;font-size:13px;margin:10px 0}.trip-point-label{padding:10px 0}.trip-point-label p{margin:4px 0;overflow-wrap:anywhere}.trip-picker-hint,details{font-size:12px;color:#607366}summary{cursor:pointer;min-height:32px}.trip-address-objects button{display:block;text-align:left;width:100%;min-height:44px;padding:8px;border:1px solid #bfcebd;border-radius:8px;margin-top:6px;background:white}.trip-point-label fieldset{min-width:0;margin:8px 0}.trip-point-label label{display:flex;align-items:start;gap:8px;padding:8px;overflow-wrap:anywhere}.trip-point-label input{margin-top:3px}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #2d6450;outline-offset:2px}
</style>
