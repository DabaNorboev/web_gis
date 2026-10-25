<script setup lang="ts">
import { useId } from 'vue'
import { usePointAddress } from '@/composables/usePointAddress'
import type { Coordinates } from '@/types/transport'
import type { PointAddressCandidate } from '@/types/pointAddress'

const props = defineProps<{ point: Coordinates }>()
const { result, status, selected, selectedId, choose, retry } = usePointAddress(() => props.point)
const id = useId()
function distance(value: number) {
    return value > 0 && value < 1 ? 'менее 1 м' : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)} м`
}
function kind(candidate: PointAddressCandidate) {
    return { building: 'здание', address_point: 'адресная точка', address_area: 'адресная территория' }[candidate.object_type]
}
function date(value: string | null) {
    return value ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC' }).format(new Date(value)) : 'неизвестна'
}
</script>

<template>
    <section class="point-address rounded-md border border-[#dce5df] p-3 text-sm" :aria-labelledby="`${id}-title`" :aria-busy="status === 'loading'">
        <h2 :id="`${id}-title`" class="font-semibold break-words">
            <template v-if="selected">{{ result?.data.match === 'NEARBY' ? 'Рядом с ' : '' }}{{ selected.label }}</template>
            <template v-else>Точка анализа</template>
        </h2>
        <div role="status" aria-live="polite" class="mt-1 text-xs leading-5 text-[#637769]">
            <p v-if="status === 'loading'">Определяем адрес по локальным данным…</p>
            <p v-else-if="status === 'error'">Не удалось определить подпись. Точка анализа сохранена; поиск остановок работает отдельно.</p>
            <template v-else-if="result">
                <p v-if="result.data.match === 'NONE'">{{ result.meta.quality.availability === 'UNAVAILABLE' ? 'Адресные данные недоступны.' : 'Подходящих адресных данных нет.' }} Точка анализа сохранена.</p>
                <p v-else-if="result.data.requires_choice && !selected">{{ result.data.match === 'CONTAINING' ? 'В точке несколько подходящих адресных объектов.' : 'Рядом несколько одинаково близких адресных объектов.' }} Выберите подпись.</p>
                <p v-if="selected && result.data.match === 'CONTAINING'">{{ selected.geometry_type === 'POINT' ? 'Совпадает с адресной точкой OSM.' : 'Внутри или на границе адресного контура OSM.' }}</p>
                <p v-if="selected && result.data.match === 'NEARBY'">{{ distance(selected.distance_m) }} по прямой до {{ selected.geometry_type === 'POINT' ? 'адресной точки' : 'контура' }}. Точный адрес выбранной точки не установлен.</p>
            </template>
        </div>
        <button v-if="status === 'error' || result?.meta.quality.availability === 'UNAVAILABLE'" type="button" class="result-action mt-2" @click="retry">Повторить определение адреса</button>
        <fieldset v-if="result?.data.requires_choice" class="mt-2 min-w-0">
            <legend class="text-xs font-medium">Подпись точки (координаты не изменятся)</legend>
            <label v-for="candidate in result.data.candidates" :key="candidate.id" class="mt-2 flex cursor-pointer items-start gap-2 rounded border p-2">
                <input type="radio" :name="`${id}-candidate`" :value="candidate.id" :checked="selectedId === candidate.id" class="mt-1 shrink-0" @change="choose(candidate.id)" />
                <span class="min-w-0 break-words">{{ result.data.match === 'NEARBY' ? 'Рядом с ' : '' }}{{ candidate.label }}<span class="block text-xs text-[#637769]">{{ kind(candidate) }} · {{ candidate.id }}<template v-if="result.data.match === 'NEARBY'"> · {{ distance(candidate.distance_m) }} по прямой</template></span></span>
            </label>
        </fieldset>
        <p class="mt-2 text-xs leading-5 text-[#637769]">Анализ остаётся в выбранных координатах. Вход и разрешённый доступ не определены.</p>
        <details v-if="result" class="mt-2 text-xs leading-5 text-[#637769]">
            <summary class="cursor-pointer">Источник и точность подписи</summary>
            <p>{{ result.meta.source }} · снимок {{ result.meta.dataset_import_id ?? 'отсутствует' }}. Дата наблюдения: {{ date(result.meta.observed_at) }}. Актуальность: {{ result.meta.quality.freshness === 'UNKNOWN' ? 'неизвестна' : result.meta.quality.freshness }}.</p>
            <p>Дата базы источника: {{ date(result.meta.source_updated_at) }} (не дата наблюдения). {{ result.meta.quality.reason }}</p>
            <p>{{ result.meta.coverage.reason }}</p>
        </details>
    </section>
</template>
