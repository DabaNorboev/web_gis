<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { distinguishAddressLabels, geocodingAddressLabel } from '@/utils/addressLabels'
import { useGeocoding } from '@/composables/useGeocoding'
import type { AnalysisPoint } from '@/types/placeAnalysis'
import type { GeocodingCandidate, GeocodingSelection } from '@/types/geocoding'
const props = defineProps<{ point: AnalysisPoint | null; selectionError?: string | null; enabled?: boolean; query?: string }>()
const emit = defineEmits<{ selected: [GeocodingSelection]; preview: [AnalysisPoint | null, boolean]; point: [AnalysisPoint]; retired: []; authorizationExpired: [boolean]; 'update:query': [string] }>()
const query = ref(props.query ?? '')
watch(() => props.query, value => { query.value = value ?? '' }, { flush: 'sync' })
watch(query, value => emit('update:query', value), { flush: 'sync' })
const geo = useGeocoding(v => emit('selected', v), (p, street = false) => emit('preview', p, street), query, () => props.enabled !== false)
const { phase, message, preview, selection, expired, absoluteExpired, waitSeconds, canRetry, confirming } = geo
const opened = ref(false), active = ref(-1), confirmButton = ref<HTMLButtonElement | null>(null), pointButton = ref<HTMLButtonElement | null>(null), queryInput = ref<HTMLInputElement | null>(null)
const candidates = computed(() => geo.lookup.value?.candidates ?? [])
const hasActiveCandidate = computed(() => opened.value && !!candidates.value[active.value])
watch(geo.lookup, () => { active.value = -1 }, { flush: 'sync' })
const baseLabels = computed(() => candidates.value.map(c => geocodingAddressLabel(c.components, c.precision.level)))
const labels = computed(() => distinguishAddressLabels(baseLabels.value, 'Вариант'))
const emptyAddressSearch = computed(() => geo.lookup.value?.status === 'EMPTY' && !geo.lookup.value.point)
const levelLabels = { house: 'Дом', street: 'Улица', locality: 'Местность' }
function suggestionDetail(candidate: GeocodingCandidate, index: number) {
    const level = candidate.precision.level
    const type = level ? levelLabels[level] : 'Тип адреса не подтверждён'
    const { locality } = candidate.components
    const duplicate = labels.value[index] !== baseLabels.value[index]
    const settlement = locality && (duplicate || locality.trim().toLocaleLowerCase('ru') !== 'красноярск') ? locality : null
    const note = level === 'house'
        ? candidate.number_match === 'MISMATCH' ? 'Номер отличается' : !candidate.can_confirm ? 'Требуется уточнение' : null
        : level === 'street' && candidate.number_match !== 'NOT_REQUESTED' ? 'Без номера дома' : null
    const position = duplicate && candidate.point
        ? `${candidate.point.lat.toFixed(4)}, ${candidate.point.lon.toFixed(4)}` : null
    return [type, settlement, note, position].filter(Boolean).join(' · ')
}
const previewLabel = computed(() => {
    const c = preview.value
    return c ? labels.value[candidates.value.indexOf(c)] ?? geocodingAddressLabel(c.components, c.precision.level) : ''
})
watch(phase, value => {
    if (value !== 'selected') return
    void nextTick(() => {
        queryInput.value?.focus()
        opened.value = false
    })
})
watch(query, () => { opened.value = true; active.value = -1 })
watch(() => props.point && [props.point.lon, props.point.lat].join(','), () => { geo.resetDraft(); opened.value = false })
function choose(index: number) {
    const c = candidates.value[index]; if (!c) return
    geo.choose(c); opened.value = false
    void nextTick(() => (confirmButton.value ?? pointButton.value ?? queryInput.value)?.focus())
}
function key(event: KeyboardEvent) {
    if (event.key === 'Escape') { opened.value = false; geo.resetDraft(); active.value = -1; return }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); opened.value = true
        const count = candidates.value.length
        if (!count) return
        active.value = event.key === 'ArrowDown' ? (active.value + 1) % count
            : active.value <= 0 ? count - 1 : active.value - 1
        void nextTick(() => document.getElementById(`pa-geocoding-${active.value}`)?.scrollIntoView({ block: 'nearest' }))
    }
    if (event.key === 'Enter') {
        event.preventDefault()
        if (hasActiveCandidate.value) choose(active.value)
        else { opened.value = true; geo.search() }
    }
}
function cancelPreview() {
    geo.resetDraft()
    queryInput.value?.focus()
    opened.value = false
}
function pointInstead() { if (preview.value?.point) { const p = preview.value.point; geo.resetDraft(); emit('point', p) } }
watch(absoluteExpired, value => { if (value) emit('retired') })
const needsReconfirm = computed(() => expired.value || props.selectionError === 'SELECTION_EXPIRED')
watch(needsReconfirm, value => emit('authorizationExpired', value))
defineExpose({ clearSelection: geo.clearSelection, clearDraft: geo.resetDraft })
</script>
<template>
    <div class="pa-geocoding" data-geocoding @keydown.esc="cancelPreview">
        <p v-if="enabled !== false" id="pa-geocoding-text-notice" class="pa-note">Поиск через интернет (API Geoapify). Текст запроса передаётся сервису.</p>
        <form v-if="enabled !== false" class="pa-search" role="search" @submit.prevent="opened = true; geo.search()" @focusout="event => { if (!event.relatedTarget || !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) opened = false }">
            <input id="pa-geocoding-query" ref="queryInput" v-model="query" class="pa-search__input" type="search" maxlength="160" role="combobox" placeholder="Поиск адреса в Красноярске"
                aria-label="Поиск адреса" aria-describedby="pa-geocoding-text-notice" aria-autocomplete="list" aria-controls="pa-geocoding-options" :aria-expanded="opened && !!candidates.length"
                :aria-activedescendant="hasActiveCandidate ? `pa-geocoding-${active}` : undefined" @keydown="key" @focus="opened = true">
            <button v-if="query" class="pa-search__clear" type="button" aria-label="Очистить поиск" @click="query = ''; geo.resetDraft(); opened = false">×</button>
            <div v-if="opened && candidates.length" class="pa-suggestions">
                <div id="pa-geocoding-options" role="listbox" aria-label="Адреса Geoapify">
                    <button v-for="(c, i) in candidates" :id="`pa-geocoding-${i}`" :key="c.candidate_id" type="button" role="option" :aria-selected="active === i"
                        class="pa-suggestion" :class="{ 'is-active': active === i }" @click="choose(i)" @focus="active = i">
                        <span class="pa-suggestion__body"><strong>{{ labels[i] }}</strong><small>{{ suggestionDetail(c, i) }}</small></span>
                    </button>
                </div>
            </div>
        </form>
        <p v-if="phase === 'loading' || phase === 'debouncing'" class="pa-note" role="status">Поиск…</p>
        <div v-if="emptyAddressSearch" class="pa-search-feedback">
            <p class="pa-note" role="status">{{ message }}</p>
            <p class="pa-note">Укажите тип улицы, полный номер дома и город.</p>
            <div class="pa-search-feedback__actions">
                <button type="button" class="pa-outline" @click="queryInput?.focus()">Уточнить адрес</button>
            </div>
        </div>
        <template v-else>
            <p v-if="message || waitSeconds" class="pa-note" role="status">
                {{ message }} <template v-if="waitSeconds">Повтор не ранее чем через {{ waitSeconds }} с.</template>
            </p>
            <div v-if="phase === 'error' && !preview && enabled !== false" class="pa-search-feedback__actions">
                <button v-if="canRetry" type="button" class="pa-outline" @click="queryInput?.focus(); opened = true; geo.retry()">Повторить поиск</button>
            </div>
            <button v-else-if="canRetry" type="button" class="pa-outline" @click="opened = true; geo.retry()">Повторить поиск</button>
        </template>
        <div v-if="point && enabled !== false" class="pa-geocoding-reverse">
            <p id="pa-geocoding-point-notice" class="pa-note">Координаты передаются Geoapify</p>
            <button type="button" class="pa-outline" aria-describedby="pa-geocoding-point-notice" :disabled="phase === 'loading' || confirming"
                @click="opened = true; geo.reverse(point)">Найти адрес поблизости</button>
        </div>
        <section v-if="preview" class="pa-geocoding-preview" aria-label="Подтверждение адреса">
            <strong>{{ geo.lookup.value?.point ? 'Адрес поблизости: ' : '' }}{{ previewLabel }}</strong>
            <p class="pa-note">Проверьте метку на карте.</p>
            <p v-if="preview.precision.level === 'street' && previewLabel !== 'Улица'" class="pa-note">Улица</p>
            <button v-if="preview.can_confirm" ref="confirmButton" type="button" class="pa-primary" :disabled="confirming" @click="geo.confirm()">{{ confirming ? 'Подтверждение…' : 'Анализировать по этому адресу' }}</button>
            <button v-if="preview.point" ref="pointButton" type="button" class="pa-outline" @click="pointInstead">Уточнить свободную точку</button>
            <button type="button" class="pa-outline" @click="cancelPreview">Отмена выбора адреса</button>
        </section>
        <section v-if="selection && (absoluteExpired || selectionError === 'SNAPSHOT_EXPIRED' || needsReconfirm)" aria-label="Подтверждение выбранного адреса">
            <p v-if="absoluteExpired || selectionError === 'SNAPSHOT_EXPIRED'" class="pa-note" role="status">Срок снимка истёк. Найдите и выберите адрес заново. Полученные результаты сохранены.</p>
            <template v-else-if="needsReconfirm">
                <p class="pa-note">Для новых расчётов подтвердите прежнее положение. Данные адреса не обновляются.</p>
                <button type="button" class="pa-outline" :disabled="confirming" @click="geo.confirm(true)">{{ confirming ? 'Подтверждение…' : 'Переподтвердить положение' }}</button>
            </template>
        </section>
        <Teleport v-if="preview || selection || candidates.length" defer to="#pa-search-attribution">
            <div class="pa-geocoding-attribution" role="group" aria-label="Источники адресного поиска">
                <a v-for="a in (preview?.source.attribution ?? selection?.place.address.source.attribution ?? candidates[0]?.source.attribution ?? [])"
                    :key="a.url" :href="a.url" target="_blank" rel="noopener noreferrer">{{ a.text }}</a>
            </div>
        </Teleport>
    </div>
</template>
<style scoped>
.pa-geocoding-preview { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--pa-border, #d4dfd7); border-radius: 8px; background: var(--pa-surface, #fff); }
.pa-geocoding-reverse { display: grid; gap: 4px; }
.pa-geocoding-reverse button { justify-self: start; margin: 0; }
</style>
