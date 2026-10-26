<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import type { SideKey } from '@/utils/comparison'
defineProps<{ activeSide: SideKey }>()
const root = ref<HTMLElement | null>(null)
const portion = ref(50)
const dragging = ref(false)
const width = ref(900)
const min = computed(() => Math.min(50, 300 / Math.max(600, width.value - 12) * 100))
let observer: ResizeObserver | undefined
onMounted(() => {
    observer = new ResizeObserver(() => { width.value = root.value?.clientWidth ?? 900; update(portion.value) })
    if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
function update(value: number) { portion.value = Math.max(min.value, Math.min(100 - min.value, value)) }
function pointer(event: PointerEvent) {
    if (!dragging.value || !root.value) return
    const bounds = root.value.getBoundingClientRect()
    update((event.clientX - bounds.left - 6) / (bounds.width - 12) * 100)
}
function start(event: PointerEvent) {
    dragging.value = true
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    ;(event.currentTarget as HTMLElement).focus({ preventScroll: true })
}
function key(event: KeyboardEvent) {
    const step = event.shiftKey ? 10 : 2
    if (event.key === 'ArrowLeft') update(portion.value - step)
    else if (event.key === 'ArrowRight') update(portion.value + step)
    else if (event.key === 'Home') update(min.value)
    else if (event.key === 'End') update(100 - min.value)
    else return
    event.preventDefault()
}
defineExpose({ reset: () => { portion.value = 50 } })
</script>
<template>
    <div ref="root" class="comparison-map-split" :class="{ 'is-dragging': dragging }" :data-active-side="activeSide" :style="{ '--split-ratio': portion / 100 }">
        <section class="comparison-map-pane comparison-map-pane--left" aria-label="Окрестность А"><slot name="left" /></section>
        <div class="comparison-map-divider" role="separator" aria-label="Ширина карт А и Б" aria-orientation="vertical" aria-controls="compare-map-left compare-map-right" :aria-valuenow="Math.round(portion)" :aria-valuemin="Math.ceil(min)" :aria-valuemax="Math.floor(100 - min)" :aria-valuetext="`Карта А: ${Math.round(portion)}%, карта Б: ${Math.round(100 - portion)}%`" tabindex="0" @pointerdown.prevent="start" @pointermove="pointer" @pointerup="dragging = false" @lostpointercapture="dragging = false" @keydown="key"><span aria-hidden="true">⋮</span></div>
        <section class="comparison-map-pane comparison-map-pane--right" aria-label="Окрестность Б"><slot name="right" /></section>
    </div>
</template>
<style scoped>
.comparison-map-split { display: grid; grid-template-columns: minmax(300px, calc((100% - 12px) * var(--split-ratio))) 12px minmax(300px, 1fr); min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
.comparison-map-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.comparison-map-divider { display: grid; place-items: center; cursor: col-resize; touch-action: none; color: #637769; background: #edf1e8; }
.comparison-map-divider:hover, .comparison-map-divider:focus-visible { background: #d5e2d2; outline: 2px solid #2d6450; outline-offset: -2px; }
.is-dragging { user-select: none; }
@media (max-width: 1099px) {
    .comparison-map-split { display: flex; }
    .comparison-map-pane { flex: 1; }
    .comparison-map-divider, [data-active-side='left'] .comparison-map-pane--right, [data-active-side='right'] .comparison-map-pane--left { display: none; }
}
</style>
