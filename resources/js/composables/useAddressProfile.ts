import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { fetchAddressProfile } from '@/api/profiles'
import type { AddressProfile } from '@/types/profile'

export function useAddressProfile(id: string, initialRadius = 500) {
    const radius = ref(initialRadius)
    const profile = shallowRef<AddressProfile | null>(null)
    const status = ref<'loading' | 'ready' | 'not_found' | 'unavailable' | 'error'>('loading')
    let controller: AbortController | undefined

    async function load() {
        controller?.abort()
        const request = new AbortController()
        controller = request
        profile.value = null
        status.value = 'loading'
        const timeout = setTimeout(() => request.abort(), 15000)
        try {
            const result = await fetchAddressProfile(id, radius.value, request.signal)
            if (controller === request) { profile.value = result; status.value = 'ready' }
        } catch (error) {
            if (controller === request) {
                const code = error instanceof Error && 'status' in error ? Number(error.status) : 0
                status.value = code === 404 ? 'not_found' : code === 503 ? 'unavailable' : 'error'
            }
        } finally { clearTimeout(timeout) }
    }
    function setRadius(value: number) {
        if (![300, 500].includes(value) || value === radius.value) return
        radius.value = value
        void load()
    }
    onBeforeUnmount(() => { controller?.abort(); controller = undefined })
    return { radius, profile, status, load, setRadius }
}
