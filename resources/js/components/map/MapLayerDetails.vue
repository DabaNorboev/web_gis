<script setup lang="ts">
import { computed } from 'vue'
import AreaLayerInfo from './AreaLayerInfo.vue'
import LinearLayerInfo from './LinearLayerInfo.vue'
import StopLayerInfo from './StopLayerInfo.vue'
import type { MapLayerContext, MapLayerKey } from '@/types/mapLayers'

const props = defineProps<{ layer: MapLayerKey; context: MapLayerContext; enabled: boolean }>()
const areas = computed(() => ({ parks: props.layer === 'parks', vegetation: props.layer === 'vegetation', water: props.layer === 'water' }))
const lines = computed(() => ({ roads: props.layer === 'roads', railways: props.layer === 'railways' }))
</script>

<template>
    <section class="layer-data-context" :aria-label="context.label">
        <h3>{{ context.label }}</h3>
        <p v-if="!enabled" class="px-3 pt-2 text-xs leading-5 text-[#637769]">Слой выключен на карте. Ниже — сведения о наборе для выбранного адреса и радиуса.</p>
        <StopLayerInfo v-if="layer === 'stops'" :enabled="enabled" :block="context.profile?.blocks.transport ?? null" :loading="context.loading" :selected="context.selectedStop" />
        <LinearLayerInfo v-else-if="layer === 'roads' || layer === 'railways'" :visibility="lines" :layers="context.profile?.map.linear_layers ?? null" :loading="context.loading" />
        <AreaLayerInfo v-else :visibility="areas" :layers="context.profile?.map.area_layers ?? null" :loading="context.loading" />
    </section>
</template>
