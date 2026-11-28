<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useAddressSearch } from '@/composables/useAddressSearch'
import { localAddressLabel, localAddressType } from '@/utils/addressLabels'
import { resolveAddress } from '@/api/searchProfiles'
import type { AddressSearchPreview } from '@/utils/addressMap'
import type { AddressResult } from '@/types/address'
import type { AnalysisAddress } from '@/types/placeAnalysis'

const props = defineProps<{ query: string; enabled: boolean }>()
const emit = defineEmits<{ 'update:query': [string]; selected: [AnalysisAddress]; pickPoint: [] }>()
const query = ref(props.query)
watch(() => props.query, value => { query.value = value }, { flush: 'sync' })
watch(query, value => emit('update:query', value), { flush: 'sync' })
const search = useAddressSearch(query, () => props.enabled)
const { results, meta, status, open, activeIndex } = search
const empty = computed(() => status.value === 'ready' && !results.value.length)
const unavailable = computed(() => meta.value?.quality.availability === 'UNAVAILABLE')
const groups = computed(() => {
    let index = 0
    return results.value.map(result => {
        const addresses = result.objects.map(object => localAddressLabel(result.label, object.display))
        const commonAddress = addresses.length > 1 && addresses.every(address => address === addresses[0]) ? addresses[0] : null
        return {
            result,
            title: commonAddress ?? result.label,
            options: result.objects.map((object, position) => {
                const address = addresses[position]!
                const number = position + 1
                const type = addresses.length > 1 ? `${localAddressType[object.object_type]} ${number}` : null
                const label = type ? `${address} · ${type}` : address
                return {
                    id: object.id, result, index: index++, number, label, text: commonAddress ? type! : label,
                    detail: type ? null : localAddressType[object.object_type],
                }
            }),
        }
    })
})
const options = computed(() => groups.value.flatMap(group => group.options))
const previewGroup = shallowRef<AddressResult | null>(null)
const listHover = ref<number | null>(null)
const mapHover = ref<string | null>(null)
const mapFocus = ref<string | null>(null)
const highlighted = computed(() => listHover.value !== null ? options.value[listHover.value]
    : options.value.find(option => option.result === previewGroup.value && option.id === (mapHover.value ?? mapFocus.value))
        ?? options.value[activeIndex.value])
