import { onBeforeUnmount, reactive, shallowRef } from 'vue'
import { analysisBlockKeys, fetchPlaceAnalysis, normalizeAnalysisInput } from '@/api/placeAnalysis'
import { ApiRequestError } from '@/api/errors'
import type { AnalysisBlockKey, AnalysisRequest, PlaceAnalysisInput, PlaceAnalysisResponse } from '@/types/placeAnalysis'

export interface AnalysisBlockState {
    phase: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
    response: PlaceAnalysisResponse | null
    error: ApiRequestError | null
}
const empty = (): AnalysisBlockState => ({ phase: 'idle', response: null, error: null })
function dependencies(input: AnalysisRequest, key: AnalysisBlockKey): string {
    return JSON.stringify([input.place, input.radius_m, key === 'satellite' ? input.date : null,
        key === 'air' ? [input.stations.radius_m, [...input.stations.selected_ids].sort()] : null])
}
export function usePlaceAnalysis(options: { timeoutMs?: number } = {}) {
    const input = shallowRef<AnalysisRequest | null>(null)
    const blocks = reactive<Record<AnalysisBlockKey, AnalysisBlockState>>({ poi: empty(), satellite: empty(), air: empty() })
    const map = shallowRef<PlaceAnalysisResponse | null>(null)
    const epochs = { poi: 0, satellite: 0, air: 0 }
    const controllers: Partial<Record<AnalysisBlockKey, AbortController>> = {}
    let resolvedPoint: string | null = null
    let disposed = false
    const timeoutMs = options.timeoutMs ?? 20_000

    function invalidate(key: AnalysisBlockKey) {
        epochs[key]++
        controllers[key]?.abort()
        delete controllers[key]
        Object.assign(blocks[key], empty())
    }
    function setInput(value: PlaceAnalysisInput | null) {
        const next = value === null ? null : normalizeAnalysisInput(value)
        const previous = input.value
        for (const key of analysisBlockKeys) {
            if (!previous || !next || dependencies(previous, key) !== dependencies(next, key)) invalidate(key)
        }
        if (!previous || !next || JSON.stringify([previous.place, previous.radius_m]) !== JSON.stringify([next.place, next.radius_m])) {
            map.value = null
            resolvedPoint = null
        }
        input.value = next
    }
    async function load(key: AnalysisBlockKey) {
        if (disposed || !input.value) return
        invalidate(key)
        const epoch = epochs[key]
        const snapshot = structuredClone(input.value)
        const expected = dependencies(snapshot, key)
        const current = () => !disposed && epochs[key] === epoch && input.value !== null && dependencies(input.value, key) === expected
        const controller = new AbortController()
        controllers[key] = controller
        blocks[key].phase = 'loading'
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            // Race also bounds a fetch/body reader that does not honour AbortSignal.
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort(new DOMException('Request timed out.', 'TimeoutError'))
                    reject(new ApiRequestError('timeout', null, null, null, 'Время ожидания блока истекло.'))
                }, timeoutMs)
            })
            const response = await Promise.race([fetchPlaceAnalysis({ place: snapshot.place, radius_m: snapshot.radius_m,
                ...(snapshot.date === null ? {} : { date: snapshot.date }), stations: snapshot.stations, blocks: [key] }, controller.signal), timeout])
            if (!current()) return
            const origin = JSON.stringify([response.place.point.lon, response.place.point.lat])
            if (resolvedPoint !== null && resolvedPoint !== origin) {
                // A changed resolver point cannot share a circle/results with earlier replies.
                for (const other of analysisBlockKeys) invalidate(other)
                map.value = null
                resolvedPoint = null
                blocks[key].phase = 'error'
                blocks[key].error = new ApiRequestError('invalid_response', null, 'ADDRESS_POINT_CHANGED', null, 'Точка адреса изменилась. Запустите анализ заново.')
                return
            }
            resolvedPoint = origin
            map.value = response
            const block = response.blocks[key]!
            blocks[key].response = response
            blocks[key].phase = block.status === 'READY' ? 'ready' : block.status === 'UNAVAILABLE' ? 'unavailable' : 'error'
        } catch (error) {
            if (!current()) return
            blocks[key].phase = 'error'
            blocks[key].error = error instanceof ApiRequestError ? error : new ApiRequestError('network')
        } finally {
            clearTimeout(timer)
            if (current()) delete controllers[key]
        }
    }
    function loadAll() { return Promise.all(analysisBlockKeys.map(load)) }
    function dispose() {
        disposed = true
        for (const key of analysisBlockKeys) invalidate(key)
        map.value = null
    }
    onBeforeUnmount(dispose)
    return { input, blocks, map, setInput, load, loadAll, dispose }
}
