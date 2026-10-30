<script setup lang="ts">
import { computed } from 'vue'
import TripPointPicker from '@/components/TripPointPicker.vue'
import { homeStandaloneTrip } from '@/composables/useHomeTrips'
import type { HomeTripRef, HomeTripsInput, HomeTripsPort } from '@/types/homeWorkspace'
import type { Coordinates } from '@/types/transport'
const props = defineProps<{ model: HomeTripsPort; input: HomeTripsInput; scenario: 'addresses' | 'standalone'; available: ('left' | 'right')[]; busy: boolean; picking: boolean }>()
const emit = defineEmits<{ changeMode: [event: Event]; pickGoal: [trip: HomeTripRef]; chooseOriginal: [index: number, point: Coordinates]; showMap: [focus: boolean]; run: [] }>()
const { addresses, standalone } = props.model
const { mode, places, formError } = addresses
const { draft } = standalone
const standalonePlaces = computed(() => draft.places.map((place, index) => ({ place, index, trip: homeStandaloneTrip(props.model, index)! })))
</script>
<template>
    <section class="home-trips-editor" aria-label="Редактор поездок">
        <h2>{{ scenario === 'addresses' ? 'Общие цели А/Б' : 'Отдельная поездка' }}</h2>
        <label for="home-trip-mode">Общий режим поездок
            <select id="home-trip-mode" :value="mode" @change="emit('changeMode', $event)"><option value="driving">Автомобиль</option><option value="walking">Пешком</option></select>
        </label>
        <p v-if="mode === 'walking'">Пеший пилот: только уличная часть между явно выбранными точками. Полный путь между объектами, расстояние и время подходов неизвестны. Время — статическая модель.</p>
        <p v-else>По дорожной сети · модельное время без пробок. Подход, парковка и доступ к входам не рассчитаны.</p>
        <p v-if="picking" role="status">Выберите точку на общей карте. Исходные объекты и выбранные улицы хранятся отдельно.</p>

        <section v-show="scenario === 'addresses'" aria-label="Общие цели А/Б">
            <template v-for="side in (['left', 'right'] as const)" :key="side"><p v-if="input.sides[side].id && !available.includes(side)" role="status">{{ side === 'left' ? 'А' : 'Б' }} · профиль недоступен или загружается; новый расчёт временно недоступен.</p></template>
            <button v-if="places.length < 3" type="button" @click="addresses.add()">Добавить общую цель</button>
            <p>{{ places.length }}/3 общих целей. От каждого доступного выбранного адреса — отдельная поездка.</p>
            <article v-for="(place, index) in places" :key="place.id" class="goal-editor">
                <label :for="`home-goal-${place.id}`">Название общей цели<input :id="`home-goal-${place.id}`" v-model="place.label" maxlength="80" autocomplete="off" /></label>
                <details class="goal-point-editor"><summary>{{ place.point ? 'Изменить точку цели' : 'Задать точку цели' }}</summary><TripPointPicker :point="place.point" :label="`Общая цель ${index + 1} · ${place.label || 'Без названия'}`" @select="addresses.setPoint(place.id, $event)" />
                <button type="button" @click="emit('pickGoal', { scenario: 'addresses', side: input.activeSide.value, placeId: place.id })">Выбрать цель на карте</button>
                <button v-if="place.point" type="button" @click="addresses.setPoint(place.id, null)">Убрать точку</button></details>
                <button type="button" :aria-label="`Удалить общую цель ${place.label}`" @click="addresses.remove(place.id)">Удалить цель</button>
            </article>
            <div class="home-run-controls"><p class="home-run-summary">{{ mode === 'walking' ? 'Пешком · уличная часть' : 'Автомобиль · без пробок' }} · {{ available.length }} адрес(а) · {{ places.length }}/3 целей</p><button class="home-run-button" type="button" :disabled="busy || !available.length || !places.length" @click="emit('run'); addresses.calculate()">Рассчитать поездки от адресов</button></div>
            <button v-if="places.length" type="button" @click="addresses.reset()">Сбросить общие цели</button>
            <p v-if="formError" role="status">{{ formError }}</p>
        </section>

        <section v-show="scenario === 'standalone'" aria-label="Отдельный произвольный старт">
            <h3>Исходный старт</h3>
            <TripPointPicker :point="standalone.readPoint(draft.start)" label="Произвольный старт" @select="emit('chooseOriginal', -1, $event)" />
            <button type="button" @click="input.activate({ kind: 'pick-start', scenario: 'standalone' }); emit('showMap', false)">Выбрать старт на карте</button>
            <article v-for="{ place, index, trip } in standalonePlaces" :key="trip.placeId" class="goal-editor">
                <label :for="`home-${trip.placeId}`">Название отдельной цели<input :id="`home-${trip.placeId}`" v-model="place.label" maxlength="80" autocomplete="off" /></label>
                <TripPointPicker :point="standalone.readPoint(place)" :label="`Отдельная цель ${index + 1} · ${place.label || 'Без названия'}`" @select="emit('chooseOriginal', index, $event)" />
                <button type="button" @click="emit('pickGoal', trip)">Выбрать отдельную цель на карте</button>
                <button v-if="draft.places.length > 1" type="button" :aria-label="`Удалить отдельную цель ${place.label}`" @click="standalone.removePlace(index)">Удалить цель</button>
            </article>
            <button v-if="draft.places.length < 3" type="button" @click="standalone.addPlace()">Добавить отдельную цель</button>
            <button type="button" :disabled="busy" @click="emit('run'); standalone.submit()">Рассчитать от произвольного старта</button>
            <p v-if="standalone.formError.value" role="status">{{ standalone.formError.value }}</p>
            <p v-if="standalone.invalidLink.value" role="status">Отдельный сценарий из ссылки не восстановлен: формат, версия или размер не поддерживаются.</p>
        </section>

        <details class="home-trip-privacy"><summary>О личной ссылке и сценариях</summary><p>Цели и старт двух сценариев сохраняются отдельно. Переключение не запускает расчёт. Личная ссылка содержит читаемые точки, подписи и дорожный выбор во фрагменте и сохраняется в истории браузера. Передавайте её с учётом этого.</p></details>
    </section>
</template>
<style scoped>
.home-trips-editor{min-width:0;font-size:12px;line-height:1.5}.home-trips-editor h2{font-size:15px;font-weight:600;margin:12px 0}.home-trips-editor p{margin:7px 0;overflow-wrap:anywhere}.home-trips-editor :is(button,select,input){min-height:40px;max-width:100%;border:1px solid #dce2dc;border-radius:7px;background:#fff;padding:7px 9px}.home-trips-editor button{margin:4px 4px 4px 0;text-align:left}.home-trips-editor button:disabled{opacity:.55}.home-trips-editor :is(input,select){display:block;width:100%}.home-trips-editor summary{cursor:pointer;min-height:40px;padding-block:9px}.goal-editor{border-bottom:1px solid #dce2dc;padding:10px 0;min-width:0}.home-run-controls{position:sticky;bottom:-16px;background:#fff;padding:9px 0;border-top:1px solid #dce2dc;z-index:2}.home-run-summary{font-size:11px}.home-trips-editor .home-run-button{width:100%;background:#7058a5;color:#fff;text-align:center;border-color:#7058a5}.home-trip-privacy{color:#626f78}.home-trips-editor :is(button,input,select,summary):focus-visible{outline:3px solid #9682be;outline-offset:2px}
</style>
