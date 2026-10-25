import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

// Bounds use the actual workspace width, reserving space for both the map and handle.
export function sidebarWidthBounds(workspace: number) {
    const min = 320
    const mapMin = Math.min(440, Math.floor(workspace / 2))
    return { min, max: Math.max(min, Math.min(640, Math.floor(workspace * 0.55), workspace - mapMin - 12)) }
}

export function useSidebarWidth(container: Ref<HTMLElement | null>, page: 'home' | 'profile') {
    const size = ref(0)
    const desktop = ref(false)
    const preferred = ref<number | null>(null)
    const dragging = ref(false)
    const bounds = computed(() => sidebarWidthBounds(size.value))
    const enabled = computed(() => desktop.value && size.value >= 700)
    const defaultWidth = computed(() => page === 'profile' ? 480 : size.value >= 1440 ? 400 : 360)
    const width = computed(() => Math.round(Math.max(bounds.value.min, Math.min(bounds.value.max, preferred.value ?? defaultWidth.value))))
    const style = computed(() => enabled.value ? { '--sidebar-width': `${width.value}px` } : {})
    const storageKey = `placelens:sidebar:${page}:v1`
    let observer: ResizeObserver | undefined
    let pointer: { id: number; x: number; width: number } | null = null

    function measure() {
        size.value = container.value?.getBoundingClientRect().width ?? 0
        desktop.value = window.matchMedia('(min-width: 768px)').matches
        if (!enabled.value) { pointer = null; dragging.value = false }
    }
    function persist() {
        try {
            if (preferred.value === null) window.localStorage.removeItem(storageKey)
            else window.localStorage.setItem(storageKey, String(width.value))
        } catch { /* Storage may be disabled; resizing still works for this page. */ }
    }
    function setWidth(value: number) { preferred.value = Math.max(bounds.value.min, Math.min(bounds.value.max, value)) }
    function reset() { preferred.value = null; persist() }
    function pointerDown(event: PointerEvent) {
        if (!enabled.value || event.button !== 0 || !event.isPrimary) return
        const target = event.currentTarget as HTMLElement
        target.focus()
        target.setPointerCapture(event.pointerId)
        pointer = { id: event.pointerId, x: event.clientX, width: width.value }
        dragging.value = true
        event.preventDefault()
    }
    function pointerMove(event: PointerEvent) {
        if (pointer?.id === event.pointerId) setWidth(pointer.width + event.clientX - pointer.x)
    }
    function pointerEnd(event: PointerEvent) {
        if (pointer?.id !== event.pointerId) return
        pointer = null
        dragging.value = false
        persist()
    }
    function keydown(event: KeyboardEvent) {
        if (!enabled.value) return
        const step = event.shiftKey ? 48 : 16
        if (event.key === 'ArrowLeft') setWidth(width.value - step)
        else if (event.key === 'ArrowRight') setWidth(width.value + step)
        else if (event.key === 'Home') setWidth(bounds.value.min)
        else if (event.key === 'End') setWidth(bounds.value.max)
        else return
        event.preventDefault()
        persist()
    }
    onMounted(() => {
        try {
            const stored = window.localStorage.getItem(storageKey)
            const value = stored === null ? NaN : Number(stored)
            if (Number.isFinite(value) && value > 0 && value <= 10000) preferred.value = value
        } catch { /* Use default width when browser storage is unavailable. */ }
        measure()
        observer = new ResizeObserver(measure)
        if (container.value) observer.observe(container.value)
        window.addEventListener('resize', measure)
    })
    onBeforeUnmount(() => { observer?.disconnect(); window.removeEventListener('resize', measure) })
    return { enabled, width, bounds, style, dragging, reset, pointerDown, pointerMove, pointerEnd, keydown }
}
