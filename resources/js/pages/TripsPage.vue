<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import PlaceLayout from '@/layouts/PlaceLayout.vue'
import TripPointPicker from '@/components/TripPointPicker.vue'
import TripMap from '@/components/map/TripMap.vue'
import { useTripsState } from '@/composables/useTripsState'
import { coordinateLabel, restoreTripLocation, snapDistance, tripDistance, tripDuration, tripUrl, tripLocationKey } from '@/utils/trips'
import { tripFailureMessage, tripFailureMessages, tripActionNotice, type TripActionNotice, type TripFailureMessage } from '@/utils/tripFailure'
import type { Coordinates } from '@/types/transport'
import { candidateId, sameRoadPoint } from '@/utils/tripCandidates'
import type { TripSelection, TripResult } from '@/types/trips'

const mapView = ref<InstanceType<typeof TripMap> | null>(null)
const phoneLayout = ref(true)
function resizeLayout() { phoneLayout.value = window.innerWidth <= 900 }
const scrollViewport = ref<HTMLElement | null>(null)
const resultsViewport = ref<HTMLElement | null>(null)
let interactionEpoch = 0
function editing() { interactionEpoch++ }
const active = ref<'start' | number>('start')
const activeRoad = ref(false)
const pointAnnouncement = ref('')
const trips = useTripsState({
    saveSelection(value, mode) {
        const url = tripUrl(value)
        if (mode === 'replace' || url !== window.location.pathname + window.location.search + window.location.hash) window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url)
        restoredLocation = tripLocationKey(window.location)
    },
    beginRun(reveal) {
        const intent = interactionEpoch
        const started = Date.now()
        pointAnnouncement.value = ''
        return async isCurrent => { if (reveal) await revealWarning(isCurrent, intent, started) }
    },
})
const {
    draft, analysis, status, error, noticeDismissed, hasCalculated, dirtyIndices,
    pendingChoiceIndices, failedChoiceIndices, invalidLink, formError, editedSinceResult,
    points, candidateGroups, highlightedCandidate, candidateFocus, rowCandidateGroups,
    readPoint, selection, showAvailable, submit,
} = trips
let restoredLocation = ''
type SummaryNotice = Omit<TripActionNotice, 'action'> & { action: TripActionNotice['action'] | 'result' | 'calculate'; location?: TripFailureMessage['location'] }
const resultEntries = computed(() => {
    const rows = new Map((analysis.value?.results ?? []).map(row => [row.index, row]))
    const indices = new Set([...draft.places.map((_, i) => i), ...rows.keys()])
    return [...indices].sort((a, b) => a - b).map(index => ({ index, row: rows.get(index) ?? null }))
})
const successfulCount = computed(() => (analysis.value?.results ?? []).filter(showAvailable).length)
const summaryTitle = computed(() => {
    const count = resultEntries.value.length
    if (status.value === 'loading') return `Проверяем поездки · рассчитано ${successfulCount.value} из ${count}`
    if (dirtyIndices.value.length) return `Рассчитано ${successfulCount.value} из ${count} · нужен пересчёт`
    return `Рассчитано ${successfulCount.value} из ${count}`
})
const actionNotices = computed<SummaryNotice[]>(() => {
    if (noticeDismissed.value || (!hasCalculated.value && !analysis.value)) return []
    return resultEntries.value.map(({ index, row }) => {
        if (pendingChoiceIndices.value.includes(index) || (!row && status.value === 'loading')) return { index, text: `Место ${index + 1}: проверяем путь`, action: 'result', label: 'К результату' }
        if (failedChoiceIndices.value.includes(index) || (!row && error.value)) return { index, text: `Место ${index + 1}: расчёт не получен; точки сохранены`, action: 'retry', label: 'Повторить расчёт' }
        if (!row) return { index, text: `Место ${index + 1}: ${readPoint(draft.places[index]!) ? 'точки изменены — нужен новый расчёт' : 'выберите точку на карте'}`, action: 'calculate', label: 'К действию' }
        if (showAvailable(row)) return { index, text: `Место ${index + 1}: путь рассчитан${row.route ? ` · ${tripDistance(row.route.distance_m)}` : ''}`, action: 'result', label: 'К результату' }
        return tripActionNotice(row) ?? { index, text: `Место ${index + 1}: нужен расчёт`, action: 'retry', label: 'Повторить расчёт' }
    })
})
const sharedStartRow = computed(() => {
    const rows = analysis.value?.results ?? []
    const startRows = rows.filter(row => row.status !== 'AVAILABLE' && tripFailureMessages(row).some(message => message.location === 'start'))
    const signature = (row: TripResult) => JSON.stringify(tripFailureMessages(row).filter(message => message.location === 'start'))
    return startRows.length > 1 && startRows.every(row => signature(row) === signature(startRows[0]!)) ? startRows[0] : null
})
function messagesFor(row: TripResult) {
    return tripFailureMessages(row).filter(message => !sharedStartRow.value || message.location !== 'start')
}
function primaryAction(row: TripResult, message = tripFailureMessage(row)) {
    if (message.action === 'retry') { submit(); return }
    if (message.action === 'choice') { void openActionNotice({ index: row.index, text: '', action: 'choice', label: message.label, location: message.location }); return }
    if (message.action === 'review') { returnToForm(); return }
    void refineFromFailure(message.location === 'start' || message.location === 'both_endpoints' ? 'start' : row.index)
}
async function dismissActionNotice() {
    noticeDismissed.value = true
    await nextTick()
    scrollViewport.value?.focus({ preventScroll: true })
}
async function openActionNotice(notice: SummaryNotice) {
    await nextTick()
    const row = analysis.value?.results.find(item => item.index === notice.index)
    const location = notice.location ?? (row ? tripFailureMessage(row).location : 'unknown')
    const index = row && sharedStartRow.value && location === 'start' ? sharedStartRow.value.index : notice.index
    const card = document.getElementById(`trip-result-${index}`)
    if (!card) return
    const selector = notice.action === 'result' ? null : notice.action === 'calculate' ? '[data-trip-action="calculate"]' : notice.action === 'choice' ? '[data-needs-choice="true"] button[data-candidate-id]' : notice.action === 'retry' ? '[data-trip-action="retry"]' : '[data-trip-action="refine"]'
    const choiceSelector = notice.action === 'choice' && notice.location && ['start', 'target'].includes(notice.location)
        ? `[data-choice-key="${notice.location === 'start' ? 'S' : String(notice.index + 1)}"][data-needs-choice="true"] button[data-candidate-id]` : selector
    const target = (choiceSelector ? card.querySelector<HTMLElement>(choiceSelector) : null) ?? card
    card.scrollIntoView({ block: 'start' })
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'nearest' })
}
const announcement = computed(() => {
    if (status.value === 'loading') return 'Проверяем пути для выбранных точек.'
    const results = (analysis.value?.results ?? []).map(row => `Поездка ${row.index + 1}: ${showAvailable(row)
        ? 'путь рассчитан.' : `${sharedStartRow.value && tripFailureMessage(row).location === 'start' ? 'требуется уточнить общий старт' : tripFailureMessages(row).map(message => message.title).join('. ')}.`}`).join(' ')
    const edited = editedSinceResult.value ? `Места ${dirtyIndices.value.map(i => i + 1).join(', ')}: точки изменены. Прежние результаты этих поездок убраны. Повторите расчёт.` : ''
    return [pointAnnouncement.value, (hasCalculated.value || analysis.value) ? summaryTitle.value : '', edited, results, error.value].filter(Boolean).join(' ')
})
const activeLabel = computed(() => (active.value === 'start' ? 'Старт' : (`Место ${active.value + 1}` + (draft.places[active.value]?.label && draft.places[active.value]?.label !== `Место ${active.value + 1}` ? ` · ${draft.places[active.value]?.label}` : ''))) + (activeRoad.value ? ' — дорожная точка' : ' — исходная точка'))
function choose(point: Coordinates) {
    editing()
    const item = active.value === 'start' ? draft.start : draft.places[active.value]
    if (item) {
        if (activeRoad.value) chooseRoad(active.value === 'start' ? 'S' : String(active.value + 1), point)
        else {
            item.lon = String(point.lon); item.lat = String(point.lat)
            pointAnnouncement.value = `${active.value === 'start' ? 'Старт задан' : `Место ${active.value + 1} задано`}. Можно перейти к следующей точке или рассчитать поездки.`
        }
    }
}
async function mapChoice(key: 'start' | number, road = false) {
    editing()
    active.value = key
    activeRoad.value = road
    pointAnnouncement.value = ''
    await nextTick()
    mapView.value?.focusPoint(key === 'start' ? 'S' : String(key + 1))
    if (window.innerWidth <= 900) document.getElementById('trip-map')?.scrollIntoView({ block: 'start' })
    document.querySelector<HTMLCanvasElement>('#trip-map canvas[tabindex]')?.focus({ preventScroll: true })
}
const activePointReady = computed(() => Boolean(readPoint(active.value === 'start' ? draft.start : draft.places[active.value]!)))
const nextPoint = computed(() => active.value === 'start' ? 0 : active.value + 1 < draft.places.length ? active.value + 1 : null)
const allPointsReady = computed(() => Boolean(readPoint(draft.start)) && draft.places.every(p => readPoint(p)))
async function nextStep() {
    if (!activePointReady.value || nextPoint.value === null) return
    await mapChoice(nextPoint.value)
}
function chooseRoad(key: string, point: Coordinates) {
    active.value = key === 'S' ? 'start' : Number(key) - 1
    activeRoad.value = true
    trips.chooseRoad(key, point)
}
function saveDraftLink() {
    const value = selection()
    if (!value || !window.location.hash.startsWith('#trip=')) return
    const url = tripUrl(value)
    if (url !== window.location.pathname + window.location.search + window.location.hash) window.history.pushState(null, '', url)
    restoredLocation = tripLocationKey(window.location)
}
async function add(onMap = false) {
    if (draft.places.length >= 3) return
    trips.addPlace()
    active.value = draft.places.length - 1
    activeRoad.value = false
    await nextTick()
    if (onMap) await mapChoice(draft.places.length - 1)
    else document.getElementById(`place-name-${draft.places.length - 1}`)?.focus()
}
function remove(index: number) {
    trips.removePlace(index)
    if (active.value === index) activeRoad.value = false
    if (typeof active.value === 'number') active.value = active.value === index ? 'start' : active.value > index ? active.value - 1 : active.value
}
async function revealWarning(isCurrent: () => boolean, intent: number, started: number) {
    await nextTick()
    if (!isCurrent() || intent !== interactionEpoch || Date.now() - started > 2500) return
    const container = window.innerWidth > 900 ? resultsViewport.value : scrollViewport.value
    const warning = container?.querySelector<HTMLElement>('[data-visible-warning]')
    if (!container || !warning) return
    const box = warning.getBoundingClientRect(), frame = container.getBoundingClientRect()
    if (box.top < frame.top || box.bottom > frame.bottom) container.scrollTop += box.top - frame.top - 12
}
function restore() {
    const parsed = restoreTripLocation(window.location, window.history)
    restoredLocation = tripLocationKey(window.location)
    pointAnnouncement.value = ''
    active.value = 'start'
    activeRoad.value = false
    trips.restore(parsed.selection, parsed.invalid)
}
function reset() {
    window.history.pushState(null, '', '/trips')
    restore()
}
function placeTitle(index: number, label?: string) {
    const title = `Место ${index + 1}`
    return title + (label && label !== title ? ` · ${label}` : '')
}
function heading(row: TripResult) {
    if (pendingChoiceIndices.value.includes(row.index)) return 'Рассчитываем выбранный вариант'
    if (failedChoiceIndices.value.includes(row.index)) return 'Расчёт недоступен'
    if (row.status !== 'AVAILABLE' && tripFailureMessage(row).action === 'choice') return 'Ожидает выбора дорожной точки'
    return ({ AVAILABLE: 'Путь рассчитан', NEEDS_REFINEMENT: 'Уточните точку', NO_PATH: 'Путь не найден', UNKNOWN: 'Путь не подтверждён', UNAVAILABLE: 'Расчёт недоступен', OUTSIDE_PILOT: 'Вне пилотной территории' })[row.status]
}
function restoreHistory() {
    if (tripLocationKey(window.location) !== restoredLocation) restore()
}
function showSharedStart() { document.getElementById('trip-shared-start')?.scrollIntoView({ block: 'nearest' }) }
function returnToForm() {
    document.getElementById('trip-form')?.scrollIntoView({ block: 'start' })
    document.getElementById('trip-form')?.focus({ preventScroll: true })
}
async function refineFromFailure(key: 'start' | number, road = false) {
    await mapChoice(key, road)
}
onMounted(() => { resizeLayout(); window.addEventListener('resize', resizeLayout); document.title = 'Поездки к важным местам — PlaceLens'; restore(); window.addEventListener('popstate', restoreHistory); window.addEventListener('hashchange', restoreHistory) })
onBeforeUnmount(() => { window.removeEventListener('resize', resizeLayout); window.removeEventListener('popstate', restoreHistory); window.removeEventListener('hashchange', restoreHistory) })
</script>

