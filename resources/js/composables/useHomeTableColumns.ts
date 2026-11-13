import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

// Adjacent columns share a boundary; resizing never changes side ownership.
export function useHomeTableColumns(table: Ref<HTMLTableElement | null>, count: Ref<number>) {
    const width = ref(900)
    const sizes = ref<number[]>([])
    const minimum = computed(() => width.value < 600 ? 28 : 12)
    const maximum = (index: number) => (sizes.value[index] ?? 0) + (sizes.value[index + 1] ?? 0) - minimum.value
    function reset() {
        const first = width.value < 600 ? 34 : count.value === 2 ? 25 : 17
        sizes.value = [first, ...Array(count.value - 1).fill((100 - first) / (count.value - 1))]
    }
    function constrain() {
        if (sizes.value.length !== count.value) return reset()
        const next = sizes.value.map(value => Math.max(minimum.value, value))
        let excess = next.reduce((sum, value) => sum + value, 0) - 100
        for (let i = next.length - 1; i >= 0 && excess > 0; i--) {
            const delta = Math.min(excess, next[i]! - minimum.value)
            next[i]! -= delta; excess -= delta
        }
        sizes.value = next
    }
    function move(index: number, value: number) {
        const pair = sizes.value[index]! + sizes.value[index + 1]!
        const next = Math.max(minimum.value, Math.min(pair - minimum.value, value))
        sizes.value[index + 1] = pair - next
        sizes.value[index] = next
    }
    function key(event: KeyboardEvent, index: number) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        if (event.key === 'Escape') return reset()
        const step = event.shiftKey ? 5 : 1
        move(index, event.key === 'Home' ? minimum.value : event.key === 'End' ? 100 : sizes.value[index]! + (event.key === 'ArrowRight' ? step : -step))
    }
    function pointer(event: PointerEvent, index: number) {
        if (event.button !== 0) return
        event.preventDefault()
        const handle = event.currentTarget as HTMLElement
        const start = event.clientX, initial = sizes.value[index]!
        handle.setPointerCapture(event.pointerId)
        const update = (e: PointerEvent) => move(index, initial + (e.clientX - start) / width.value * 100)
        const stop = () => {
            handle.removeEventListener('pointermove', update)
            handle.removeEventListener('lostpointercapture', stop)
            handle.removeEventListener('pointerup', release)
            handle.removeEventListener('pointercancel', release)
        }
        const release = () => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); stop() }
        handle.addEventListener('pointermove', update)
        handle.addEventListener('lostpointercapture', stop)
        handle.addEventListener('pointerup', release)
        handle.addEventListener('pointercancel', release)
    }
    let observer: ResizeObserver | undefined
    watch(count, reset, { immediate: true })
    watch(table, element => {
        observer?.disconnect()
        if (!element) return
        observer = new ResizeObserver(entries => {
            const previous = width.value < 600
            width.value = entries[0]!.contentRect.width
            if (previous !== (width.value < 600)) reset()
            else constrain()
        })
        observer.observe(element)
    })
    onBeforeUnmount(() => observer?.disconnect())
    return { sizes, minimum, maximum, reset, key, pointer }
}
