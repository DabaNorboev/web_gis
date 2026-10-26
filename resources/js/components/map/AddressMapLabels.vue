<script setup lang="ts">
import type { ScreenLabel } from '@/utils/mapLabels'
defineProps<{ labels: ScreenLabel[]; selectedId: string | null; highlightedId?: string | null; placeLabel?: 'А' | 'Б'; multiple: boolean }>()
defineEmits<{ select: [id: string]; highlight: [id: string | null] }>()
</script>

<template>
    <div class="map-address-labels" :class="{ 'map-address-labels--b': placeLabel === 'Б', 'map-address-labels--default': !placeLabel }">
        <svg class="map-label-leaders" width="100%" height="100%" aria-hidden="true"><line v-for="label in labels" :key="label.id" :x1="label.anchorX" :y1="label.anchorY" :x2="label.x" :y2="label.y" /></svg>
        <button v-for="label in labels" :key="label.id" type="button" class="map-address-label" :class="{ 'map-address-label--caption': !multiple && !placeLabel, 'is-selected': label.id === selectedId, 'is-highlighted': label.id === highlightedId }" :data-address-id="label.id" :data-object-number="label.number" :style="{ left: !multiple && !placeLabel ? `clamp(64px, ${label.x}px, calc(100% - 64px))` : `${label.x}px`, top: `${label.y}px` }" :aria-label="multiple ? `Объект ${label.number} на карте` : placeLabel ? `Выбранный адрес ${placeLabel} на карте` : 'Выбранный адрес на карте'" :aria-pressed="label.id === selectedId" @click.stop="$emit('select', label.id)" @pointerenter="$event.pointerType !== 'touch' && $emit('highlight', label.id)" @pointerleave="$emit('highlight', null)" @focus="$emit('highlight', label.id)" @blur="$emit('highlight', null)" @keydown.esc.stop.prevent="$emit('highlight', null)">{{ multiple ? label.number : placeLabel ?? 'Выбранный адрес' }}</button>
    </div>
</template>
