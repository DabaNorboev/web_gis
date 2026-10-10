import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { fetchTransportAnalysis } from '@/api/transport'
import type { Coordinates, TransportAnalysis } from '@/types/transport'

export function useTransportAnalysis() {
    const point = ref<Coordinates | null>(null)
    const analysis = shallowRef<TransportAnalysis | null>(null)
    const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
    let controller: AbortController | undefined

    async function selectPoint(coordinates: Coordinates) {
        controller?.abort()
        const request = new AbortController()
        controller = request
        point.value = coordinates
        analysis.value = null
        status.value = 'loading'
        const timeout = setTimeout(() => request.abort(), 15000)
        try {
            const result = await fetchTransportAnalysis(coordinates, request.signal)
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

    function reset() {
        controller?.abort()
        controller = undefined
        point.value = null
        analysis.value = null
        status.value = 'idle'
    }

    onBeforeUnmount(reset)
    return { point, analysis, status, selectPoint, reset }
}
