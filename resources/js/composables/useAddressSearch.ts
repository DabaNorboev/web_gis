import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { searchAddresses } from '@/api/addresses'
import type { AddressResult, AddressSearchResponse } from '@/types/address'

export function useAddressSearch() {
    const query = ref('')
    const results = shallowRef<AddressResult[]>([])
    const meta = shallowRef<AddressSearchResponse['meta'] | null>(null)
    const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
    const open = ref(false)
    const activeIndex = ref(-1)
    let controller: AbortController | undefined
    let debounce: ReturnType<typeof setTimeout> | undefined
    let generation = 0
    let committing = false

    function cancel() {
        generation++
        clearTimeout(debounce)
        controller?.abort()
        controller = undefined
    }
    async function search() {
        cancel()
        const text = query.value.trim()
        if ([...text].length < 3) return
        const version = generation
        const request = new AbortController()
        controller = request
        status.value = 'loading'
        open.value = true
        const timeout = setTimeout(() => request.abort(), 10000)
        try {
            const response = await searchAddresses(text, request.signal)
            if (version !== generation) return
            results.value = response.data
            meta.value = response.meta
            status.value = 'ready'
        } catch {
            if (version === generation) status.value = 'error'
        } finally {
            clearTimeout(timeout)
        }
    }
    watch(query, () => {
        if (committing) return
        cancel()
        results.value = []
        meta.value = null
        activeIndex.value = -1
        status.value = 'idle'
        open.value = [...query.value.trim()].length >= 3
        if (open.value) {
            status.value = 'loading'
            debounce = setTimeout(search, 300)
        }
    }, { flush: 'sync' })
    function choose(result: AddressResult) {
        cancel()
        committing = true
        query.value = result.label
        committing = false
        open.value = false
        results.value = []
        activeIndex.value = -1
        status.value = 'idle'
    }
    function clear() {
        cancel()
        query.value = ''
        results.value = []
        meta.value = null
        open.value = false
        activeIndex.value = -1
        status.value = 'idle'
    }
    function close() {
        cancel()
        open.value = false
        status.value = 'idle'
        activeIndex.value = -1
    }
    onBeforeUnmount(cancel)
    return { query, results, meta, status, open, activeIndex, search, choose, clear, close }
}
