<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useAddressSearch } from '@/composables/useAddressSearch'
import { distinguishAddressLabels, localAddressLabel } from '@/utils/addressLabels'
import { resolveAddress } from '@/api/searchProfiles'
import type { AnalysisAddress } from '@/types/placeAnalysis'

const props = defineProps<{ query: string; enabled: boolean }>()
const emit = defineEmits<{ 'update:query': [string]; selected: [AnalysisAddress] }>()
const query = ref(props.query)
watch(() => props.query, value => { query.value = value }, { flush: 'sync' })
watch(query, value => emit('update:query', value), { flush: 'sync' })
const search = useAddressSearch(query, () => props.enabled)
const { results, meta, status, open, activeIndex } = search
const options = computed(() => results.value.flatMap(result => result.objects.map(object => ({
    key: `${result.id}:${object.id}`,
    id: object.id,
    label: localAddressLabel(result.label, object.display),
}))))
const labels = computed(() => distinguishAddressLabels(options.value.map(option => option.label), 'Объект'))
const queryInput = ref<HTMLInputElement | null>(null)
watch(results, () => { activeIndex.value = -1 })
const pending = ref(false), error = ref(false)
let epoch = 0, controller: AbortController | null = null
function reset() { epoch++; controller?.abort(); pending.value = false; error.value = false }
watch(() => props.enabled, reset, { flush: 'sync' })
watch(query, reset, { flush: 'sync' })
onBeforeUnmount(reset)
async function choose(id: string) {
    if (pending.value || !props.enabled) return
    reset()
    const current = epoch, request = new AbortController()
    controller = request; pending.value = true
    const timer = setTimeout(() => { request.abort(); if (current === epoch) { reset(); error.value = true } }, 10000)
    try {
        const resolved = await resolveAddress(id, request.signal)
        if (current !== epoch) return
        queryInput.value?.focus()
        search.resetDraft()
        emit('selected', resolved.address)
    } catch { if (current === epoch) error.value = true }
    finally { clearTimeout(timer); if (current === epoch) pending.value = false }
}
defineExpose({ clearDraft: () => { reset(); search.resetDraft() } })
function key(event: KeyboardEvent) {
    if (event.key === 'Escape') { reset(); search.resetDraft() }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); open.value = true
        const count = options.value.length
        if (!count) return
        activeIndex.value = event.key === 'ArrowDown' ? (activeIndex.value + 1) % count
            : activeIndex.value <= 0 ? count - 1 : activeIndex.value - 1
        void nextTick(() => document.getElementById(`pa-local-${activeIndex.value}`)?.scrollIntoView({ block: 'nearest' }))
    }
    if (event.key === 'Enter') {
        event.preventDefault()
        const option = options.value[activeIndex.value]
        if (open.value && option) void choose(option.id)
        else void search.search()
    }
}
</script>
<template>
    <div v-show="enabled" class="pa-geocoding">
        <label class="pa-note" for="pa-local-query">Локальный поиск OpenStreetMap</label>
        <form class="pa-search" role="search" @submit.prevent="search.search()">
            <input id="pa-local-query" ref="queryInput" v-model="query" class="pa-search__input" type="search" maxlength="160" role="combobox" aria-label="Поиск адреса" aria-autocomplete="list" aria-controls="pa-local-options" :aria-expanded="open && !!options.length" :aria-activedescendant="open && activeIndex >= 0 ? `pa-local-${activeIndex}` : undefined" placeholder="Поиск адреса в Красноярске" @keydown="key" @focus="open = true">
            <button v-if="query" class="pa-search__clear" type="button" aria-label="Очистить поиск" @click="query = ''; search.resetDraft()">×</button>
            <div v-if="open && options.length" id="pa-local-options" class="pa-suggestions" role="listbox" aria-label="Локальные адреса">
                <div v-for="(option, i) in options" :key="option.key" :id="`pa-local-${i}`" role="option" :aria-label="labels[i]" :aria-selected="activeIndex === i">
                    <button class="pa-suggestion" :class="{ 'is-active': activeIndex === i }" type="button" :disabled="pending" @focus="activeIndex = i" @click="choose(option.id)">{{ labels[i] }}</button>
                </div>
            </div>
        </form>
        <p v-if="status === 'loading' || pending" class="pa-note" role="status">Поиск…</p>
        <p v-if="status === 'ready' && !results.length" class="pa-note" role="status">
            {{ meta?.quality.availability === 'UNAVAILABLE' ? 'Локальный поиск недоступен. Можно выбрать точку на карте.' : 'Адреса не найдены.' }}
        </p>
        <p v-if="status === 'error' || error" class="pa-note" role="status">Не удалось получить адрес. Можно выбрать точку на карте.</p>
        <a class="pa-note" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>
    </div>
</template>