const preview = computed<AddressSearchPreview | null>(() => {
    if (!props.enabled || !open.value) return null
    const group = groups.value.find(item => item.result === previewGroup.value) ?? groups.value[0]
    if (!group) return null
    return {
        groups: [group.result], selectedId: null, highlightedId: highlighted.value?.id ?? null, highlightedGroupId: null,
        labels: new Map(group.options.map(option => [option.id, option.label])),
    }
})
const queryInput = ref<HTMLInputElement | null>(null)
watch(results, value => {
    activeIndex.value = -1
    listHover.value = mapHover.value = mapFocus.value = null
    previewGroup.value = value[0] ?? null
}, { flush: 'sync' })
watch(highlighted, option => {
    if (option && previewGroup.value !== option.result) {
        previewGroup.value = option.result
        mapHover.value = mapFocus.value = null
    }
})
const pending = ref(false), error = ref(false)
let epoch = 0, controller: AbortController | null = null
function reset() { epoch++; controller?.abort(); pending.value = false; error.value = false }
watch(() => props.enabled, reset, { flush: 'sync' })
watch(query, reset, { flush: 'sync' })
onBeforeUnmount(reset)
async function choose(id: string) {
    if (pending.value || !props.enabled || !open.value || !options.value.some(option => option.id === id)) return
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
function clearDraft() { reset(); search.resetDraft() }
function submit() { clearDraft(); void search.search() }
function highlightFromMap(id: string | null, source: 'pointer' | 'focus') {
    if (source === 'focus' && id !== null) {
        listHover.value = null
        mapHover.value = null
    }
    const highlight = source === 'pointer' ? mapHover : mapFocus
    highlight.value = id
}
function focusOption(index: number) {
    listHover.value = null
    mapHover.value = null
    activeIndex.value = index
}
function leaveList(event: FocusEvent) {
    if (!(event.relatedTarget instanceof Node) || !(event.currentTarget as HTMLElement).contains(event.relatedTarget)) {
        activeIndex.value = -1
    }
}
defineExpose({ clearDraft, preview, highlightFromMap, choose })
function key(event: KeyboardEvent) {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); open.value = true
        const count = options.value.length
        if (!count) return
        focusOption(event.key === 'ArrowDown' ? (activeIndex.value + 1) % count
            : activeIndex.value <= 0 ? count - 1 : activeIndex.value - 1)
        void nextTick(() => document.getElementById(`pa-local-${activeIndex.value}`)?.scrollIntoView({ block: 'nearest' }))
    }
    if (event.key === 'Enter') {
        event.preventDefault()
        const option = options.value[activeIndex.value]
        if (open.value && option) void choose(option.id)
        else submit()
    }
}
</script>
<template>
    <div v-show="enabled" class="pa-geocoding">
        <form class="pa-search" role="search" @submit.prevent="submit" @focusout="leaveList" @keydown.esc.prevent="clearDraft">
            <input id="pa-local-query" ref="queryInput" v-model="query" class="pa-search__input" type="search" maxlength="160" role="combobox" aria-label="Поиск адреса" aria-autocomplete="list" aria-controls="pa-local-options" :aria-expanded="open && !!options.length" :aria-activedescendant="open && activeIndex >= 0 ? `pa-local-${activeIndex}` : undefined" placeholder="Поиск адреса в Красноярске" @keydown="key" @focus="open = true">
            <button v-if="query" class="pa-search__clear" type="button" aria-label="Очистить поиск" @click="query = ''; clearDraft()">×</button>
            <div v-if="open && options.length" id="pa-local-options" class="pa-suggestions" role="listbox" aria-label="Локальные адреса">
                <div v-for="group in groups" :key="group.result.id" class="pa-address-group" role="group" :aria-label="group.title">
                    <p v-if="group.options.length > 1 || group.result.match_type === 'approximate'" class="pa-address-group__title">
                        <strong v-if="group.options.length > 1">{{ group.title }}</strong>
                        <small v-if="group.result.match_type === 'approximate'">Приблизительное совпадение</small>
                    </p>
                    <div v-for="option in group.options" :key="option.id" :id="`pa-local-${option.index}`" role="option" :aria-label="option.label" :aria-selected="activeIndex === option.index">
                        <button class="pa-suggestion" :class="{ 'is-active': highlighted === option }" type="button" :aria-label="option.label" :aria-disabled="pending"
                            @pointermove="listHover = option.index" @pointerleave="listHover = null" @focus="focusOption(option.index)" @click="choose(option.id)">
                            <span v-if="group.options.length > 1" class="pa-address-number" aria-hidden="true">{{ option.number }}</span>
                            <span class="pa-suggestion__body">
                                <strong v-if="group.options.length === 1">{{ option.text }}</strong>
                                <span v-else>{{ option.text }}</span>
                                <small v-if="option.detail">{{ option.detail }}</small>
                            </span>
                        </button>
                    </div>
                </div>
            </div>
        </form>
        <p v-if="status === 'loading' || pending" class="pa-note" role="status">{{ pending ? 'Получаем адрес…' : 'Поиск…' }}</p>
        <div v-else-if="empty || status === 'error' || error" class="pa-search-feedback">
            <p class="pa-note" role="status">
                {{ empty ? (unavailable ? 'Локальный поиск недоступен.' : 'Адреса не найдены.')
                    : error ? 'Не удалось получить адрес.' : 'Не удалось выполнить поиск.' }}
            </p>
            <p v-if="empty && !unavailable" class="pa-note">Проверьте название улицы и номер дома.</p>
            <div class="pa-search-feedback__actions">
                <button v-if="empty && !unavailable" class="pa-outline" type="button" @click="queryInput?.focus()">Уточнить адрес</button>
                <button v-if="status === 'error'" class="pa-outline" type="button" @click="queryInput?.focus(); submit()">Повторить поиск</button>
                <button class="pa-outline" type="button" @click="emit('pickPoint')">Выбрать точку</button>
            </div>
        </div>
    </div>
</template>
