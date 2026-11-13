import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { usePointAddress } from '@/composables/usePointAddress'
import { resolveAddress } from '@/api/searchProfiles'
import type { AnalysisAddress, AnalysisPoint } from '@/types/placeAnalysis'
import type { PointAddressCandidate, PointAddressResponse } from '@/types/pointAddress'

// The existing service's finite method: source geometry, 100m, 1m ambiguity tolerance.
// Never turn an arbitrary/malformed label into a claim of nearestness or address identity.
function referenceCandidates(response: PointAddressResponse | null): PointAddressCandidate[] {
    if (!response || !response.data || !response.meta || response.meta.nearby_radius_m !== 100
        || response.meta.source !== 'OpenStreetMap' || !Number.isSafeInteger(response.meta.dataset_import_id) || Number(response.meta.dataset_import_id) <= 0
        || response.meta.quality?.availability !== 'AVAILABLE'
        || !['COVERED', 'PARTIAL', 'UNKNOWN'].includes(response.meta.coverage?.status)
        || !['CONTAINING', 'NEARBY'].includes(response.data.match) || !Array.isArray(response.data.candidates)) return []
    const candidates = response.data.candidates
    const containing = response.data.match === 'CONTAINING'
    if (!candidates.length || response.data.requires_choice !== (candidates.length > 1)
        || response.meta.quality.method !== (containing ? 'DERIVED' : 'PROXY')
        || candidates.some(c => !c || typeof c.id !== 'string' || !/^osm:(node|way|relation):[1-9][0-9]{0,18}$/.test(c.id)
            || typeof c.label !== 'string' || !c.label.trim() || !['building', 'address_point', 'address_area'].includes(c.object_type)
            || !['POINT', 'POLYGON', 'MULTIPOLYGON'].includes(c.geometry_type)
            || typeof c.distance_m !== 'number' || !Number.isFinite(c.distance_m) || c.distance_m < 0 || c.distance_m > 100
            || containing && c.distance_m !== 0)
        || new Set(candidates.map(c => c.id)).size !== candidates.length) return []
    const minimum = Math.min(...candidates.map(c => c.distance_m))
    return candidates.every(c => c.distance_m <= minimum + 1) ? candidates : []
}

export function useAnalysisPointAddress(point: MaybeRefOrGetter<AnalysisPoint | null>, onAddress: (address: AnalysisAddress) => void) {
    const reference = usePointAddress(point)
    const candidates = computed(() => reference.status.value === 'ready' ? referenceCandidates(reference.result.value) : [])
    const transitionPending = ref(false)
    const transitionError = ref(false)
    let epoch = 0
    let controller: AbortController | null = null
    const pointKey = () => { const p = toValue(point); return p ? `${p.lon},${p.lat}` : null }
    function resetTransition() {
        epoch++
        controller?.abort()
        controller = null
        transitionPending.value = false
        transitionError.value = false
    }
    watch(pointKey, resetTransition, { flush: 'sync' })
    onBeforeUnmount(resetTransition)

    async function analyzeAddress(id: string) {
        if (transitionPending.value || !candidates.value.some(c => c.id === id)) return
        resetTransition()
        const token = epoch, key = pointKey()
        const current = () => token === epoch && key !== null && pointKey() === key
        const request = new AbortController()
        controller = request
        transitionPending.value = true
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
            const expired = new Promise<never>((_, reject) => {
                timeout = setTimeout(() => { request.abort(); reject(new Error('Resolver timeout.')) }, 10_000)
            })
            // Resolver, not the reference label, supplies the address's real analysis point.
            const resolved = await Promise.race([resolveAddress(id, request.signal), expired])
            if (current()) onAddress(resolved.address)
        } catch {
            if (current()) transitionError.value = true
        } finally {
            clearTimeout(timeout)
            if (current()) { transitionPending.value = false; controller = null }
        }
    }
    function retry() { resetTransition(); void reference.retry() }
    return { candidates, status: reference.status, result: reference.result, transitionPending, transitionError, analyzeAddress, retry }
}
