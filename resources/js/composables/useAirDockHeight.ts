import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

export function useAirDockHeight(workspace: Ref<HTMLElement | null>) {
    const preferred = ref(480)
    const max = ref(560)
    const min = computed(() => Math.min(220, max.value))
    const height = computed(() => Math.max(min.value, Math.min(max.value, preferred.value)))
    const dragging = ref(false)
    let observer: ResizeObserver | undefined
    let desktop = false
    let pointer: { id: number; y: number; height: number; direction: number } | null = null

    function measure() {
        const available = Math.floor(workspace.value?.clientHeight ?? 0)
        desktop = window.matchMedia('(width > 820px)').matches
        max.value = desktop
            ? Math.max(1, Math.min(560, Math.floor(available * 0.74), available - 140))
            : Math.max(1, Math.min(560, window.innerHeight - 44))
    }
    function resize(value: number) {
        preferred.value = Math.max(min.value, Math.min(max.value, value))
    }
    function pointerDown(event: PointerEvent) {
        if (event.button !== 0 || !event.isPrimary) return
        const handle = event.currentTarget as HTMLElement
        handle.focus({ preventScroll: true })
        handle.setPointerCapture(event.pointerId)
        pointer = { id: event.pointerId, y: event.clientY, height: height.value, direction: desktop ? -1 : 1 }
        dragging.value = true
        event.preventDefault()
    }
    function pointerMove(event: PointerEvent) {
        if (pointer?.id === event.pointerId) resize(pointer.height + (event.clientY - pointer.y) * pointer.direction)
    }
    function pointerEnd(event: PointerEvent) {
        if (pointer?.id !== event.pointerId) return
        pointer = null
        dragging.value = false
    }
    function keydown(event: KeyboardEvent) {
        const step = event.shiftKey ? 48 : 16
        if (event.key === 'ArrowUp') resize(height.value + step)
        else if (event.key === 'ArrowDown') resize(height.value - step)
        else if (event.key === 'Home') resize(min.value)
        else if (event.key === 'End') resize(max.value)
        else return
        event.preventDefault()
    }

    onMounted(() => {
        measure()
        observer = new ResizeObserver(measure)
        if (workspace.value) observer.observe(workspace.value)
        window.addEventListener('resize', measure)
    })
    onBeforeUnmount(() => {
        observer?.disconnect()
        window.removeEventListener('resize', measure)
    })
    return { height, min, max, dragging, pointerDown, pointerMove, pointerEnd, keydown }
}
