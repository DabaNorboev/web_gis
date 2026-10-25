<script setup lang="ts">
defineProps<{ width: number; min: number; max: number; controls: string }>()
const emit = defineEmits<{
    start: [event: PointerEvent]
    move: [event: PointerEvent]
    end: [event: PointerEvent]
    key: [event: KeyboardEvent]
    reset: []
}>()
</script>

<template>
    <div class="sidebar-resize-rail">
        <div class="sidebar-resize-handle" role="separator" tabindex="0" aria-label="Ширина боковой панели" aria-orientation="vertical" :aria-controls="controls" :aria-valuemin="min" :aria-valuemax="max" :aria-valuenow="width" :aria-valuetext="`${width} пикселей`" title="Перетащите границу или используйте стрелки. Двойной щелчок — исходная ширина."
            @pointerdown="emit('start', $event)" @pointermove="emit('move', $event)" @pointerup="emit('end', $event)" @pointercancel="emit('end', $event)" @lostpointercapture="emit('end', $event)" @keydown="emit('key', $event)" @dblclick="emit('reset')" />
        <button type="button" class="sidebar-width-reset" aria-label="Вернуть исходную ширину панели" title="Исходная ширина панели" @click="emit('reset')">↺</button>
    </div>
</template>