<template>
    <PlaceLayout document class="trips-screen">
        <p class="trip-status-announcement" role="status" aria-live="polite" aria-atomic="true">{{ announcement }}</p>
        <div ref="scrollViewport" @wheel.passive="editing" class="trips-scroll" role="region" aria-label="Рабочая область поездок" tabindex="-1">
        <main id="main-content" class="trips-page">
            <div class="trip-intro"><p class="trip-eyebrow">Автомобильный пилот · Красноярск</p><h1>Поездки к важным местам</h1><p>От одного старта — отдельная поездка к каждому месту (до трёх), без последовательного посещения.</p><p class="trip-disclaimer">Только автомобиль. Расстояние — по дорожной сети. Время модельное, без актуальных пробок. Парковка и подход не учтены.</p></div>
            <p v-if="invalidLink" role="alert" class="trip-notice">Ссылку не удалось прочитать. Выберите точки заново.</p>
            <div class="trip-workspace">
                <aside id="trip-map" @pointerdown.capture="editing" @keydown.capture="editing" class="trip-map-panel" aria-label="Выбор точек на карте"><h2>Точки и принятые пути</h2>
                    <div class="trip-point-steps" aria-label="Точки поездок">
                        <div class="trip-step-tabs" role="group" aria-label="Какую точку задать">
                            <button type="button" :aria-pressed="active === 'start' && !activeRoad" @click="mapChoice('start')">Старт <span v-if="readPoint(draft.start)" aria-label="задан">✓</span></button>
                            <button v-for="(place, index) in draft.places" :key="index" type="button" :aria-pressed="active === index && !activeRoad" @click="mapChoice(index)">Место {{ index + 1 }} <span v-if="readPoint(place)" aria-label="задано">✓</span></button>
                        </div>
                        <Teleport to="#trip-point-input" :disabled="phoneLayout" defer><div class="trip-active-input"><h2>{{ active === 'start' ? 'Выберите старт' : `Выберите место ${active + 1}` }}</h2>
                        <TripPointPicker v-if="!activeRoad" :key="String(active)" :point="readPoint(active === 'start' ? draft.start : draft.places[active])" :label="active === 'start' ? 'Старт' : `Место ${active + 1}`" @select="choose" @edit="editing" />
                        <label v-if="typeof active === 'number'" class="trip-step-name" for="step-place-name">Название места {{ active + 1 }}<input id="step-place-name" v-model="draft.places[active]!.label" maxlength="80" @change="saveDraftLink" /></label>
                        </div></Teleport>
                    </div><p id="trip-map-help" class="trip-hint">Найдите адрес или нажмите на карту. С клавиатуры: стрелки на карте → «Выбрать центр карты».</p><TripMap ref="mapView" :points="points" :analysis="analysis" :active-label="activeLabel" :candidate-groups="candidateGroups" :highlighted-candidate="highlightedCandidate" @select="choose" @candidate="chooseRoad" @candidate-focus="candidateFocus">
                        <template #after-map>
                            <div class="trip-step-actions">
                                <p v-if="activeRoad">Выбираете дорожную точку. Исходное место остаётся прежним.</p>
                                <p v-else>{{ activePointReady ? (active === 'start' ? 'Старт задан.' : `Место ${active + 1} задано.`) : 'Нажмите на карту или выберите её центр.' }}</p>
                                <button v-if="activeRoad" type="button" class="trip-pick" @click="mapChoice(active)">К исходной точке</button>
                                <button v-else-if="activePointReady && nextPoint !== null" type="button" class="trip-submit" @click="nextStep">Далее: место {{ nextPoint + 1 }}</button>
                                <button v-if="allPointsReady" type="button" class="trip-submit" :aria-disabled="status === 'loading'" @click="submit">{{ status === 'loading' ? 'Проверяем пути…' : 'Рассчитать поездки' }}</button>
                                <button v-if="!activeRoad && activePointReady && nextPoint === null && draft.places.length < 3" type="button" class="trip-pick" @click="add(true)">Добавить место {{ draft.places.length + 1 }}</button>
                            </div>
                        </template>
                    </TripMap>
                    <a href="#trip-form" class="trip-back-form" @click.prevent="returnToForm">Вернуться к вводу точек</a></aside>
                <div ref="resultsViewport" class="trip-form-results" @input.capture="editing" @pointerdown.capture="editing" @keydown.capture="editing" @wheel.passive="editing">
        <div id="trip-point-input"></div>
        <section v-if="actionNotices.length" class="trip-action-summary" aria-labelledby="trip-action-summary-title">
            <div class="trip-action-summary-heading"><h2 id="trip-action-summary-title">{{ summaryTitle }}</h2><button type="button" aria-label="Скрыть уведомление" @click="dismissActionNotice"><span aria-hidden="true">×</span></button></div>
            <ul><li v-for="notice in actionNotices" :key="notice.index" :data-action-kind="notice.action">
                <p :id="`trip-action-summary-item-${notice.index}`">{{ notice.text }}</p>
                <button type="button" :aria-label="`${notice.label}, место ${notice.index + 1}`" :aria-describedby="`trip-action-summary-item-${notice.index}`" @click="openActionNotice(notice)">{{ notice.label }}</button>
            </li></ul>
        </section>

                    <form id="trip-form" tabindex="-1" class="trip-form" @submit.prevent="submit">
                        <h2>Выбранные точки</h2>
                        <fieldset><legend>Старт</legend><p>{{ readPoint(draft.start) ? 'Точка задана ✓' : 'Выберите адрес или точку' }}</p><button type="button" class="trip-pick" :aria-pressed="active === 'start' && !activeRoad" @click="mapChoice('start')">{{ readPoint(draft.start) ? 'Изменить старт' : 'Выбрать старт' }}</button><details v-if="readPoint(draft.start)"><summary>Технические сведения старта</summary><p>{{ coordinateLabel(readPoint(draft.start)!) }}</p><button type="button" class="trip-text-button" @click="mapChoice('start', true)">Изменить дорожную точку старта</button></details></fieldset>
                        <fieldset v-for="(place, index) in draft.places" :key="index"><legend>Место {{ index + 1 }}</legend><label :for="`place-name-${index}`">Название для себя<input :id="`place-name-${index}`" v-model="place.label" @change="saveDraftLink" maxlength="80" type="text" /></label><p>{{ readPoint(place) ? 'Точка задана ✓' : 'Выберите адрес или точку' }}</p><div class="trip-place-actions"><button type="button" class="trip-pick" :aria-pressed="active === index && !activeRoad" @click="mapChoice(index)">{{ readPoint(place) ? 'Изменить' : 'Выбрать' }} место {{ index + 1 }}</button><button v-if="draft.places.length > 1" type="button" class="trip-text-button" :aria-label="`Убрать место ${index + 1}`" @click="remove(index)">Убрать</button></div><details v-if="readPoint(place)"><summary>Технические сведения места {{ index + 1 }}</summary><p>{{ coordinateLabel(readPoint(place)!) }}</p><button type="button" class="trip-text-button" @click="mapChoice(index, true)">Изменить дорожную точку места {{ index + 1 }}</button></details></fieldset>
                        <button v-if="draft.places.length < 3" type="button" class="trip-add" @click="add()">Добавить важное место</button>
                        <p v-if="formError" role="alert" class="trip-notice">{{ formError }}</p>
                        <div class="trip-submit-actions"><button class="trip-submit" type="submit" :aria-disabled="status === 'loading'">{{ status === 'loading' ? 'Проверяем пути…' : 'Рассчитать поездки' }}</button><button type="button" class="trip-text-button" @click="reset">Сбросить</button></div>
                        <p class="trip-hint">Получатель ссылки сможет увидеть координаты и подписи всех сохранённых точек. Ссылка сохраняется в истории этого браузера. Передавайте её только тем, кому готовы раскрыть эти данные. При повторном открытии выполняется новый расчёт.</p>
                    </form>
                    <p v-if="status === 'loading'" class="trip-notice">Получаем линии и проверяем обе привязки для каждого места.</p>
                    <div v-if="error" data-visible-warning role="alert" class="trip-notice">{{ error }} <button type="button" @click="submit">Повторить расчёт</button></div>
                    <section v-if="analysis || hasCalculated" class="trip-results" aria-label="Результаты поездок">
                        <h2>От старта к каждому месту</h2>
                        <div v-if="sharedStartRow" id="trip-shared-start" data-visible-warning class="trip-failure" :class="{ 'trip-choice-notice': tripFailureMessages(sharedStartRow).some(message => message.location === 'start' && message.action === 'choice') }"><template v-for="message in tripFailureMessages(sharedStartRow).filter(item => item.location === 'start')" :key="message.title"><h3>{{ message.title }}</h3><p>{{ message.description }}</p><button type="button" class="trip-pick" @click="primaryAction(sharedStartRow, message)">{{ message.label }}</button></template></div>
                        <template v-for="entry in resultEntries" :key="entry.index">
                        <article v-if="!entry.row" :id="`trip-result-${entry.index}`" class="trip-result trip-edited-result" tabindex="-1">
                            <h3>{{ placeTitle(entry.index, draft.places[entry.index]?.label) }}</h3>
                            <p v-if="status === 'loading'">Проверяем путь для этих точек…</p>
                            <template v-else-if="error"><p>Расчёт не получен. Точки сохранены.</p><button type="button" class="trip-pick" data-trip-action="retry" @click="submit">Повторить расчёт</button></template>
                            <template v-else><p>Точки изменены. Прежний результат этой поездки убран.</p>
                                <button v-if="allPointsReady" type="button" class="trip-pick" data-trip-action="calculate" @click="submit">Рассчитать заново</button>
                                <button v-else type="button" class="trip-pick" data-trip-action="calculate" @click="mapChoice(readPoint(draft.start) ? entry.index : 'start')">Выбрать точку на карте</button>
                            </template>
                        </article>
                        <template v-else><article v-for="row in [entry.row]" :id="`trip-result-${row.index}`" :key="row.index" tabindex="-1" class="trip-result" :data-status="row.status" :data-awaiting-choice="row.status !== 'AVAILABLE' && tripFailureMessage(row).action === 'choice'" :aria-describedby="row.status !== 'AVAILABLE' ? `trip-failure-${row.index}` : undefined">
                            <h3>{{ placeTitle(row.index, draft.places[row.index]?.label || row.label) }}</h3><p class="trip-result-status">{{ heading(row) }}</p>
                            <p v-if="pendingChoiceIndices.includes(row.index)" class="trip-choice-progress">Проверяем маршрут от выбранной дорожной точки. Остальными точками и картой можно пользоваться.</p>
                            <div v-else-if="failedChoiceIndices.includes(row.index)" class="trip-failure"><h4>Расчёт не получен</h4><p>Выбор точки сохранён. Повторите расчёт.</p><button type="button" class="trip-pick" data-trip-action="retry" @click="submit">Повторить расчёт</button></div>
                            <template v-else>
                                <p v-if="showAvailable(row) && row.route" class="trip-values">{{ tripDistance(row.route.distance_m) }}</p>
                                <p v-if="showAvailable(row) && row.route" class="trip-model-time">{{ tripDuration(row.route.duration_s) }} — модельное время без актуальных пробок</p>
                                <p v-if="!showAvailable(row) && sharedStartRow && tripFailureMessages(row).some(item => item.location === 'start')" class="trip-shared-reference">Требуется выбор или уточнение общего старта — <a href="#trip-shared-start" @click.prevent="showSharedStart">см. предупреждение старта</a>.</p>
                                <div v-if="!showAvailable(row)" :id="`trip-failure-${row.index}`" :data-visible-warning="messagesFor(row).length ? '' : undefined" class="trip-failure" :class="{ 'trip-choice-notice': tripFailureMessage(row).action === 'choice' }">
                                    <div v-for="message in messagesFor(row)" :key="message.location"><h4>{{ message.title }}</h4><p>{{ message.description }}</p>
                                    <div class="trip-place-actions"><button type="button" class="trip-pick" :data-trip-action="message.action === 'retry' ? 'retry' : 'refine'" @click="primaryAction(row, message)">{{ message.label }}</button><button v-if="message.location === 'both_endpoints'" type="button" class="trip-pick" @click="refineFromFailure(row.index)">Уточнить место {{ row.index + 1 }}</button><button v-if="message.action === 'review'" type="button" class="trip-text-button" @click="submit">Повторить расчёт</button></div></div>
                                </div>
                                <details v-if="!showAvailable(row) && tripFailureMessage(row).action !== 'choice'" class="trip-failure-details"><summary>Подробности проверки</summary><p>{{ row.reason }}</p><p v-if="row.checks.length">Коды проверки: <code>{{ row.checks.join(', ') }}</code></p><template v-for="end in (['start', 'target'] as const)" :key="end"><p v-if="row.road_choices?.[end]?.diagnostics">{{ end === 'start' ? 'Старт' : 'Место' }}: радиус {{ row.road_choices[end].diagnostics!.radius_m }} м; ближайшая дорожная геометрия среди загруженных ячеек: {{ row.road_choices[end].diagnostics!.nearest_road_distance_m === null ? 'нет данных' : snapDistance(row.road_choices[end].diagnostics!.nearest_road_distance_m!) }}. Это не ближайшая доступная дорога. Данные о входах не подготовлены.</p></template></details>
                                <details v-if="row.snaps"><summary>Исходные и дорожные точки</summary><p>Исходный старт: {{ coordinateLabel(row.snaps.start.original) }}<br />Начало линии: {{ coordinateLabel(row.snaps.start.matched) }}<br />Смещение: {{ snapDistance(row.snaps.start.distance_m) }}</p><p>Выбранное место: {{ coordinateLabel(row.snaps.target.original) }}<br />Конец линии: {{ coordinateLabel(row.snaps.target.matched) }}<br />Смещение: {{ snapDistance(row.snaps.target.distance_m) }}</p><p>Короткий подход между точками не включён в расстояние и время. Автоматическая привязка не подтверждает вход или парковку.</p></details>

                            </template>
                            <details v-for="group in rowCandidateGroups(row).filter(group => group.key !== 'S' || !sharedStartRow || row.index === sharedStartRow.index)" :open="!group.selected" :key="group.key" class="trip-candidates" :data-choice-key="group.key" :data-needs-choice="!group.selected" :aria-label="`Дорожные варианты: ${group.label}, поездка ${row.index + 1}`">
                                <summary>{{ group.label }} · {{ group.selected ? 'Дорожная точка выбрана ✓' : 'Выберите дорожную точку' }}</summary>
                                <p class="trip-hint">Расстояние указано от исходной точки до дороги; подход не рассчитан. <button type="button" class="trip-text-button" @click="mapChoice(group.key === 'S' ? 'start' : Number(group.key) - 1, true)">Показать на карте</button></p>
                                <ul class="trip-candidate-list"><li v-for="(candidate, index) in group.candidates" :key="candidateId(group.key, index)">
                                    <button type="button" class="trip-candidate-option" :data-candidate-id="candidateId(group.key, index)" :aria-pressed="sameRoadPoint(group.selected, candidate.point)" :class="{ 'is-highlighted': highlightedCandidate === candidateId(group.key, index), 'is-selected': sameRoadPoint(group.selected, candidate.point) }" @mouseenter="candidateFocus(candidateId(group.key, index), 'pointer')" @mouseleave="candidateFocus(null, 'pointer')" @focus="candidateFocus(candidateId(group.key, index), 'focus')" @blur="candidateFocus(null, 'focus')" @click="chooseRoad(group.key, candidate.point)">
                                        <span class="trip-candidate-badge" aria-hidden="true">{{ index + 1 }}</span><span><strong>{{ group.candidates.length === 1 && group.selected ? 'Выбранная точка' : `Вариант ${index + 1}` }} — {{ snapDistance(candidate.distance_m) }}</strong><small v-if="candidate.name">{{ candidate.name }}</small><small v-if="sameRoadPoint(group.selected, candidate.point)">✓ Выбрано</small></span>
                                    </button>
                                </li></ul>
                            </details>
                        </article></template></template>
                        <details v-if="analysis" class="trip-sources"><summary>Источники и ограничения расчёта</summary><p>{{ analysis.limitation }}</p><template v-if="analysis.source"><p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors · ODbL</a><br />{{ analysis.source.engine }} {{ analysis.source.engine_version }}, профиль {{ analysis.source.profile }}<br />Версия графа: {{ analysis.source.dataset_version }}</p><p>Дата наблюдения данных неизвестна. Актуальность: неизвестна. Расстояние и время — вычисленные оценки. Территория пилота ограничена подготовленной частью Красноярска; полнота дорожной сети не подтверждена.</p><p>SHA-256 исходного PBF:<br /><code>{{ analysis.source.pbf_sha256 }}</code></p></template><p v-else>Локальный снимок маршрутизации сейчас недоступен.</p></details>
                    </section>
                </div>

            </div>
        </main>
        </div>
    </PlaceLayout>
