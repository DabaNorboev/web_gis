<script setup lang="ts">
import { computed } from 'vue'
import type { useComparisonTrips } from '@/composables/useComparisonTrips'
import type { SideKey } from '@/utils/comparison'
import { coordinateLabel, snapDistance } from '@/utils/trips'
const props = defineProps<{ model: ReturnType<typeof useComparisonTrips> }>()
const { places, cell } = props.model
const keys: SideKey[] = ['left', 'right']
const names = { left: 'А', right: 'Б' }
const sources = computed(() => {
    const groups = new Map<string, { source: ReturnType<typeof cell>['source']; limitation: string; labels: string[] }>()
    for (const place of places.value) for (const side of keys) {
        const value = cell(side, place.id)
        if (!value.row) continue
        const signature = JSON.stringify([value.source, value.limitation])
        const group = groups.get(signature) ?? { source: value.source, limitation: value.limitation, labels: [] }
        group.labels.push(`${names[side]} → ${place.label || 'Без названия'}`); groups.set(signature, group)
    }
    return [...groups.values()]
})
</script>
<template>
    <section class="comparison-trip-data" aria-label="Данные автомобильных поездок">
        <h2>Автомобильные поездки</h2>
        <p>От точки каждого адреса строится отдельная поездка к каждой цели. Это не последовательное посещение мест. Обратные поездки не рассчитаны.</p>
        <p>Расстояние — по дорожной сети. Время — вычисленная оценка по статическому графу, без актуальных пробок. Подход к дороге и парковка не рассчитаны; точка адреса и дорожная привязка не подтверждают вход или въезд.</p>
        <p>Неоднозначная привязка требует выбора в своей поездке. Радиус проверки — 35 м; каждый дорожный выбор перепроверяется сервером. Пунктирный соединитель не входит в метры и секунды.</p>
        <p>При нехватке данных нет вывода о преимуществе другой стороны. Сравнивается только длина двух подтверждённых поездок одного источника и снимка.</p>
        <p>Ссылка с личными местами содержит читаемые браузером точки, подписи и дорожный выбор во фрагменте. Она хранится в истории браузера; при открытии маршруты проверяются заново.</p>
        <p v-if="!sources.length">Расчёт ещё не получен. Данные источника появятся после проверки поездок.</p>
        <details v-for="(group, index) in sources" :key="index" class="trip-source"><summary>Источник расчёта · {{ group.labels.length }} поездок</summary>
            <p>{{ group.labels.join(' · ') }}</p><p>{{ group.limitation }}</p>
            <template v-if="group.source"><p>{{ group.source.name }} · {{ group.source.engine }} {{ group.source.engine_version }} · профиль {{ group.source.profile }}.</p><p>Версия графа: {{ group.source.dataset_version }}. Дата наблюдения: {{ group.source.observed_at || 'неизвестна' }}. Актуальность неизвестна.</p><p>Подготовлено: {{ group.source.prepared_at }} (UTC). Это не дата наблюдения.</p><p>SHA-256 PBF: <code>{{ group.source.pbf_sha256 }}</code></p></template>
            <p v-else>Локальный снимок маршрутизации недоступен.</p>
        </details>
        <template v-for="place in places" :key="place.id"><template v-for="side in keys" :key="side">
            <details v-if="cell(side, place.id).row" class="trip-source"><summary>Точки и проверка · {{ names[side] }} → {{ place.label || 'Без названия' }}</summary>
                <p>Исходный старт: {{ coordinateLabel(cell(side, place.id).row!.start) }}. Исходная цель: {{ coordinateLabel(cell(side, place.id).row!.target) }}.</p>
                <p>{{ cell(side, place.id).row!.reason }}</p><p>Коды: {{ cell(side, place.id).row!.checks.join(', ') || 'нет' }}.</p>
                <template v-if="cell(side, place.id).row!.snaps"><p>Дорожный старт: {{ coordinateLabel(cell(side, place.id).row!.snaps!.start.matched) }} · смещение {{ snapDistance(cell(side, place.id).row!.snaps!.start.distance_m) }}.</p><p>Дорожная цель: {{ coordinateLabel(cell(side, place.id).row!.snaps!.target.matched) }} · смещение {{ snapDistance(cell(side, place.id).row!.snaps!.target.distance_m) }}.</p></template>
            </details>
        </template></template>
    </section>
</template>
<style scoped>
.comparison-trip-data{font-size:12px;line-height:1.6;overflow-wrap:anywhere;margin-top:24px;padding-top:16px;border-top:1px solid #cbdace}.comparison-trip-data h2{font-size:16px;font-weight:650}.comparison-trip-data p{margin:8px 0;color:#536b5c}.trip-source{padding:10px 0;border-bottom:1px solid #dce5da}.trip-source summary{cursor:pointer;min-height:36px;color:#2d6450;font-weight:600}.trip-source code{font-size:11px}summary:focus-visible{outline:3px solid #2d6450;outline-offset:2px}
</style>
