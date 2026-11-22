import { onBeforeUnmount, shallowRef, watch, type Ref } from 'vue'
import { ApiRequestError } from '@/api/errors'

export type AirSnapshotState<T> =
    | { phase: 'idle' | 'loading' | 'error' | 'snapshot-changed' }
    | { phase: 'ready'; data: T }

export function useAirSnapshotRequest<T>(
    snapshotVersion: Ref<string | null>,
    selection: Ref<string | null>,
    fetchSelection: (version: string, selection: string, signal: AbortSignal) => Promise<T>,
) {
    const state = shallowRef<AirSnapshotState<T>>({ phase: 'idle' })
    let controller: AbortController | null = null

    async function load() {
        controller?.abort()
        controller = null
        const version = snapshotVersion.value
        const selected = selection.value
        if (!version || !selected) {
            state.value = { phase: 'idle' }
            return
        }
        const request = new AbortController()
        controller = request
        const isCurrent = () => controller === request && snapshotVersion.value === version && selection.value === selected
        state.value = { phase: 'loading' }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    request.abort(new DOMException('Request timed out.', 'TimeoutError'))
                    reject(new ApiRequestError('timeout'))
                }, 20_000)
            })
            const data = await Promise.race([fetchSelection(version, selected, request.signal), timeout])
            if (isCurrent()) state.value = { phase: 'ready', data }
        } catch (error) {
            if (isCurrent()) {
                const changed = error instanceof ApiRequestError && error.status === 409 && error.code === 'AIR_SNAPSHOT_CHANGED'
                state.value = { phase: changed ? 'snapshot-changed' : 'error' }
            }
        } finally {
            clearTimeout(timer)
            if (controller === request) controller = null
        }
    }

    watch([snapshotVersion, selection], load)
    onBeforeUnmount(() => {
        controller?.abort()
        controller = null
    })
    return { state, load }
}
