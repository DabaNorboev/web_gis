import { computed, onBeforeUnmount, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { resolvePointAddress } from '@/api/pointAddress'
import type { Coordinates } from '@/types/transport'
import type { PointAddressResponse } from '@/types/pointAddress'

/** Label-only state: never owns, changes or serializes the analysis coordinates. */
export function usePointAddress(point: MaybeRefOrGetter<Coordinates | null>) {
    const result = shallowRef<PointAddressResponse | null>(null)
    const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
    const selectedId = ref<string | null>(null)
    const selected = computed(() => result.value?.data.candidates.find(candidate => candidate.id === selectedId.value) ?? null)
    let controller: AbortController | undefined

    function clear() {
        controller?.abort()
        controller = undefined
        result.value = null
        selectedId.value = null
        status.value = 'idle'
    }
    async function retry() {
        clear()
        const current = toValue(point)
        if (!current) return
        const coordinates = { lon: current.lon, lat: current.lat }
        const request = new AbortController()
        controller = request
        status.value = 'loading'
        const timeout = setTimeout(() => request.abort(), 10000)
        try {
            const response = await resolvePointAddress(coordinates, request.signal)
            if (controller !== request) return
            result.value = response
            if (!response.data.requires_choice && response.data.candidates.length === 1) selectedId.value = response.data.candidates[0]!.id
            status.value = 'ready'
        } catch {
            if (controller === request) status.value = 'error'
        } finally {
            clearTimeout(timeout)
        }
    }
    function choose(id: string) {
        if (result.value?.data.candidates.some(candidate => candidate.id === id)) selectedId.value = id
    }
    watch(() => { const value = toValue(point); return value ? `${value.lon},${value.lat}` : null }, () => { void retry() }, { immediate: true, flush: 'sync' })
    onBeforeUnmount(clear)
    return { result, status, selected, selectedId, choose, retry }
}
