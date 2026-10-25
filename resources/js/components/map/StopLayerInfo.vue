<script setup lang="ts">
import { computed } from 'vue'
import type { ProfileBlock } from '@/types/profile'
import type { TransportAnalysis } from '@/types/transport'
import { formatDate } from '@/utils/metricDisplay'

const props = defineProps<{ enabled: boolean; block: ProfileBlock<TransportAnalysis> | null; loading?: boolean; selected?: boolean }>()
const data = computed(() => props.block?.status === 'READY' ? props.block.data : null)
const metric = computed(() => data.value?.metrics.stops_count)
const unavailable = computed(() => !data.value || ['UNKNOWN', 'OUTSIDE_SERVICE_AREA'].includes(data.value.coverage.status) || metric.value?.dataset_import_id == null)
</script>

<template>
    <div class="space-y-1 p-3 text-xs leading-5 text-[#637769]" aria-label="Легенда и источник слоя остановок">
        <p><span class="mr-1 inline-block size-2 rounded-full bg-[#708cad]" aria-hidden="true" /> Официальные точки остановок<span v-if="!enabled"> · слой выключен</span></p>
        <p v-if="enabled && selected"><span class="mr-1 inline-block size-2 rounded-full bg-[#c27630]" aria-hidden="true" /> Выбранная остановка</p>
        <p>Источник: <a href="https://www.24bpd.ru/opendata/2466231215-stoppingpoints/" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2">официальный набор 24bpd</a> · публикация: {{ formatDate(metric?.source_updated_at) }}.</p>
        <p>Наблюдение: {{ formatDate(metric?.observed_at) }}. Публикация не подтверждает актуальность на сегодня.</p>
        <p v-if="enabled" role="status">
            <template v-if="loading">Обновляем точки для выбранного адреса и радиуса…</template>
            <template v-else-if="unavailable">Слой недоступен. {{ block?.message ?? data?.coverage.reason ?? 'Нет результата для выбранного адреса.' }}</template>
            <template v-else-if="data?.coverage.status === 'PARTIAL'">Показаны найденные точки; радиус покрыт не полностью. {{ data.coverage.reason }}</template>
            <template v-else-if="!data?.stops_in_radius.length">В выбранном радиусе нет точек в наборе. Это не доказывает отсутствия остановок на местности.</template>
            <template v-else>Показаны точки официального набора в выбранном радиусе, без остановок OSM.</template>
        </p>
    </div>
</template>
