<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import TripPointPicker from '@/components/TripPointPicker.vue'
import type { useComparisonTrips } from '@/composables/useComparisonTrips'
import type { SideKey } from '@/utils/comparison'
import type { Coordinates } from '@/types/transport'
import { acceptedTrip, pairedTripFact } from '@/utils/comparisonTrips'
import { tripFailureMessages, type TripFailureMessage } from '@/utils/tripFailure'
import { snapDistance, tripDistance, tripDuration } from '@/utils/trips'
import { sameRoadPoint } from '@/utils/tripCandidates'
const props = defineProps<{ model: ReturnType<typeof useComparisonTrips>; invalidLink: boolean }>()
const emit = defineEmits<{ show: [side: SideKey, id: string]; pick: [id: string, side?: SideKey, end?: 'start' | 'target']; reset: [] }>()
const { mode, setMode, places, cells, cell, add, remove, setPoint, setRoad, calculate, formError } = props.model
const editor = ref<string | null>(null)
const openedEditors = ref(new Set<string>())
const names = { left: 'А', right: 'Б' } as const
const keys: SideKey[] = ['left', 'right']
const locationNames = { start: 'старт', target: 'цель', both_endpoints: 'оба конца', route: 'маршрут', unknown: 'положение неизвестно' }
const pending = computed(() => keys.some(side => Object.values(cells[side]).some(value => value.status === 'loading')))
const progress = computed(() => {
    const values = keys.flatMap(side => places.value.map(place => cell(side, place.id)))
    return values.some(value => value.status !== 'idle') ? `${pending.value ? 'Проверяем. ' : ''}Подтверждено ${values.filter(value => acceptedTrip(value.row)).length} из ${values.length}` : ''
})
const hasResults = (id: string) => keys.some(side => cell(side, id).status !== 'idle')
function messages(side: SideKey, id: string) {
    const row = cell(side, id).row, place = places.value.find(p => p.id === id)
    return row ? tripFailureMessages(row, place?.label || 'Без названия') : []
}
const shared = computed(() => Object.fromEntries(keys.map(side => {
    const rows = places.value.flatMap(place => messages(side, place.id).filter(m => m.location === 'start').map(message => ({ id: place.id, message })))
    return [side, rows.length > 1 && rows.every(row => JSON.stringify(row.message) === JSON.stringify(rows[0]!.message)) ? rows[0]!.message : null]
})) as Record<SideKey, TripFailureMessage | null>)
async function edit(id: string) { openedEditors.value.add(id); editor.value = id; await nextTick(); document.getElementById(`personal-editor-${id}`)?.querySelector('input')?.focus() }
async function focusGoal(id: string) { await nextTick(); document.getElementById(`personal-edit-${id}`)?.focus({ preventScroll: true }); document.getElementById(`personal-place-${id}`)?.scrollIntoView({ block: 'nearest' }) }
function closeEditor(id?: string) { if (!id || editor.value === id) editor.value = null }
async function done(id: string) { closeEditor(id); await focusGoal(id) }
async function selectPoint(id: string, point: Coordinates) { setPoint(id, point); await done(id) }
function addPlace() { const id = add(); if (id) void edit(id) }
async function removePlace(id: string) {
    const index = places.value.findIndex(place => place.id === id)
    closeEditor(id); openedEditors.value.delete(id); remove(id)
    await nextTick()
    const next = places.value[Math.min(index, places.value.length - 1)]
    if (next) await focusGoal(next.id)
    else document.getElementById('personal-add')?.focus()
}
async function submit(side?: SideKey, id?: string) { closeEditor(); await nextTick(); await calculate(side, id) }
async function chooseRoad(side: SideKey, id: string, end: 'start' | 'target', point: Coordinates) {
    const active = document.activeElement as HTMLElement | null
    setRoad(side, id, end, point)
    const request = calculate(side, id), epoch = cell(side, id).epoch, requestMode = mode.value
    await request
    await nextTick()
    if (mode.value !== requestMode || cells[side][id]?.epoch !== epoch) return
    if (requestMode === 'walking' && active && !active.isConnected && document.activeElement === document.body) {
        document.getElementById(`personal-trip-${side}-${id}`)?.querySelector<HTMLElement>('.personal-road-choice summary, .personal-refine summary')?.focus({ preventScroll: true })
    }
    if (active?.isConnected && document.activeElement === active && !active.getClientRects().length) active.closest('details')?.querySelector('summary')?.focus({ preventScroll: true })
}
async function act(side: SideKey, id: string, message: TripFailureMessage) {
    if (message.action === 'retry') { await submit(side, id); return }
    if (message.action === 'choice') {
        const end = message.location === 'target' ? 'target' : message.location === 'start' ? 'start' : message.location === 'both_endpoints' ? (cell(side, id).options.start.length ? 'start' : cell(side, id).options.target.length ? 'target' : 'start') : null
        if (mode.value === 'walking' && (!end || !cell(side, id).options[end].length)) {
            if (end) emit('pick', id, side, end)
            else emit('show', side, id)
            return
        }
        await nextTick()
        const group = document.getElementById(`personal-trip-${side}-${id}`)?.querySelector<HTMLDetailsElement>(`[data-end="${end ?? 'start'}"]`)
        if (group) { group.open = true; group.querySelector('button')?.focus() }
    } else if (message.location === 'start' || message.location === 'both_endpoints') emit('pick', id, side, 'start')
    else if (message.location === 'target') { if (mode.value === 'walking') emit('pick', id, side, 'target'); else void edit(id) }
    else emit('show', side, id)
}
function scrollShared(side: SideKey) { const warning = document.getElementById(`personal-shared-${side}`); warning?.scrollIntoView({ block: 'nearest' }); warning?.focus({ preventScroll: true }) }
function changeMode(event: Event) {
    const value = (event.target as HTMLSelectElement).value
    if (value === 'driving' || value === 'walking') { closeEditor(); setMode(value) }
}
defineExpose({ edit, focusGoal, closeEditor })
</script>
<template>
    <section id="comparison-personal-trips" class="personal-trips" aria-label="Поездки к моим местам">
        <header class="personal-heading"><h2>Личные места <span>{{ places.length }}/3</span></h2><button v-if="places.length < 3" id="personal-add" type="button" @click="addPlace">Добавить место</button></header>
        <label class="personal-mode" for="comparison-trip-mode">Режим маршрута<select id="comparison-trip-mode" :value="mode" @change="changeMode"><option value="driving">Автомобиль</option><option value="walking">Пешком</option></select></label>
        <p v-if="!places.length" class="personal-empty">Добавьте важное место через поиск или карту. Сравним отдельные поездки от А и Б к каждой общей цели.</p>
        <div v-if="places.length" class="personal-calculate"><button type="button" class="personal-primary" :aria-disabled="pending" @click="!pending && submit()">Рассчитать поездки А/Б</button><p role="status" aria-live="polite">{{ progress }}</p></div>
        <p v-if="places.length && mode === 'driving'" class="personal-note">По дорожной сети · модельное время без пробок. Подход и парковка не рассчитаны.</p>
        <p v-if="mode === 'walking'" class="personal-note">Пеший пилот: только уличная часть между выбранными точками. Полный путь от объектов и подходы не рассчитаны; время — статическая модель. Уличные точки выбираются отдельно для каждой поездки.</p>
        <p v-if="invalidLink" role="status" class="personal-warning">Личные места из ссылки не восстановлены: формат, версия или размер не поддерживаются. Адреса сравнения сохранены.</p>
        <p v-if="formError" role="status" class="personal-warning">{{ formError }}</p>
        <div v-for="side in keys" :key="side"><aside v-if="shared[side]" :id="`personal-shared-${side}`" tabindex="-1" class="personal-warning" :class="{ 'is-choice': shared[side]!.action === 'choice' }"><strong>Общий старт {{ names[side] }}: {{ shared[side]!.title }}</strong><p>{{ shared[side]!.description }}</p><p>Дорожный выбор проверяется отдельно для каждой поездки.</p></aside></div>
        <article v-for="place in places" :id="`personal-place-${place.id}`" :key="place.id" class="personal-place" :aria-label="`Цель ${place.label || 'Без названия'}`">
            <header class="personal-place-heading"><h3>{{ place.label || 'Без названия' }}<small v-if="!place.point">Нужна точка</small></h3><div><button :id="`personal-edit-${place.id}`" type="button" :aria-label="`Изменить цель ${place.label || 'Без названия'}`" :aria-expanded="editor === place.id" :aria-controls="`personal-editor-${place.id}`" @click="editor === place.id ? done(place.id) : edit(place.id)">Изменить</button><button type="button" class="personal-remove" :aria-label="`Удалить цель ${place.label}`" @click="removePlace(place.id)">×</button></div></header>
            <div v-if="openedEditors.has(place.id)" :id="`personal-editor-${place.id}`" :hidden="editor !== place.id" class="personal-editor">
                <label :for="`personal-name-${place.id}`">Название для себя<input :id="`personal-name-${place.id}`" v-model="place.label" maxlength="80" autocomplete="off" /></label>
                <TripPointPicker :point="place.point" :label="place.label || 'Без названия'" @select="selectPoint(place.id, $event)" />
                <div class="personal-actions"><button type="button" @click="emit('pick', place.id)">Выбрать цель на карте</button><button type="button" @click="done(place.id)">Готово</button><button v-if="place.point" type="button" class="personal-text" @click="setPoint(place.id, null)">Убрать точку</button></div>
            </div>
            <div v-if="hasResults(place.id) || (mode === 'walking' && place.point)" class="personal-pair" :class="{ 'has-warning': keys.some(side => cell(side, place.id).row && !acceptedTrip(cell(side, place.id).row)) }">
                <section v-for="side in keys" :id="`personal-trip-${side}-${place.id}`" :key="side" :aria-label="`${names[side]} → ${place.label || 'Без названия'}`" :aria-busy="cell(side, place.id).status === 'loading'">
                    <h4><span class="variant-badge" :class="side === 'left' ? 'variant-badge--a' : 'variant-badge--b'">{{ names[side] }}</span><span class="personal-target-caption"> → {{ place.label || 'Без названия' }}</span></h4>
                    <p v-if="cell(side, place.id).status === 'loading'" role="status">Проверяем…</p>
                    <template v-else-if="acceptedTrip(cell(side, place.id).row)"><p v-if="mode === 'walking'" class="personal-note">Только уличная часть</p><p class="personal-distance">{{ tripDistance(cell(side, place.id).row!.route!.distance_m) }}</p><p class="personal-model-time">{{ tripDuration(cell(side, place.id).row!.route!.duration_s) }} · {{ mode === 'walking' ? 'модель уличной части' : 'модель, без пробок' }}</p><button type="button" @click="emit('show', side, place.id)">Показать маршрут {{ names[side] }}</button></template>
                    <p v-else-if="cell(side, place.id).status === 'idle'">Нужен расчёт. <button type="button" @click="submit(side, place.id)">Рассчитать {{ names[side] }}</button></p>
                    <div v-else-if="cell(side, place.id).status === 'error'" class="personal-warning"><p>{{ cell(side, place.id).error }}</p><button type="button" @click="submit(side, place.id)">Повторить {{ names[side] }}</button></div>
                    <template v-else>
                        <p v-if="shared[side] && messages(side, place.id).some(m => m.location === 'start')"><a :href="`#personal-shared-${side}`" @click.prevent="scrollShared(side)">Общий старт {{ names[side] }}</a><button type="button" @click="act(side, place.id, shared[side]!)">{{ shared[side]!.label }}</button></p>
                        <div v-for="message in messages(side, place.id).filter(m => !shared[side] || m.location !== 'start')" :key="message.location" class="personal-warning" :class="{ 'is-choice': message.action === 'choice' }"><strong>{{ locationNames[message.location] }}: {{ message.title }}</strong><p v-if="mode === 'walking' || message.action !== 'choice'">{{ message.description }}</p><button type="button" @click="act(side, place.id, message)">{{ message.label }}</button><button v-if="message.location === 'both_endpoints'" type="button" @click="mode === 'walking' ? emit('pick', place.id, side, 'target') : edit(place.id)">Уточнить цель</button><button v-if="message.action === 'review'" type="button" @click="submit(side, place.id)">Повторить {{ names[side] }}</button></div>
                    </template>
                    <details v-for="end in (['start', 'target'] as const).filter(end => cell(side, place.id).options[end].length)" :key="end" :data-end="end" :open="cell(side, place.id).row?.road_choices?.[end]?.status !== 'SELECTED'" class="personal-road-choice"><summary>{{ mode === 'walking' ? 'Улица' : 'Дорога' }} · {{ end === 'start' ? 'старт' : 'цель' }} {{ names[side] }}</summary><p v-if="mode === 'walking'">Смещение от проверяемой уличной точки; это не расстояние подхода. Выбор только для этой поездки.</p><p v-else>От исходной точки; подход не рассчитан. Выбор только для этой поездки.</p><button v-for="(candidate, index) in cell(side, place.id).options[end]" :key="index" type="button" :aria-pressed="cell(side, place.id).row?.road_choices?.[end]?.status === 'SELECTED' && sameRoadPoint(cell(side, place.id).row?.road_choices?.[end]?.point, candidate.point)" @click="chooseRoad(side, place.id, end, candidate.point)">{{ mode === 'walking' ? 'Улица' : 'Дорога' }} {{ index + 1 }} · {{ snapDistance(candidate.distance_m) }}<span v-if="candidate.name"> · {{ candidate.name }}</span></button><button type="button" @click="emit('show', side, place.id)">Варианты на карте {{ names[side] }}</button></details>
                    <details v-if="mode === 'walking' || cell(side, place.id).row" class="personal-refine"><summary>{{ mode === 'walking' ? 'Выбрать уличные точки' : 'Уточнить привязку' }} {{ names[side] }}</summary><p>Исходный адрес и цель сохранятся. Новый дорожный выбор требует проверки.</p><p v-if="mode === 'walking'">Выбранная улица может отличаться от объекта. Смещение не является расстоянием подхода; подход остаётся неизвестным.</p><button type="button" @click="emit('pick', place.id, side, 'start')">{{ mode === 'walking' ? 'Уличная' : 'Дорожная' }} точка старта {{ names[side] }}</button><button type="button" @click="emit('pick', place.id, side, 'target')">{{ mode === 'walking' ? 'Уличная' : 'Дорожная' }} точка цели {{ names[side] }}</button><template v-if="mode === 'walking'"><p v-if="cell(side, place.id).hints.start">Уличный старт выбран явно.<button type="button" @click="setRoad(side, place.id, 'start', null)">Убрать уличный старт</button></p><p v-if="cell(side, place.id).hints.target">Уличная цель выбрана явно.<button type="button" @click="setRoad(side, place.id, 'target', null)">Убрать уличную цель</button></p></template></details>
                </section>
            </div>
            <p v-else-if="place.point && editor !== place.id" class="personal-note">Точка выбрана · готово к расчёту</p>
            <p v-if="hasResults(place.id)" class="personal-note personal-pair-fact">{{ pairedTripFact(cell('left', place.id), cell('right', place.id), mode) }}</p>
        </article>
        <button v-if="places.length" type="button" class="personal-text personal-reset" @click="emit('reset')">Сбросить личные места</button>
    </section>
