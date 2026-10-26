<script setup lang="ts">
import type { LinearLayers, LinearVisibility } from '@/types/profile'
defineProps<{ visibility: LinearVisibility; layers: LinearLayers | null; loading: boolean }>()
const definitions = [
    { key: 'roads', label: 'Крупные дороги', color: '#b45d17', dashed: false },
    { key: 'railways', label: 'Железнодорожные линии', color: '#68427f', dashed: true },
] as const
function date(value: string | null) { return value ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC' }).format(new Date(value)) : 'неизвестна' }
</script>

<template>
    <div v-if="Object.values(visibility).some(Boolean)" class="space-y-2 px-4 py-3 text-xs leading-5 text-[#637769]" aria-label="Легенда линейных слоёв OSM" aria-live="polite">
        <template v-for="layer in definitions" :key="layer.key">
            <div v-if="visibility[layer.key]">
                <p class="font-medium"><span class="mr-1 inline-block w-6 border-t-[3px] align-middle" :style="{ borderColor: layer.color, borderStyle: layer.dashed ? 'dashed' : 'solid' }" />{{ layer.label }}</p>
                <p v-if="loading">Загрузка линий для выбранного адреса и радиуса…</p>
                <p v-else-if="!layers || layers[layer.key].status === 'ERROR'">Линии слоя недоступны. Это не означает отсутствие объектов на местности.</p>
                <template v-else>
                    <p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" class="underline">© OpenStreetMap contributors · ODbL</a> · набор №{{ layers[layer.key].data!.dataset_import_id ?? '—' }} · версия источника: {{ date(layers[layer.key].data!.source_updated_at) }}; наблюдение: {{ date(layers[layer.key].data!.observed_at) }}.</p>
                    <p v-if="layers[layer.key].data!.quality.availability === 'UNAVAILABLE'">Линии недоступны: {{ layers[layer.key].data!.coverage.reason }}</p>
                    <template v-else>
                        <p v-if="layers[layer.key].data!.coverage.status !== 'COVERED'">Частичное покрытие: показаны только фрагменты в области данных.</p>
                        <p v-if="!layers[layer.key].data!.features.length">В выбранном снимке и области не найдены линии. Это не доказывает отсутствие объектов на местности.</p>
                    </template>
                </template>
            </div>
        </template>
        <p>Дороги: motorway/trunk/primary/secondary. Пути: rail/narrow_gauge, без трамвая. Показаны фрагменты в радиусе; полнота и актуальность OSM неизвестны. Линии не подтверждают движение или соединение в местах пересечений.</p>
    </div>
</template>
