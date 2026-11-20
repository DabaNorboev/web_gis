<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useGeocoding } from '@/composables/useGeocoding'
import type { AnalysisPoint } from '@/types/placeAnalysis'
import type { GeocodingSelection } from '@/types/geocoding'
const props = defineProps<{ point: AnalysisPoint | null; selectionError?: string | null }>()
const emit = defineEmits<{ selected: [GeocodingSelection]; preview: [AnalysisPoint | null]; point: [AnalysisPoint]; retired: []; authorizationExpired: [boolean] }>()
const geo = useGeocoding(v => emit('selected', v), p => emit('preview', p))
const { query, phase, message, preview, selection, expired, absoluteExpired, waitSeconds, canRetry, confirming } = geo
const opened = ref(false), active = ref(-1), confirmButton = ref<HTMLButtonElement | null>(null), pointButton = ref<HTMLButtonElement | null>(null), queryInput = ref<HTMLInputElement | null>(null)
const candidates = computed(() => geo.lookup.value?.candidates ?? [])
const precision = (level: string | null) => level === 'house' ? 'Уровень дома · точность координат не измерена' : level === 'street' ? 'Улица · положение дома неизвестно' : level === 'locality' ? 'Местность · положение дома неизвестно' : 'Точность неизвестна'
watch(phase, value => { if (value === 'selected') void nextTick(() => { const box = queryInput.value?.closest('.pa-sidebar-search'); if (box) box.scrollTop = 0 }) })
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
        const n = candidates.value.length; if (n) active.value = (active.value + (event.key === 'ArrowDown' ? 1 : n - 1) + n) % n
    }
    if (event.key === 'Enter') {
        event.preventDefault()
        if (opened.value && active.value >= 0) choose(active.value)
        else { opened.value = true; geo.search() }
    }
}
function pointInstead() { if (preview.value?.point) { const p = preview.value.point; geo.resetDraft(); emit('point', p) } }
watch(absoluteExpired, value => { if (value) emit('retired') })
const needsReconfirm = computed(() => expired.value || props.selectionError === 'SELECTION_EXPIRED')
watch(needsReconfirm, value => emit('authorizationExpired', value))
defineExpose({ clearSelection: geo.clearSelection, clearDraft: geo.resetDraft })
</script>
<template>
    <div class="pa-geocoding" data-geocoding @keydown.esc="opened = false; geo.resetDraft()">
        <label class="pa-note" for="pa-geocoding-query">Текст поиска передаётся Geoapify</label>
        <form class="pa-search" role="search" @submit.prevent="opened = true; geo.search()" @focusout="event => { if (!event.relatedTarget || !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) opened = false }">
            <input id="pa-geocoding-query" ref="queryInput" v-model="query" class="pa-search__input" type="search" maxlength="160" role="combobox" placeholder="Поиск адреса в Красноярске"
                aria-label="Поиск адреса" aria-autocomplete="list" aria-controls="pa-geocoding-options" :aria-expanded="opened && !!candidates.length"
                :aria-activedescendant="opened && active >= 0 ? `pa-geocoding-${active}` : undefined" @keydown="key" @focus="opened = true">
            <button v-if="query" class="pa-search__clear" type="button" aria-label="Очистить поиск" @click="query = ''; geo.resetDraft(); opened = false">×</button>
            <div v-if="opened && candidates.length" class="pa-suggestions">
                <div id="pa-geocoding-options" role="listbox" aria-label="Адреса Geoapify">
                    <button v-for="(c, i) in candidates" :id="`pa-geocoding-${i}`" :key="c.candidate_id" type="button" role="option" :aria-selected="active === i"
                        class="pa-suggestion" :class="{ 'is-active': active === i }" @click="choose(i)" @focus="active = i">
                        <span class="pa-suggestion__body"><strong>{{ c.label }}</strong><small>{{ precision(c.precision.level) }}</small></span>
                    </button>
                </div>
            </div>
        </form>
        <p v-if="phase === 'loading' || phase === 'debouncing'" class="pa-note" role="status">Поиск…</p>
        <p v-if="message" class="pa-note" role="status">{{ message }}</p>
        <p v-if="waitSeconds" class="pa-note">Повтор не ранее чем через {{ waitSeconds }} с.</p>
        <button v-if="canRetry" type="button" class="pa-outline" @click="geo.retry()">Повторить поиск</button>
        <button v-if="point" type="button" class="pa-outline" :disabled="phase === 'loading' || confirming" @click="opened = true; geo.reverse(point)">Найти адрес поблизости</button>
        <p v-if="point" class="pa-note">При поиске адреса поблизости координаты передаются Geoapify. Анализ точки доступен без этого запроса.</p>
        <section v-if="preview" class="pa-geocoding-preview" aria-label="Подтверждение адреса">
            <strong>{{ geo.lookup.value?.point ? 'Адрес поблизости: ' : '' }}{{ preview.label }}</strong>
            <p class="pa-note">{{ precision(preview.precision.level) }} · Geoapify</p>
            <p v-if="preview.point" class="pa-note">{{ preview.point.lat }}, {{ preview.point.lon }}</p>
            <p v-if="preview.restrictions.length" class="pa-note">Дом не подтверждён: номер, положение или точность требуют уточнения. Выберите свободную точку на карте.</p>
            <p v-if="preview.can_confirm" class="pa-note">Проверьте отметку на карте. Это не подтверждённый вход в здание.</p>
            <button v-if="preview.can_confirm" ref="confirmButton" type="button" class="pa-primary" :disabled="confirming" @click="geo.confirm()">{{ confirming ? 'Подтверждение…' : 'Подтвердить положение' }}</button>
            <button v-if="preview.point" ref="pointButton" type="button" class="pa-outline" @click="pointInstead">Уточнить свободную точку</button>
            <button type="button" class="pa-outline" @click="geo.resetDraft()">Отмена выбора адреса</button>
        </section>
        <section v-if="selection" aria-label="Выбранный адрес">
            <strong>{{ selection.place.label }}</strong>
            <p class="pa-note">Уровень дома · координатная точность не измерена</p>
            <p v-if="absoluteExpired || selectionError === 'SNAPSHOT_EXPIRED'" class="pa-note" role="status">Срок снимка истёк. Найдите и выберите адрес заново. Полученные результаты сохранены.</p>
            <template v-else-if="needsReconfirm">
                <p class="pa-note">Для новых расчётов подтвердите прежнее положение. Данные адреса не обновляются.</p>
                <button type="button" class="pa-outline" :disabled="confirming" @click="geo.confirm(true)">{{ confirming ? 'Подтверждение…' : 'Переподтвердить положение' }}</button>
            </template>
        </section>
        <div v-if="preview || selection || candidates.length" class="pa-note pa-geocoding-attribution">
            <a v-for="a in (preview?.source.attribution ?? selection?.place.address.source.attribution ?? geo.lookup.value?.candidates[0]?.source.attribution ?? [])" :key="a.url" :href="a.url" target="_blank" rel="noopener noreferrer">{{ a.text }}</a>
        </div>
    </div>
</template>
<style scoped>
.pa-geocoding { display: grid; gap: 8px; min-width: 0; }
.pa-geocoding .pa-search { display: grid; grid-template-columns: minmax(0, 1fr) 28px; height: auto; min-height: 40px; }
.pa-geocoding .pa-search__input { grid-area: 1 / 1; min-height: 38px; width: 100%; }
.pa-geocoding .pa-search__clear { grid-area: 1 / 2; }
.pa-geocoding .pa-suggestions { grid-column: 1 / -1; position: static; width: 100%; max-height: 220px; overflow-y: auto; margin-top: 6px; box-shadow: none; }
.pa-geocoding-preview { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--pa-border, #d4dfd7); border-radius: 8px; background: var(--pa-surface, #fff); }
.pa-geocoding .pa-note { margin: 0; overflow-wrap: anywhere; }
.pa-geocoding-attribution { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.pa-geocoding strong { overflow-wrap: anywhere; }
</style>
