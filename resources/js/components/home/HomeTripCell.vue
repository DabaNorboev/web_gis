<script setup lang="ts">
import { computed, inject } from 'vue'
import HomeOrientationStatus from './HomeOrientationStatus.vue'
import HomeOrientationButton from './HomeOrientationButton.vue'
import type { HomeOrientationContext } from '@/types/homeOrientations'
import HomeResultDialog from '@/components/home/HomeResultDialog.vue'
import WalkingTripDetails from '@/components/WalkingTripDetails.vue'
import { acceptedTrip } from '@/utils/comparisonTrips'
import { coordinateLabel, snapDistance, tripDistance, tripDuration } from '@/utils/trips'
import { tripFailureMessages } from '@/utils/tripFailure'
import { sameRoadPoint } from '@/utils/tripCandidates'
import type { HomeTripEntry, HomeTripActions } from '@/types/homeResults'
import type { TripMode } from '@/types/trips'
const props = defineProps<{ entry: HomeTripEntry; actions: HomeTripActions; mode: TripMode; comparisonNote?: string }>()
const context = inject<HomeOrientationContext | null>('home-orientations', null)
const target = computed(() => ({ kind: 'trip' as const, scenario: props.entry.trip.scenario, placeId: props.entry.trip.placeId, mode: props.mode }))
const orientation = computed(() => context?.enabled.value ? context.owner.find(target.value) : null)
const orientationCell = computed(() => orientation.value?.cells.find(cell => cell.side === (props.entry.trip.scenario === 'addresses' ? props.entry.trip.side : 'start')))
const status = computed(() => entryStatus())
function entryStatus() {
    if (props.entry.loading) return 'Проверяем…'
    if (props.entry.error) return 'Не удалось рассчитать'
    if (!props.entry.row) return 'Нет расчёта'
    return ({ UNKNOWN: 'Путь неизвестен', NEEDS_REFINEMENT: 'Нужно уточнение улицы', OUTSIDE_PILOT: 'За пределами пилота', NO_PATH: 'Путь не подтверждён' } as Record<string, string>)[props.entry.row.status] ?? 'Расчёт недоступен'
}
</script>
<template>
    <article :data-home-trip="JSON.stringify(entry.trip)" tabindex="-1" class="trip-result home-trip-cell" :class="{ 'home-orientation-changed': orientationCell && context?.owner.highlighted.value.includes(orientationCell.key), 'is-ready': !entry.loading && !entry.error && acceptedTrip(entry.row) }" :aria-label="entry.title" :aria-busy="entry.loading">
        <span class="sr-only">{{ entry.title }}</span>
        <div class="home-cell-top">
            <strong v-if="!entry.loading && !entry.error && acceptedTrip(entry.row)" class="home-cell-value">{{ tripDuration(entry.row!.route!.duration_s) }}</strong>
            <span v-else class="home-cell-note" role="status">{{ status }}</span>
            <HomeResultDialog :title="entry.title" :label="`Подробности поездки: ${entry.title}`"><template #default="{ close }">
                <p v-if="entry.loading">Проверяем…</p>
                <template v-else>
                    <p v-if="entry.error">{{ entry.error }}</p>
                    <template v-if="entry.row">
                        <p v-if="acceptedTrip(entry.row)">{{ tripDistance(entry.row.route!.distance_m) }} · {{ tripDuration(entry.row.route!.duration_s) }} · {{ mode === 'walking' ? 'модель уличной части' : 'модель без пробок' }}.</p>
                        <p v-else>{{ status }}</p>
                        <p>{{ entry.row.reason }} Коды: {{ entry.row.checks.join(', ') || 'нет' }}.</p>
                        <div v-for="message in tripFailureMessages(entry.row, entry.row.label)" :key="message.location">
                            <strong>{{ message.title }}</strong><p>{{ message.description }}</p>
                            <button type="button" @click="close(false); actions.act(entry.trip, message.action, message.location)">{{ message.label }}</button>
                            <button v-if="message.location === 'both_endpoints'" type="button" @click="close(false); actions.pickStreet(entry.trip, 'target')">Уточнить цель</button>
                        </div>
                        <p>Исходный старт: {{ coordinateLabel(entry.row.start) }}. Исходная цель: {{ coordinateLabel(entry.row.target) }}.</p>
                        <WalkingTripDetails v-if="mode === 'walking'" :row="entry.row" />
                        <template v-else-if="entry.row.snaps"><p>Дорожный старт: {{ coordinateLabel(entry.row.snaps.start.matched) }} · смещение {{ snapDistance(entry.row.snaps.start.distance_m) }}.</p><p>Дорожная цель: {{ coordinateLabel(entry.row.snaps.target.matched) }} · смещение {{ snapDistance(entry.row.snaps.target.distance_m) }}.</p></template>
                    </template>
                    <button type="button" :disabled="!entry.canCalculate" @click="close(); actions.retry(entry.trip)">{{ entry.row || entry.error ? 'Повторить эту поездку' : 'Рассчитать эту поездку' }}</button>
                    <button v-if="entry.row" type="button" @click="close(false); actions.show(entry.trip)">Показать маршрут</button>
                    <div v-for="end in (['start', 'target'] as const)" :key="end">
                        <button type="button" @click="close(false); actions.pickStreet(entry.trip, end)">{{ mode === 'walking' ? 'Уличная' : 'Дорожная' }} точка {{ end === 'start' ? 'старта' : 'цели' }}</button>
                        <button v-if="actions.selectedRoad(entry.trip, end)" type="button" @click="close(); actions.road(entry.trip, end, null)">Убрать выбранную точку {{ end === 'start' ? 'старта' : 'цели' }}</button>
                    </div>
                    <section v-for="group in entry.groups.filter(group => group.candidates.length)" :key="group.end">
                        <h3>{{ mode === 'walking' ? 'Уличная' : 'Дорожная' }} точка · {{ group.end === 'start' ? 'старт' : 'цель' }}</h3>
                        <p>Смещение от проверяемой точки не является расстоянием подхода. Каждый выбор перепроверяется.</p>
                        <button v-for="(candidate, index) in group.candidates" :key="`${candidate.point.lon}:${candidate.point.lat}`" type="button" :aria-pressed="sameRoadPoint(group.selected, candidate.point)" @click="close(); actions.road(entry.trip, group.end, candidate.point)">{{ mode === 'walking' ? 'Уличная' : 'Дорожная' }} {{ index + 1 }} · {{ snapDistance(candidate.distance_m) }} {{ candidate.name || '' }}</button>
                        <button type="button" @click="close(false); actions.show(entry.trip)">Варианты на карте</button>
                    </section>
                    <p v-if="comparisonNote">{{ comparisonNote }}</p>
                    <p>Подходы от объектов и доступ к входам не подтверждены.</p>
                    <p>{{ entry.limitation }}</p>
                    <template v-if="entry.source"><p>{{ entry.source.name }} · {{ entry.source.engine }} {{ entry.source.engine_version }} · {{ entry.source.profile }} · снимок {{ entry.source.dataset_version }}.</p><p>Дата наблюдения: {{ entry.source.observed_at || 'неизвестна' }}. Подготовлено: {{ entry.source.prepared_at }} (UTC) — это не дата наблюдения.</p><p>SHA-256 PBF: {{ entry.source.pbf_sha256 }}</p></template>
                    <p v-else>Снимок маршрутизации недоступен.</p>
                </template>
            </template></HomeResultDialog>
        </div>
        <div v-if="!entry.loading && !entry.error && acceptedTrip(entry.row)" class="home-cell-bottom"><span>{{ tripDistance(entry.row!.route!.distance_m) }}</span><button type="button" data-home-map-action aria-label="Показать маршрут" @click="actions.show(entry.trip)">На карте</button></div>
        <HomeOrientationStatus v-if="orientation && orientationCell && acceptedTrip(entry.row) && !entry.error && !entry.loading" :group="orientation" :cell="orientationCell" />
        <HomeOrientationButton v-if="entry.trip.scenario === 'standalone'" :target="target" :label="entry.title" />
    </article>
</template>
