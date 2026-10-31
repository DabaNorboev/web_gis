<script setup lang="ts">
import { computed, inject, nextTick, shallowReactive } from 'vue'
import { Pencil, Trash2 } from '@lucide/vue'
import HomeResultDialog from './HomeResultDialog.vue'
import HomeOrientationInput from './HomeOrientationInput.vue'
import TripPointPicker from '@/components/TripPointPicker.vue'
import { homeStandaloneTrip } from '@/composables/useHomeTrips'
import type { HomeTripRef, HomeTripsInput, HomeTripsPort } from '@/types/homeWorkspace'
import type { HomeOrientationContext, HomeOrientationTarget } from '@/types/homeOrientations'
import type { Coordinates } from '@/types/transport'
const props = defineProps<{ model: HomeTripsPort; input: HomeTripsInput; scenario: 'addresses' | 'standalone'; available: ('left' | 'right')[]; busy: boolean; picking: boolean }>()
const emit = defineEmits<{ changeMode: [event: Event]; pickGoal: [trip: HomeTripRef]; chooseOriginal: [index: number, point: Coordinates]; showMap: [focus: boolean]; run: []; focusPoint: [point: Coordinates] }>()
const { addresses, standalone } = props.model
const { mode, places, formError } = addresses
const { draft } = standalone
const standalonePlaces = computed(() => draft.places.map((place, index) => ({ place, index, trip: homeStandaloneTrip(props.model, index)! })))
const orientations = inject<HomeOrientationContext | null>('home-orientations', null)
const saved = shallowReactive(new Set<object>())
const invalid = shallowReactive(new Set<object>())
const dirty = shallowReactive(new Map<object, string>())
const labels = shallowReactive(new Map<object, { label: string; point: Coordinates }>())
const signature = (point: Coordinates | null) => JSON.stringify(point)
function addressLabel(place: object, label: string, point: Coordinates) { labels.set(place, { label, point }); dirty.delete(place) }
function summaryAddress(place: object, point: Coordinates | null) {
    const known = labels.get(place)
    return known && signature(known.point) === signature(point) ? known.label : 'Точка на карте'
}
function threshold(target: HomeOrientationTarget) {
    const value = orientations?.owner.find(target)?.threshold
    return value == null ? 'Без ориентира времени' : `До ${value} мин`
}
function canSave(place: { label: string }, point: Coordinates | null) {
    return !!place.label.trim() && !!point && !invalid.has(place) && dirty.get(place) !== signature(point)
}
function validate(place: object, valid: boolean) { if (valid) invalid.delete(place); else invalid.add(place) }
async function saveGoal(place: object, id: string) {
    saved.add(place)
    await nextTick()
    document.getElementById(`edit-${id}`)?.focus({ preventScroll: true })
}
async function editGoal(place: object, id: string) {
    saved.delete(place)
    await nextTick()
    const field = document.getElementById(id)
    if (field?.getClientRects().length && !field.closest('[inert]')) { field.focus({ preventScroll: true }); field.scrollIntoView({ block: 'nearest' }) }
}
async function openGoal(scenario: 'addresses' | 'standalone', placeId: string) {
    if (scenario === 'addresses') {
        const place = places.value.find(place => place.id === placeId)
        if (place) await editGoal(place, `home-goal-${placeId}`)
    } else {
        const item = standalonePlaces.value.find(item => item.trip.placeId === placeId)
        if (item) await editGoal(item.place, `home-${placeId}`)
    }
}
defineExpose({ openGoal })

