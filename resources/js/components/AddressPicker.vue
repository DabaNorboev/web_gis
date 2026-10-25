<script setup lang="ts">
import { ref, watch, useId } from 'vue'
import AddressSearch from '@/components/AddressSearch.vue'
import CityMap from '@/components/map/CityMap.vue'
import { useAddressChoice } from '@/composables/useAddressChoice'
import type { AddressMapState } from '@/utils/addressMap'
const props = defineProps<{ selectedId: string | null; externalMap?: boolean; resetKey?: number }>()
const emit = defineEmits<{ select: [id: string]; mapState: [state: AddressMapState] }>()
const { matches, pending, selected, highlightedId, highlightedGroupId, groups, mapState, clear, chooseGroup, chooseObject } = useAddressChoice(id => emit('select', id))
const searchResetKey = ref(0)
const choicesId = `address-choice-${useId()}`
watch(() => [props.selectedId, props.resetKey], reset)
watch(mapState, state => emit('mapState', state), { immediate: true })
function reset() { clear(); searchResetKey.value++ }
function selectObjectById(id: string) {
    chooseObject(id)
}
function highlightObjectById(id: string | null) {
    highlightedId.value = id && groups.value.some(group => group.objects.some(object => object.id === id)) ? id : null
}
function move(index: number, direction: number) {
    const objects = pending.value?.objects ?? []
    const object = objects[(index + direction + objects.length) % objects.length]
    if (object) document.getElementById(`${choicesId}-${object.id}`)?.focus()
}
defineExpose({ selectObjectById, highlightObjectById, reset })
</script>
<template>
    <AddressSearch :reset-key="searchResetKey" @select="chooseGroup" @results="matches = $event" @highlight="highlightedGroupId = $event" @edit="clear" />
    <div v-if="pending" class="mt-3 rounded-xl border bg-white p-3 text-sm">
        <p class="font-medium">{{ pending.label }}</p>
        <p class="mt-2 text-xs leading-5 text-[#637769]">Нажмите на объект в списке или на карте, чтобы выбрать его. С клавиатуры — Enter. Контур не обозначает вход; варианты не являются номерами подъездов.</p>
        <ul class="mt-2 max-h-56 space-y-2 overflow-y-auto" aria-label="Объекты выбранного адреса">
            <li v-for="(object, index) in pending.objects" :key="object.id">
                <button :id="`${choicesId}-${object.id}`" type="button" class="address-choice-button w-full rounded border p-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-[#2d6450]" :class="{ 'is-selected': selected?.id === object.id, 'is-highlighted': highlightedId === object.id }" :data-address-id="object.id" :data-object-number="index + 1" :aria-pressed="selected?.id === object.id" @click="chooseObject(object.id)" @pointerenter="$event.pointerType !== 'touch' && (highlightedId = object.id)" @pointerleave="highlightedId = null" @focus="highlightedId = object.id" @blur="highlightedId = null" @keydown.down.prevent="move(index, 1)" @keydown.up.prevent="move(index, -1)" @keydown.esc.prevent="highlightedId = null">
                    <span class="address-choice-number" aria-hidden="true">{{ index + 1 }}</span>Объект {{ index + 1 }} · {{ object.object_type === 'address_point' ? 'Адресная точка' : object.object_type === 'building' ? 'Здание' : 'Территория' }}<span v-if="object.levels"> · Этажность: {{ object.levels }}</span>
                    <span class="block text-[#637769]">{{ object.lat.toFixed(5) }}, {{ object.lon.toFixed(5) }} · {{ object.id }}</span>
                    <span v-if="selected?.id === object.id" class="block font-semibold text-[#2d6450]">Выбран этот объект</span>
                </button>
            </li>
        </ul>
        <p class="mt-3 text-xs leading-5" role="status">{{ selected ? `Выбран объект ${selected.id}. ${selected.point_method === 'point_on_surface' ? 'Точка внутри контура — не вход в здание.' : 'Адресная точка OSM; вход не подтверждён.'}` : 'Объект пока не выбран.' }}</p>
        <button type="button" class="result-action mt-3" @click="reset">Отменить выбор</button>
    </div>
    <div v-if="groups.length && !externalMap" class="relative mt-3 h-72 overflow-hidden rounded-xl border" aria-label="Карта вариантов адреса">
        <CityMap :point="null" :address-group="null" :address-groups="groups" :selected-address-id="selected?.id ?? null" :highlighted-address-id="highlightedId" :highlighted-group-id="highlightedGroupId" :analysis="null" :radius="500" :selected-stop-id="null" :selectable="false" @select-address-object="selectObjectById" @highlight-address-object="highlightObjectById" />
    </div>
</template>
