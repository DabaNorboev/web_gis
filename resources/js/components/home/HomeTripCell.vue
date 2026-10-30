<script setup lang="ts">
import HomeResultDialog from '@/components/home/HomeResultDialog.vue'
import WalkingTripDetails from '@/components/WalkingTripDetails.vue'
import { acceptedTrip } from '@/utils/comparisonTrips'
import { coordinateLabel, snapDistance, tripDistance, tripDuration } from '@/utils/trips'
import { tripFailureMessages } from '@/utils/tripFailure'
import { sameRoadPoint } from '@/utils/tripCandidates'
import type { HomeTripEntry, HomeTripActions } from '@/types/homeResults'
import type { TripMode } from '@/types/trips'
defineProps<{ entry: HomeTripEntry; actions: HomeTripActions; mode: TripMode }>()
</script>
<template>
    <article class="trip-result home-trip-cell" :class="{ 'is-ready': !entry.loading && !entry.error && acceptedTrip(entry.row) }" :aria-label="entry.title" :aria-busy="entry.loading">
        <span class="sr-only">{{ entry.title }}</span>
        <p v-if="entry.loading" role="status">Проверяем…</p>
        <template v-else-if="entry.error"><p role="status">{{ entry.error }}</p><button type="button" :disabled="!entry.canCalculate" @click="actions.retry(entry.trip)">Повторить эту поездку</button></template>
        <template v-else-if="acceptedTrip(entry.row)">
            <div class="home-cell-top"><strong class="home-cell-value">{{ tripDuration(entry.row!.route!.duration_s) }}</strong>
                <HomeResultDialog :title="entry.title" :label="`Подробности поездки: ${entry.title}`"><template #default="{ close }">
                    <p>{{ tripDistance(entry.row!.route!.distance_m) }} · {{ tripDuration(entry.row!.route!.duration_s) }} · {{ mode === 'walking' ? 'модель уличной части' : 'модель без пробок' }}.</p>
                    <p>Подходы от объектов и доступ к входам не подтверждены.</p>
                    <button type="button" @click="close(false); actions.show(entry.trip)">Показать маршрут</button>
                    <div v-for="end in (['start', 'target'] as const)" :key="end">
                        <button type="button" @click="close(false); actions.pickStreet(entry.trip, end)">{{ mode === 'walking' ? 'Уличная' : 'Дорожная' }} точка {{ end === 'start' ? 'старта' : 'цели' }}</button>
                        <button v-if="actions.selectedRoad(entry.trip, end)" type="button" @click="close(); actions.road(entry.trip, end, null)">Убрать выбранную точку {{ end === 'start' ? 'старта' : 'цели' }}</button>
                    </div>
                    <p>Исходный старт: {{ coordinateLabel(entry.row!.start) }}. Исходная цель: {{ coordinateLabel(entry.row!.target) }}.</p>
                    <p>{{ entry.row!.reason }} Коды: {{ entry.row!.checks.join(', ') || 'нет' }}.</p>
                    <WalkingTripDetails v-if="mode === 'walking'" :row="entry.row!" />
                    <template v-else-if="entry.row!.snaps"><p>Дорожный старт: {{ coordinateLabel(entry.row!.snaps.start.matched) }} · смещение {{ snapDistance(entry.row!.snaps.start.distance_m) }}.</p><p>Дорожная цель: {{ coordinateLabel(entry.row!.snaps.target.matched) }} · смещение {{ snapDistance(entry.row!.snaps.target.distance_m) }}.</p></template>
                    <p>{{ entry.limitation }}</p>
                    <template v-if="entry.source"><p>{{ entry.source.name }} · {{ entry.source.engine }} {{ entry.source.engine_version }} · {{ entry.source.profile }} · снимок {{ entry.source.dataset_version }}.</p><p>Дата наблюдения: {{ entry.source.observed_at || 'неизвестна' }}. Подготовлено: {{ entry.source.prepared_at }} (UTC) — это не дата наблюдения.</p><p>SHA-256 PBF: {{ entry.source.pbf_sha256 }}</p></template>
                    <p v-else>Снимок маршрутизации недоступен.</p>
                </template></HomeResultDialog>
            </div>
            <div class="home-cell-bottom"><span>{{ tripDistance(entry.row!.route!.distance_m) }}</span><button type="button" aria-label="Показать маршрут" @click="actions.show(entry.trip)">На карте</button></div>
        </template>
        <template v-else-if="entry.row">
            <p class="home-cell-note">{{ entry.row.status === 'UNKNOWN' ? 'Путь неизвестен' : entry.row.status === 'NEEDS_REFINEMENT' ? 'Нужно уточнение улицы' : entry.row.status === 'OUTSIDE_PILOT' ? 'За пределами пилота' : entry.row.status === 'NO_PATH' ? 'Путь не подтверждён' : 'Расчёт недоступен' }}. {{ entry.row.reason }}</p>
            <div v-for="message in tripFailureMessages(entry.row, entry.row.label)" :key="message.location" class="home-cell-note">
                <strong>{{ message.title }}</strong><p>{{ message.description }}</p>
                <button type="button" @click="actions.act(entry.trip, message.action, message.location)">{{ message.label }}</button>
                <button v-if="message.location === 'both_endpoints'" type="button" @click="actions.pickStreet(entry.trip, 'target')">Уточнить цель</button>
            </div>
            <p v-if="!tripFailureMessages(entry.row).length">Результат неизвестен. {{ entry.row.reason }}</p>
            <button type="button" :disabled="!entry.canCalculate" @click="actions.retry(entry.trip)">Повторить эту поездку</button>
        </template>
        <template v-else><p>Нужен расчёт этой поездки.</p><button type="button" :disabled="!entry.canCalculate" @click="actions.retry(entry.trip)">Рассчитать эту поездку</button></template>
        <details v-for="group in entry.groups.filter(group => group.candidates.length && !entry.loading)" :key="group.end" open>
            <summary>{{ mode === 'walking' ? 'Уличная' : 'Дорожная' }} точка · {{ group.end === 'start' ? 'старт' : 'цель' }}</summary>
            <p>Смещение от проверяемой точки не является расстоянием подхода. Каждый выбор перепроверяется.</p>
            <button v-for="(candidate, index) in group.candidates" :key="`${candidate.point.lon}:${candidate.point.lat}`" type="button" :aria-pressed="sameRoadPoint(group.selected, candidate.point)" @click="actions.road(entry.trip, group.end, candidate.point)">{{ mode === 'walking' ? 'Уличная' : 'Дорожная' }} {{ index + 1 }} · {{ snapDistance(candidate.distance_m) }} {{ candidate.name || '' }}</button>
            <button type="button" @click="actions.show(entry.trip)">Варианты на карте</button>
        </details>
        <details v-if="!acceptedTrip(entry.row) && !entry.loading">
            <summary>Уточнить дорожные / уличные точки</summary><p>Исходный адрес, старт и цель сохранятся. Подходы неизвестны. Новый выбор требует проверки.</p>
            <div v-for="end in (['start', 'target'] as const)" :key="end">
                <button type="button" @click="actions.pickStreet(entry.trip, end)">{{ mode === 'walking' ? 'Уличная' : 'Дорожная' }} точка {{ end === 'start' ? 'старта' : 'цели' }}</button>
                <button v-if="actions.selectedRoad(entry.trip, end)" type="button" @click="actions.road(entry.trip, end, null)">Убрать выбранную точку {{ end === 'start' ? 'старта' : 'цели' }}</button>
            </div>
        </details>
        <details v-if="entry.row && !acceptedTrip(entry.row) && !entry.loading"><summary>Точки, источник и ограничения</summary>
            <p>Исходный старт: {{ coordinateLabel(entry.row.start) }}. Исходная цель: {{ coordinateLabel(entry.row.target) }}.</p>
            <p>{{ entry.row.reason }} Коды: {{ entry.row.checks.join(', ') || 'нет' }}.</p>
            <WalkingTripDetails v-if="mode === 'walking'" :row="entry.row" />
            <p>{{ entry.limitation }}</p>
            <template v-if="entry.source"><p>{{ entry.source.name }} · {{ entry.source.engine }} {{ entry.source.engine_version }} · {{ entry.source.profile }} · снимок {{ entry.source.dataset_version }}.</p><p>Дата наблюдения: {{ entry.source.observed_at || 'неизвестна' }}. Подготовлено: {{ entry.source.prepared_at }} (UTC) — это не дата наблюдения.</p><p>SHA-256 PBF: {{ entry.source.pbf_sha256 }}</p></template>
            <p v-else>Снимок маршрутизации недоступен.</p>
        </details>
    </article>
</template>