async function addGoal() {
    const id = addresses.add()
    if (!id) return
    await nextTick()
    const field = document.getElementById(`home-goal-${id}`)
    field?.focus({ preventScroll: true }); field?.scrollIntoView({ block: 'nearest' })
}
async function addStandaloneGoal() {
    standalone.addPlace()
    await nextTick()
    const trip = homeStandaloneTrip(props.model, draft.places.length - 1)
    const field = trip && document.getElementById(`home-${trip.placeId}`)
    if (field) { field.focus({ preventScroll: true }); field.scrollIntoView({ block: 'nearest' }) }
}
</script>
<template>
    <section class="home-trips-editor" aria-label="Редактор поездок">
        <header class="home-goals-heading"><h2>{{ scenario === 'addresses' ? 'Цели поездок' : 'Отдельная поездка' }}</h2><span :aria-label="scenario === 'addresses' ? 'Количество целей' : 'Количество отдельных целей'">{{ scenario === 'addresses' ? places.length : draft.places.length }}/3</span></header>
        <fieldset class="home-mode-segments"><legend class="sr-only">Общий режим поездок</legend><label v-for="option in [{ value: 'walking', label: 'Пешком' }, { value: 'driving', label: 'Авто' }]" :key="option.value"><input type="radio" name="home-trip-mode" :value="option.value" :checked="mode === option.value" @change="emit('changeMode', $event)" /><span>{{ option.label }}</span></label></fieldset>
        <div class="home-method-note"><span>{{ mode === 'walking' ? 'По выбранным улицам' : 'Время без учёта пробок' }}</span><HomeResultDialog title="Как рассчитано время" label="О методе поездок"><p v-if="mode === 'walking'">Пеший пилот: только уличная часть между явно выбранными точками. Полный путь между объектами, расстояние и время подходов неизвестны. Время — статическая модель.</p><p v-else>По дорожной сети · модельное время без пробок. Подход, парковка и доступ к входам не рассчитаны.</p></HomeResultDialog></div>
        <p v-if="picking" role="status">Выберите точку на общей карте. Исходные объекты и выбранные улицы хранятся отдельно.</p>

        <section v-show="scenario === 'addresses'" aria-label="Общие цели А/Б">
            <template v-for="side in (['left', 'right'] as const)" :key="side"><p v-if="input.sides[side].id && !available.includes(side)" role="status">{{ side === 'left' ? 'А' : 'Б' }} · профиль недоступен или загружается; новый расчёт временно недоступен.</p></template>
            <article v-for="(place, index) in places" :key="place.id" class="goal-editor">
                <div v-if="saved.has(place)" class="goal-summary">
                    <header><h3>{{ index + 1 }}. {{ place.label }}</h3><div class="goal-summary-tools"><button :id="`edit-${place.id}`" type="button" :aria-label="`Изменить цель ${place.label}`" @click="editGoal(place, `home-goal-${place.id}`)"><Pencil :size="16" aria-hidden="true" /></button><button type="button" :aria-label="`Удалить общую цель ${place.label}`" @click="addresses.remove(place.id)"><Trash2 :size="16" aria-hidden="true" /></button></div></header>
                    <p>{{ summaryAddress(place, place.point) }}</p>
                    <p class="goal-saved-time">{{ threshold({ kind: 'trip', scenario: 'addresses', placeId: place.id, mode }) }}</p>
                </div>
                <div v-show="!saved.has(place)" class="goal-fields">
                <h3>Цель {{ index + 1 }}</h3>
                <label :for="`home-goal-${place.id}`">Название общей цели<input :id="`home-goal-${place.id}`" v-model="place.label" maxlength="80" autocomplete="off" /></label>
                <TripPointPicker compact @edit="dirty.set(place, signature(place.point))" @address-label="(label, point) => addressLabel(place, label, point)" :point="place.point" :label="`Общая цель ${index + 1} · ${place.label || 'Без названия'}`" @select="addresses.setPoint(place.id, $event); emit('focusPoint', $event)" />
                <HomeOrientationInput @valid="validate(place, $event)" :target="{ kind: 'trip', scenario: 'addresses', placeId: place.id, mode }" :label="place.label || 'Без названия'" />
                <div class="goal-point-editor">
                <button v-if="place.point" type="button" @click="addresses.setPoint(place.id, null)">Убрать точку</button></div>
                <div class="goal-save-actions"><button class="goal-save" type="button" :disabled="!canSave(place, place.point)" @click="saveGoal(place, place.id)">Сохранить</button><button type="button" :aria-label="`Удалить общую цель ${place.label}`" @click="addresses.remove(place.id)">Удалить цель</button></div>
                <p v-if="dirty.get(place) === signature(place.point)" role="status">Выберите адрес из списка или точку на карте перед сохранением.</p>
                </div>
            </article>
            <button v-if="places.length < 3" class="goal-add" type="button" @click="addGoal">Добавить цель</button>
            <div class="home-run-controls"><button class="home-run-button" type="button" :disabled="busy || !available.length || !places.length" @click="emit('run'); addresses.calculate()">Рассчитать поездки от адресов</button></div>
            <button v-if="places.length" type="button" @click="addresses.reset()">Сбросить общие цели</button>
            <p v-if="formError" role="status">{{ formError }}</p>
        </section>

        <section v-show="scenario === 'standalone'" aria-label="Отдельный произвольный старт">
            <h3>Исходный старт</h3>
            <TripPointPicker :point="standalone.readPoint(draft.start)" label="Произвольный старт" @select="emit('chooseOriginal', -1, $event); emit('focusPoint', $event)" />
            <button type="button" @click="input.activate({ kind: 'pick-start', scenario: 'standalone' }); emit('showMap', false)">Выбрать старт на карте</button>
            <article v-for="{ place, index, trip } in standalonePlaces" :key="trip.placeId" class="goal-editor">
                <div v-if="saved.has(place)" class="goal-summary">
                    <header><h3>{{ index + 1 }}. {{ place.label }}</h3><div class="goal-summary-tools"><button :id="`edit-${trip.placeId}`" type="button" :aria-label="`Изменить цель ${place.label}`" @click="editGoal(place, `home-${trip.placeId}`)"><Pencil :size="16" aria-hidden="true" /></button><button v-if="draft.places.length > 1" type="button" :aria-label="`Удалить отдельную цель ${place.label}`" @click="standalone.removePlace(index)"><Trash2 :size="16" aria-hidden="true" /></button></div></header>
                    <p>{{ summaryAddress(place, standalone.readPoint(place)) }}</p>
                    <p class="goal-saved-time">{{ threshold({ kind: 'trip', scenario: 'standalone', placeId: trip.placeId, mode }) }}</p>
                </div>
                <div v-show="!saved.has(place)" class="goal-fields">
                <h3>Цель {{ index + 1 }}</h3>
                <label :for="`home-${trip.placeId}`">Название отдельной цели<input :id="`home-${trip.placeId}`" v-model="place.label" maxlength="80" autocomplete="off" /></label>
                <TripPointPicker compact @edit="dirty.set(place, signature(standalone.readPoint(place)))" @address-label="(label, point) => addressLabel(place, label, point)" :point="standalone.readPoint(place)" :label="`Отдельная цель ${index + 1} · ${place.label || 'Без названия'}`" @select="emit('chooseOriginal', index, $event); emit('focusPoint', $event)" />
                <HomeOrientationInput @valid="validate(place, $event)" :target="{ kind: 'trip', scenario: 'standalone', placeId: trip.placeId, mode }" :label="place.label || 'Без названия'" />
                <div class="goal-save-actions"><button class="goal-save" type="button" :disabled="!canSave(place, standalone.readPoint(place))" @click="saveGoal(place, trip.placeId)">Сохранить</button><button v-if="draft.places.length > 1" type="button" :aria-label="`Удалить отдельную цель ${place.label}`" @click="standalone.removePlace(index)">Удалить цель</button></div>
                <p v-if="dirty.get(place) === signature(standalone.readPoint(place))" role="status">Выберите адрес из списка или точку на карте перед сохранением.</p>
                </div>
            </article>
            <button v-if="draft.places.length < 3" type="button" @click="addStandaloneGoal">Добавить отдельную цель</button>
            <button type="button" :disabled="busy" @click="emit('run'); standalone.submit()">Рассчитать от произвольного старта</button>
            <p v-if="standalone.formError.value" role="status">{{ standalone.formError.value }}</p>
            <p v-if="standalone.invalidLink.value" role="status">Отдельный сценарий из ссылки не восстановлен: формат, версия или размер не поддерживаются.</p>
        </section>

        <details class="home-trip-privacy"><summary>О личной ссылке и сценариях</summary><p>Цели и старт двух сценариев сохраняются отдельно. Переключение не запускает расчёт. Личная ссылка содержит читаемые точки, подписи и дорожный выбор во фрагменте и сохраняется в истории браузера. Передавайте её с учётом этого.</p></details>
    </section>
