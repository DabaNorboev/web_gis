import { ref, shallowRef, onBeforeUnmount } from 'vue'
import { fetchTrips } from '@/api/trips'
import type { TripAnalysis, TripSelection } from '@/types/trips'

export function useTripAnalysis() {
    const analysis = shallowRef<TripAnalysis | null>(null)
    const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
    const error = ref('')
    let controller: AbortController | undefined
    let sequence = 0
    function clear(retained: TripAnalysis | null = null) {
        sequence++
        controller?.abort()
        analysis.value = retained
        status.value = 'idle'
        error.value = ''
    }
    async function analyze(selection: TripSelection, retained: TripAnalysis | null = null) {
        clear()
        analysis.value = retained
        const request = sequence
        const active = new AbortController()
        controller = active
        const timer = setTimeout(() => active.abort(), 20000)
        status.value = 'loading'
        try {
            const response = await fetchTrips(selection, active.signal)
            if (sequence !== request) return
            analysis.value = response
            status.value = 'ready'
            return response
        } catch (cause) {
            if (sequence !== request) return
            status.value = 'error'
            error.value = active.signal.aborted ? 'Расчёт занял слишком много времени. Повторите.' : cause instanceof Error ? cause.message : 'Не удалось получить результат. Повторите.'
        } finally { clearTimeout(timer) }
    }
    onBeforeUnmount(clear)
    return { analysis, status, error, clear, analyze }
}
