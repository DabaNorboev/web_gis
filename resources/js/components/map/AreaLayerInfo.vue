<script setup lang="ts">
import type { AreaLayers, AreaVisibility } from '@/types/profile'
defineProps<{ visibility: AreaVisibility; layers: AreaLayers | null; loading: boolean }>()
const definitions = [
    { key: 'parks', label: 'Парки', color: '#247346', dashed: false },
    { key: 'vegetation', label: 'Растительные территории', color: '#879326', dashed: true },
    { key: 'water', label: 'Водные объекты', color: '#287db0', dashed: false },
] as const
function date(value: string | null) { return value ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC' }).format(new Date(value)) : 'неизвестна' }
</script>

<template>
    <div v-if="Object.values(visibility).some(Boolean)" class="space-y-2 px-4 py-3 text-xs leading-5 text-[#637769]" aria-label="Легенда слоёв OSM" aria-live="polite">
        <template v-for="layer in definitions" :key="layer.key">
            <div v-if="visibility[layer.key]">
                <p class="font-medium"><span class="mr-1 inline-block h-3 w-5 border-2 align-middle" :style="{ borderColor: layer.color, borderStyle: layer.dashed ? 'dashed' : 'solid', backgroundColor: `${layer.color}22` }" />{{ layer.label }}</p>
                <p v-if="loading">Загрузка геометрии для выбранного адреса и радиуса…</p>
                <p v-else-if="!layers || layers[layer.key].status === 'ERROR'">Геометрия слоя недоступна. Это не означает отсутствие объектов на местности.</p>
                <template v-else>
                    <p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" class="underline">© OpenStreetMap contributors · ODbL</a> · набор №{{ layers[layer.key].data!.dataset_import_id ?? '—' }} · версия источника: {{ date(layers[layer.key].data!.source_updated_at) }}; наблюдение: {{ date(layers[layer.key].data!.observed_at) }}.</p>
                    <p v-if="layers[layer.key].data!.quality.availability === 'UNAVAILABLE'">Геометрия недоступна: {{ layers[layer.key].data!.coverage.reason }}</p>
                    <template v-else>
                        <p v-if="layers[layer.key].data!.coverage.status !== 'COVERED'">Частичное покрытие: показаны только фрагменты в области данных.</p>
                        <p v-if="!layers[layer.key].data!.features.length">В выбранном снимке и области не найдены контуры. Это не доказывает отсутствие объектов на местности.</p>
                    </template>
                </template>
            </div>
        </template>
        <p>Контуры обрезаны радиусом и областью данных. Полнота и актуальность OSM не гарантируются. Парк и растительность — независимые признаки; пересечения сохранены. Контуры не подтверждают доступ или вход.</p>
    </div>
</template>
