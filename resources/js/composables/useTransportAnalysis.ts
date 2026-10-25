import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { fetchTransportAnalysis } from '@/api/transport'
import type { Coordinates, TransportAnalysis } from '@/types/transport'
import type { PointSelection } from '@/utils/pointSelection'

export function useTransportAnalysis(onChange: (selection: PointSelection) => void = () => {}) {
    const radius = ref(500)
    const selectedStopId = ref<number | null>(null)
    const point = ref<Coordinates | null>(null)
    const analysis = shallowRef<TransportAnalysis | null>(null)
    const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
    let controller: AbortController | undefined

    function selection(): PointSelection { return { point: point.value, radius: radius.value } }
    async function selectPoint(coordinates: Coordinates, notify = true) {
        const changed = point.value?.lon !== coordinates.lon || point.value?.lat !== coordinates.lat
        controller?.abort()
        const request = new AbortController()
        controller = request
        selectedStopId.value = null
        point.value = coordinates
        analysis.value = null
        status.value = 'loading'
        if (notify && changed) onChange(selection())
        const timeout = setTimeout(() => request.abort(), 15000)
        try {
            const result = await fetchTransportAnalysis(coordinates, radius.value, request.signal)
            if (controller === request) {
                analysis.value = result
                status.value = 'ready'
            }
        } catch {
            if (controller === request) status.value = 'error'
        } finally {
            clearTimeout(timeout)
        }
    }

    function setRadius(value: number) {
        if (![300, 500].includes(value) || value === radius.value) return
        radius.value = value
        onChange(selection())
        if (point.value) void selectPoint(point.value, false)
    }

    function reset(notify = true) {
        const hadPoint = point.value !== null
        selectedStopId.value = null
        controller?.abort()
        controller = undefined
        point.value = null
        analysis.value = null
        status.value = 'idle'
        if (notify && hadPoint) onChange(selection())
    }
    function restore(next: PointSelection) {
        const nextRadius = next.radius === 300 ? 300 : 500
        const changed = radius.value !== nextRadius || point.value?.lon !== next.point?.lon || point.value?.lat !== next.point?.lat
        radius.value = nextRadius
        if (!changed) return
        if (next.point) void selectPoint(next.point, false)
        else reset(false)
    }
    onBeforeUnmount(() => reset(false))
    return { point, analysis, status, radius, selectedStopId, setRadius, selectPoint, reset, restore }
}