</template>
<style scoped>
.home-trips-editor{min-width:0;font-size:12px;line-height:1.5}.home-trips-editor h2{font-size:15px;font-weight:600;margin:12px 0}.home-trips-editor p{margin:7px 0;overflow-wrap:anywhere}.home-trips-editor :is(button,select,input){min-height:40px;max-width:100%;border:1px solid #dce2dc;border-radius:7px;background:#fff;padding:7px 9px}.home-trips-editor button{margin:4px 4px 4px 0;text-align:left}.home-trips-editor button:disabled{opacity:.55}.home-trips-editor :is(input,select){display:block;width:100%}.home-trips-editor summary{cursor:pointer;min-height:40px;padding-block:9px}.goal-editor{border:1px solid #dfe1dd;border-radius:9px;background:#fff;padding:14px;margin:12px 0;min-width:0;box-shadow:0 1px 2px #202a3010}.goal-editor h3{font-size:13px;font-weight:600;margin:0 0 10px;color:#7058a5}.goal-fields>label{display:block;margin-bottom:12px}.home-goals-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.home-goals-heading>span{color:#697579;font-size:11px}.home-trips-editor .goal-add{width:100%;border-style:dashed;text-align:center;color:#7058a5}.home-run-controls{background:#fff;padding:9px 0;border-top:1px solid #dce2dc;}.home-run-summary{font-size:11px}.home-trips-editor .home-run-button{width:100%;background:#7058a5;color:#fff;text-align:center;border-color:#7058a5}.home-trip-privacy{color:#626f78}.home-trips-editor :is(button,input,select,summary):focus-visible{outline:3px solid #9682be;outline-offset:2px}
.goal-summary-tools{display:flex;gap:3px}.goal-summary header{display:flex;align-items:center;justify-content:space-between;gap:8px}.goal-summary h3{margin:0;color:#35424d}.goal-summary p{margin:4px 0}.goal-saved-time{color:#7058a5}.goal-summary header button{display:grid;place-items:center;flex-shrink:0}.home-trips-editor .goal-save{background:#7058a5;color:#fff;border-color:#7058a5}.goal-save-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
</style>