</template>

<style scoped>
.trips-screen{height:100dvh;min-height:0;overflow:hidden}
.trips-scroll{overflow-anchor:none;flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;scroll-padding-block:12px;outline:none}
.trip-action-summary{flex:none;max-height:min(40dvh,320px);overflow:auto;padding:8px max(16px,calc((100vw - 1272px)/2));border-bottom:2px solid #82acbd;background:#edf7fb;color:#244f61;overscroll-behavior:contain}
.trip-action-summary-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
.trip-action-summary h2{font-size:14px;font-weight:650}
.trip-action-summary-heading button{flex:none;font-size:24px;line-height:1;width:36px;height:36px}
.trip-action-summary ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.trip-action-summary li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:6px 0;border-top:1px solid #c5dce5}
.trip-action-summary li p{font-size:13px;line-height:1.4;overflow-wrap:anywhere;margin:0}
.trip-action-summary li button{max-width:120px;min-height:36px;padding:6px 10px;border:1px solid #83aabd;border-radius:8px;background:#fff;font-size:12px;line-height:1.3;font-weight:600;color:#244f61}
.trip-result{scroll-margin-block:12px}
@media(max-width:639px){.trip-action-summary{padding:4px 12px}.trip-action-summary li{gap:8px}.trip-action-summary li button{max-width:100px;padding:6px 8px}}
.trips-page{width:min(1320px,100%);margin:0 auto;padding:28px 24px 60px;color:#273b31}.trip-intro{max-width:800px;margin-bottom:26px}.trip-eyebrow{font-size:12px;letter-spacing:.05em;color:#607767}.trip-intro h1{font-size:clamp(26px,3vw,34px);font-weight:600;line-height:1.2;margin:8px 0 14px}.trip-intro p{line-height:1.6;margin:10px 0}.trip-disclaimer{font-size:14px;color:#607366}.trip-workspace{display:grid;grid-template-columns:400px minmax(0,1fr);gap:30px;align-items:start}.trip-form,.trip-result,.trip-sources{background:#fcfdf9;border:1px solid #dce5da;border-radius:14px;padding:18px}.trip-form fieldset{min-width:0;margin:18px 0 0;padding:14px 0 0;border:0;border-top:1px solid #e1e7dd}.trip-form legend{font-size:16px;font-weight:600;padding:0 5px 0 0}.trip-form label{display:block;font-size:12px;color:#516958}.trip-form input,.trip-form select{display:block;width:100%;min-height:42px;margin-top:5px;padding:8px 10px;border:1px solid #bfcebd;border-radius:8px;font-size:14px;color:#273b31;background:#fff}.trip-coordinates{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-top:12px}.trip-hint{font-size:12px;color:#607366;line-height:1.6;margin:12px 0 0}.trip-place-actions{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px}button{cursor:pointer;min-height:40px;font-size:13px}button:disabled,button[aria-disabled=true]{cursor:wait;opacity:.65}.trip-pick,.trip-add{padding:8px 11px;border:1px solid #c5d4c3;border-radius:8px;color:#2d6450;background:#f3f7ed}.trip-pick[aria-pressed=true]{background:#e3efda;border-color:#2d6450}.trip-add{margin-top:18px}.trip-text-button{padding:7px 5px;color:#496451;text-decoration:underline;text-underline-offset:3px}.trip-submit-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:20px}.trip-submit{background:#2d6450;color:#fff;border-radius:9px;padding:11px 17px;font-weight:600}.trip-notice{font-size:14px;line-height:1.6;padding:14px;border:1px solid #dfd7b7;border-radius:10px;background:#fff8e8;margin:16px 0}.trip-notice button{text-decoration:underline}.trip-results{margin-top:26px}.trip-results h2,.trip-map-panel h2{font-size:19px;font-weight:600;margin:0 0 14px}.trip-result{margin-bottom:12px}.trip-result h3{font-size:17px;font-weight:600;overflow-wrap:anywhere}.trip-result p{font-size:13px;line-height:1.65;margin-top:10px}.trip-result-status{color:#607366}.trip-result .trip-values{font-size:25px;font-weight:600;color:#2d6450}.trip-model-time{font-size:14px;font-weight:400;color:#607366}.trip-candidates{margin-top:16px;padding:16px;border:1px solid #c5d4c3;border-radius:12px}.trip-candidates button{margin:6px 8px 6px 0}.trip-place-actions{flex-wrap:wrap}.trip-result details{font-size:12px;line-height:1.7;margin-top:12px;overflow-wrap:anywhere}.trip-result summary,.trip-sources summary{cursor:pointer;font-size:13px;font-weight:600;min-height:32px;padding-top:6px}.trip-result>.trip-pick{margin-top:12px}.trip-sources{font-size:12px;line-height:1.7}.trip-sources p{margin:12px 0}.trip-sources code{overflow-wrap:anywhere}.trip-sources a,.trip-back-form{color:#2d6450;text-decoration:underline;text-underline-offset:3px}.trip-map-panel{grid-column:2;grid-row:1;position:sticky;top:18px;scroll-margin-top:16px;min-width:0}.trip-map-panel>.trip-hint{margin-bottom:12px}.trip-back-form{display:none;min-height:40px;padding:8px 0;font-size:13px}#trip-form{scroll-margin-top:16px}:is(button,a,input,select,summary):focus-visible{outline:3px solid #2d6450;outline-offset:3px}@media(max-width:900px){.trip-workspace{grid-template-columns:minmax(0,1fr);gap:28px}.trip-map-panel{position:static;grid-column:1;grid-row:1}.trip-form-results{grid-column:1;grid-row:2}.trip-back-form{display:inline-flex}.trips-page{padding:22px 16px 40px}.trip-intro{margin-bottom:20px}}

.trip-status-announcement{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.trip-failure{margin-top:14px;padding:16px;border:1px solid #c69d4b;border-left:4px solid #b88627;border-radius:10px;background:#fff5df;color:#513b16;overflow-wrap:anywhere}
.trip-failure h4{display:flex;align-items:flex-start;gap:9px;font-size:15px;font-weight:650;line-height:1.5}
.trip-failure h4 span{display:inline-grid;place-items:center;flex:none;width:22px;height:22px;border:1.5px solid currentColor;border-radius:50%;font-weight:700}
.trip-failure .trip-pick{background:#fffdf7;border-color:#bda46e;color:#513b16;text-align:left}
.trip-result .trip-failure p{font-size:14px;line-height:1.65}

.trip-choice-notice{border-color:#86b5c8;border-left-color:#377f9b;background:#edf7fb;color:#244f61}
.trip-choice-progress{padding:12px;background:#edf7fb;border-radius:8px;color:#244f61}
.trip-candidates h4{font-size:14px;font-weight:650}
.trip-candidate-list{list-style:none;padding:0;margin:10px 0 0;display:grid;gap:8px}
.trip-candidate-list button.trip-candidate-option{display:flex;align-items:center;gap:10px;width:100%;margin:0;padding:12px;text-align:left;background:#fff;border:2px solid #bdcdd0;border-radius:10px;color:#294d59;overflow-wrap:anywhere}
.trip-candidate-option small{display:block;margin-top:4px;font-size:12px}
.trip-candidate-option.is-highlighted{outline:3px solid #397b9d;outline-offset:2px;background:#eaf5fb!important}
.trip-candidate-option.is-selected{border-color:#247056!important;background:#edf7ef!important;color:#225c45!important}
.trip-candidate-badge{display:grid;place-items:center;flex:none;min-width:34px;height:34px;border-radius:50%;background:#f9e8b9;color:#5c421b;font-weight:700}
.trip-candidate-option.is-selected .trip-candidate-badge{background:#247056;color:white}

.trip-form-results{overflow-anchor:none;grid-column:1;grid-row:1;min-width:0}
.trip-point-steps,.trip-step-actions{display:none}
@media(max-width:900px){
    .trip-form-results{grid-column:1;grid-row:2}
    .trip-point-steps,.trip-step-actions{display:block}
    .trip-step-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
    .trip-step-tabs button{flex:1;min-width:65px;min-height:44px;border:1px solid #bfcebd;border-radius:8px;padding:6px;background:#fcfdf9;color:#2d6450}
    .trip-step-tabs button[aria-pressed=true]{background:#e3efda;border:2px solid #2d6450;font-weight:650}
    .trip-step-name{display:block;font-size:12px;margin-bottom:10px}
    .trip-step-name input{display:block;min-height:44px;width:100%;padding:8px 10px;margin-top:4px;background:#fff;border:1px solid #bfcebd;border-radius:8px;font-size:14px}
    .trip-step-actions{position:sticky;bottom:0;z-index:3;padding:10px 0;background:#f7f9f2;border-top:1px solid #dce5da}
    .trip-step-actions p{font-size:13px;margin:0 0 8px}
    .trip-step-actions button{min-height:44px;margin:0 6px 6px 0}
    .trip-map-panel>h2{font-size:17px;margin-bottom:10px}
    .trip-map-panel>.trip-hint{font-size:12px;margin:8px 0}
}
</style>

<style scoped>
.trip-point-steps,.trip-step-actions{display:block}.trip-step-tabs{display:flex;gap:6px;flex-wrap:wrap}.trip-step-tabs button{min-height:44px;flex:1;padding:6px;border:1px solid #bfcebd;border-radius:8px;background:#fcfdf9}.trip-step-tabs button[aria-pressed=true]{border:2px solid #2d6450;background:#e3efda}.trip-step-name{display:block;font-size:12px;margin-bottom:10px}.trip-step-name input{display:block;width:100%;padding:8px;border:1px solid #bfcebd;border-radius:8px;background:white;min-height:44px}.trip-step-actions{padding:8px 0}.trip-step-actions p{font-size:13px}.trip-step-actions button{margin:4px 6px 0 0}.trip-action-summary{padding:8px 12px;border:1px solid #82acbd;border-radius:10px;margin-bottom:12px;max-height:none}.trip-form details{margin-top:10px;font-size:12px;overflow-wrap:anywhere}.trip-form summary{cursor:pointer;min-height:32px}.trip-form h2{font-weight:600}.trip-map-panel{min-height:0}.trip-map-panel>h2{margin-bottom:10px}.trip-result .trip-failure:empty{display:none}
@media(min-width:901px){.trips-scroll{overflow:hidden;display:flex;flex-direction:column}.trips-page{flex:1;min-height:0;display:flex;flex-direction:column;padding:16px 24px 20px}.trip-intro{max-width:none;margin-bottom:12px}.trip-intro h1{font-size:26px;margin:4px 0}.trip-intro p{margin:4px 0;line-height:1.4}.trip-workspace{flex:1;min-height:0;grid-template-columns:minmax(320px,400px) minmax(0,1fr);gap:24px;align-items:stretch}.trip-form-results{overflow:auto;scrollbar-gutter:stable;scroll-padding:12px;overscroll-behavior:contain}.trip-map-panel{position:relative;top:0;overflow:auto;scrollbar-gutter:stable;overscroll-behavior:contain}.trip-map-panel :deep(.trip-map-canvas){height:clamp(200px,36dvh,490px)}.trip-map-panel>.trip-hint{margin:6px 0}.trip-point-picker :deep(.search-note){font-size:12px}.trip-step-actions{position:sticky;bottom:0;background:#f7f9f2;z-index:3}}
@media(max-width:900px){.trip-intro{margin-bottom:14px}.trip-intro h1{font-size:25px}.trip-intro p{line-height:1.45}.trip-map-legend{font-size:11px}}
</style>

<style scoped>
.trip-active-input{min-width:0}.trip-active-input h2{font-size:16px;font-weight:600;margin-bottom:8px}
@media(min-width:901px){.trip-active-input{padding:14px;margin-bottom:12px;border:1px solid #c5d4c3;border-radius:12px;background:#fcfdf9}.trip-map-panel{display:flex;flex-direction:column;overflow:hidden}.trip-map-panel :deep(.trip-map-canvas){flex:1;min-height:160px;height:auto}.trip-map-panel :deep(.trip-map-controls),.trip-map-panel :deep(.map-theme-control),.trip-point-steps,.trip-step-actions,.trip-map-panel>h2,.trip-map-panel>.trip-hint,.trip-map-panel :deep(.trip-map-legend){flex:none}.trip-map-panel :deep(.map-theme-control){align-self:flex-start}.trip-step-actions{position:static}.trip-map-panel>.trip-hint{font-size:11px;line-height:1.4}.trip-map-panel :deep(.trip-map-legend){margin:4px 0 0}.trip-map-panel :deep(.trip-map-legend summary){cursor:pointer;min-height:24px}}
@media(min-width:901px) and (max-height:650px){.trip-map-panel>h2,.trip-map-panel>.trip-hint{display:none}.trip-map-panel :deep(.trip-map-canvas){min-height:130px}.trip-map-panel :deep(.trip-map-controls){margin:4px 0}.trip-step-actions{padding:4px 0}.trip-step-actions p{display:none}.trip-step-tabs{margin-bottom:6px}}
</style>

<style scoped>
@media(min-width:901px){.trip-map-panel>h2,.trip-step-actions p{display:none}.trip-map-panel>.trip-hint{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);margin:0}.trip-step-actions{padding:4px 0}}
</style>
