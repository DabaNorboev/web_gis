import { onBeforeUnmount, ref, shallowReactive } from 'vue'
import { fetchAddressProfile } from '@/api/profiles'
import type { AddressProfile } from '@/types/profile'
import type { ComparisonSelection, SideKey } from '@/utils/comparison'

export interface ComparisonSide {
    id: string | null
    knownAddress: { id: string; label: string } | null
    profile: AddressProfile | null
    status: 'empty' | 'loading' | 'ready' | 'not_found' | 'unavailable' | 'error'
}
export function useAddressComparison(initial: ComparisonSelection, onChange: (selection: ComparisonSelection) => void) {
    const radius = ref(initial.radius === 300 ? 300 : 500)
    const sides = { left: shallowReactive<ComparisonSide>({ id: initial.left, knownAddress: null, profile: null, status: 'empty' }), right: shallowReactive<ComparisonSide>({ id: initial.right, knownAddress: null, profile: null, status: 'empty' }) }
    const requests: Partial<Record<SideKey, AbortController>> = {}
    const keys: SideKey[] = ['left', 'right']
    function selection(): ComparisonSelection { return { left: sides.left.id, right: sides.right.id, radius: radius.value } }
    async function loadSide(key: SideKey) {
        requests[key]?.abort()
        const request = new AbortController()
        requests[key] = request
        const side = sides[key]
        if (side.knownAddress?.id !== side.id) side.knownAddress = null
        side.profile = null
        side.status = side.id ? 'loading' : 'empty'
        if (!side.id) return
        const id = side.id
        const requestedRadius = radius.value
        const timeout = setTimeout(() => request.abort(), 15000)
        try {
            const profile = await fetchAddressProfile(id, requestedRadius, request.signal)
            if (requests[key] !== request) return
            if (profile.address.id !== id || profile.radius_m !== requestedRadius) throw new Error('Profile contract mismatch')
            side.profile = profile
            side.knownAddress = { id: profile.address.id, label: profile.address.label }
            side.status = 'ready'
        } catch (error) {
            if (requests[key] === request) {
                const status = error instanceof Error && 'status' in error ? Number(error.status) : 0
                side.status = status === 404 ? 'not_found' : status === 503 ? 'unavailable' : 'error'
            }
        } finally { clearTimeout(timeout) }
    }
    function restore(next: ComparisonSelection, notify = false) {
        const nextRadius = next.radius === 300 ? 300 : 500
        const changedRadius = nextRadius !== radius.value
        radius.value = nextRadius
        for (const key of keys) {
            if (sides[key].id !== next[key] || changedRadius) {
                sides[key].id = next[key]
                void loadSide(key)
            }
        }
        if (notify) onChange(selection())
    }
    function choose(key: SideKey, id: string | null) { if (sides[key].id !== id) restore({ ...selection(), [key]: id }, true) }
    function setRadius(value: number) { if ([300, 500].includes(value) && value !== radius.value) restore({ ...selection(), radius: value }, true) }
    async function load() { await Promise.allSettled(keys.map(loadSide)) }
    onBeforeUnmount(() => { for (const key of keys) { requests[key]?.abort(); delete requests[key] } })
    return { radius, sides, choose, setRadius, restore, loadSide, load }
}