</template>
<style scoped>
.personal-trips{font-size:13px;line-height:1.5;min-width:0}.personal-trips p{margin:7px 0;overflow-wrap:anywhere}.personal-trips button{min-height:38px;border:1px solid #bfcebd;border-radius:7px;background:#fcfdf9;padding:6px 9px;text-align:left;overflow-wrap:anywhere}.personal-trips button[aria-pressed=true]{border-color:#247056;background:#edf7ef}.personal-trips button[aria-disabled=true]{opacity:.65}.personal-trips :is(button,input,select,summary,a,aside):focus-visible{outline:3px solid #2d6450;outline-offset:2px}.personal-trips [hidden]{display:none}.personal-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.personal-heading h2{font-size:16px;font-weight:650}.personal-heading h2 span{font-size:12px;color:#607366;margin-left:5px}.personal-mode{display:flex;align-items:center;gap:8px;margin-block:10px}.personal-mode select{min-height:40px;max-width:100%;padding:6px;border:1px solid #bfcebd;border-radius:7px;background:white}.personal-empty{color:#536b5c;line-height:1.7}.personal-calculate{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-block:12px}.personal-calculate .personal-primary{background:#2d6450;color:white;border-color:#2d6450;font-weight:600;padding:9px 12px}.personal-calculate p{font-size:11px;color:#536b5c}.personal-place{border:1px solid #d5e0d1;border-radius:10px;margin-top:12px;padding:10px;min-width:0;scroll-margin:12px}.personal-place-heading{display:flex;align-items:center;justify-content:space-between;gap:6px}.personal-place-heading h3{font-weight:600;overflow-wrap:anywhere;min-width:0}.personal-place-heading small{display:block;font-size:11px;font-weight:400;color:#705629}.personal-place-heading>div{display:flex;gap:4px;flex:none}.personal-place-heading button{font-size:11px;min-height:34px;padding:5px 7px}.personal-place-heading .personal-remove{font-size:20px;min-width:32px;padding:0;text-align:center;border-color:transparent;background:transparent;color:#607366}.personal-editor{margin-top:12px;padding:10px;border:1px solid #cbdace;border-radius:8px;background:#f1f5eb}.personal-editor label{display:block;font-size:12px}.personal-editor input{display:block;width:100%;min-height:40px;background:#fff;border:1px solid #bfcebd;border-radius:7px;padding:7px;font-size:14px}.personal-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.personal-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}.personal-pair section{min-width:0;border-top:1px solid #d9e2d4;padding-top:8px}.personal-pair h4{font-weight:600;font-size:12px}.personal-target-caption{display:none}.personal-pair button{font-size:11px;margin:4px 0;max-width:100%;min-height:36px}.personal-trips .personal-distance{font-size:23px;font-weight:650;color:#2d6450;margin:6px 0}.personal-model-time,.personal-note{font-size:11px;color:#536b5c}.personal-warning{padding:8px;border-left:3px solid #b88627;background:#fff5df;font-size:12px;margin-top:10px}.personal-warning.is-choice{background:#edf7fb;border-color:#377f9b}.personal-road-choice{background:#fff1c9;padding:6px;margin-top:8px;border-radius:7px;font-size:11px}.personal-road-choice button{display:block;width:100%;border-color:#835b23}.personal-pair details{font-size:11px;margin-top:8px}.personal-pair summary{cursor:pointer;min-height:30px;font-size:11px;padding-top:5px}.personal-pair .variant-badge{width:22px;height:22px;font-size:11px}.personal-refine p{font-size:11px}.personal-refine button{display:block;width:100%}.personal-trips a{text-decoration:underline}.personal-trips .personal-text{border-color:transparent;background:transparent;text-decoration:underline;color:#536b5c;font-size:11px}.personal-reset{margin-top:12px}.personal-pair-fact{border-top:1px solid #d9e2d4;padding-top:8px}
@media(max-width:380px){.personal-pair.has-warning{grid-template-columns:minmax(0,1fr)}.has-warning .personal-target-caption{display:inline}.personal-place-heading h3{font-size:12px}.personal-place-heading button{padding-inline:5px}.personal-place{padding:8px}}
</style>
