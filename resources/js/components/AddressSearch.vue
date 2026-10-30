<script setup lang="ts">
import { ref, watch, useId } from 'vue'
import { Search, X, ArrowRight } from '@lucide/vue'
import { useAddressSearch } from '@/composables/useAddressSearch'
import type { AddressResult } from '@/types/address'

const props = defineProps<{ resetKey: number }>()
const emit = defineEmits<{ select: [address: AddressResult]; results: [addresses: AddressResult[]]; highlight: [groupId: string | null]; edit: [] }>()
const { query, results, meta, status, open, activeIndex, search, choose, clear, close } = useAddressSearch()
const input = ref<HTMLInputElement | null>(null)
const searchId = `address-${useId()}`
watch(() => props.resetKey, clear)
watch(results, value => emit('results', value), { flush: 'sync' })
watch([activeIndex, open], () => emit('highlight', open.value ? results.value[activeIndex.value]?.id ?? null : null))

function select(result: AddressResult) {
    choose(result)
    emit('select', result)
    input.value?.focus()
}
function move(direction: number) {
    if (!open.value) { void search(); return }
    if (!results.value.length) return
    activeIndex.value = activeIndex.value < 0 ? (direction > 0 ? 0 : results.value.length - 1) : (activeIndex.value + direction + results.value.length) % results.value.length
    document.getElementById(`${searchId}-option-${activeIndex.value}`)?.scrollIntoView({ block: 'nearest' })
}
function submit() {
    const result = open.value ? results.value[activeIndex.value] : undefined
    if (result) select(result)
    else void search()
}
function blur(event: FocusEvent) {
    // Changing presentation must not cancel a search already in flight.
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-interface-switch]')) return
    if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) close()
}
</script>

<template>
    <div class="search-area" @focusout="blur">
        <p class="search-availability">Адреса из локального набора OpenStreetMap</p>
        <form class="search-box" role="search" @submit.prevent="submit">
            <Search class="size-5 shrink-0 text-[#708079]" aria-hidden="true" />
            <label :for="searchId" class="sr-only">Адрес в Красноярске</label>
            <input
                :id="searchId" ref="input" v-model="query" type="text" role="combobox" autocomplete="off" maxlength="160"
                placeholder="Например, Ленина, 102" aria-autocomplete="list" :aria-controls="`${searchId}-options`" :aria-expanded="open && results.length > 0"
                :aria-activedescendant="open && activeIndex >= 0 ? `${searchId}-option-${activeIndex}` : undefined"
                :aria-describedby="`${searchId}-note`" class="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-[#819087]"
                @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.esc.prevent="close"
                @input="emit('edit')"
            />
            <button v-if="query" type="button" class="search-clear" aria-label="Очистить адрес" @click="clear(); emit('edit'); input?.focus()">
                <X class="size-4" aria-hidden="true" />
            </button>
            <button type="submit" class="search-submit" aria-label="Поиск адреса">
                <ArrowRight class="size-5" aria-hidden="true" />
            </button>
        </form>
        <ul v-if="open && results.length" :id="`${searchId}-options`" role="listbox" aria-label="Найденные адреса" class="mt-2 max-h-72 overflow-y-auto rounded-xl border border-[#dce4d9] bg-white p-1">
            <li v-for="(result, index) in results" :id="`${searchId}-option-${index}`" :key="result.id" role="option" :aria-selected="activeIndex === index" class="cursor-pointer rounded-lg p-3 text-sm" :class="activeIndex === index ? 'bg-[#eaf2df]' : 'hover:bg-[#f1f4ed]'" @pointerenter="$event.pointerType !== 'touch' && (activeIndex = index)" @pointerleave="activeIndex = -1" @pointerdown.prevent @click="select(result)">
                <span class="block font-medium">{{ result.label }}</span>
                <span v-if="result.match_type === 'approximate'" class="block text-xs text-[#8b6427]">Похожий адрес — проверьте название</span>
                <span class="text-xs text-[#637769]">{{ result.object_count === 1 ? 'Один объект на карте' : `Объектов на карте: ${result.object_count}. Выберите нужный.` }}</span>
            </li>
        </ul>
        <p :id="`${searchId}-note`" class="search-note" role="status" aria-live="polite">
            <template v-if="open && status === 'loading'">Ищем адреса…</template>
            <template v-else-if="open && status === 'error'">Не удалось загрузить адреса. <button type="button" class="result-action" @click="search">Повторить</button></template>
            <template v-else-if="open && status === 'ready' && meta?.quality.availability === 'UNAVAILABLE'">Набор адресов пока недоступен.</template>
            <template v-else-if="open && status === 'ready' && !results.length">Адрес не найден в наборе. Уточните улицу и номер дома.</template>
            <template v-else-if="open && results.length">Выберите подходящий адрес из списка. Полнота данных OSM не гарантируется.<span v-if="meta?.unknown_locality_allowed" class="block">В выдаче возможны объекты без указанного населённого пункта. Их принадлежность Красноярску не подтверждена.</span></template>
            <template v-else-if="query.trim().length > 0 && query.trim().length < 3">Введите минимум 3 символа.</template>
        </p>
    </div>
</template>
