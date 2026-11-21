import { onBeforeUnmount, shallowRef, watch, type Ref } from 'vue'
import { fetchAirStationHistory } from '@/api/placeAnalysis'
import { ApiRequestError } from '@/api/errors'
import type { AirStationHistory } from '@/types/placeAnalysis'

export type AirHistoryState =
    | { phase: 'idle' | 'loading' | 'error' | 'snapshot-changed' }
    | { phase: 'ready'; history: AirStationHistory }

export function useAirStationHistory(snapshotVersion: Ref<string | null>, stationId: Ref<string | null>) {
    const state = shallowRef<AirHistoryState>({ phase: 'idle' })
    let controller: AbortController | null = null

    async function load() {
        controller?.abort()
        controller = null
        const snapshot_version = snapshotVersion.value
        const station_id = stationId.value
        if (!snapshot_version || !station_id) {
            state.value = { phase: 'idle' }
            return
        }
        const request = new AbortController()
        controller = request
        state.value = { phase: 'loading' }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    request.abort(new DOMException('Request timed out.', 'TimeoutError'))
                    reject(new ApiRequestError('timeout'))
                }, 20_000)
            })
            const history = await Promise.race([
                fetchAirStationHistory({ snapshot_version, station_id }, request.signal), timeout,
            ])
            if (controller === request) state.value = { phase: 'ready', history }
        } catch (error) {
            if (controller === request) {
                const changed = error instanceof ApiRequestError && error.status === 409 && error.code === 'AIR_SNAPSHOT_CHANGED'
                state.value = { phase: changed ? 'snapshot-changed' : 'error' }
            }
        } finally {
            clearTimeout(timer)
            if (controller === request) controller = null
        }
    }

    watch([snapshotVersion, stationId], load, { flush: 'sync' })
    onBeforeUnmount(() => {
        controller?.abort()
        controller = null
    })
    return { state, load }
}
