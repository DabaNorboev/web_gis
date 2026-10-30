import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { HomeWorkspace } from '@/composables/useHomeWorkspace'
import type { HomeTripsPort } from '@/types/homeWorkspace'
import type { HomeSelection } from '@/utils/homeSelection'
import { homeSelectionUrl, parseHomeSelection } from '@/utils/homeSelection'
import { comparisonTripsFragment, parseComparisonTrips, type ComparisonTripLink } from '@/utils/comparisonTrips'
import { parseTripLink, tripUrl } from '@/utils/trips'
import type { TripSelection } from '@/types/trips'
import type { SideKey } from '@/utils/comparison'

/** The root's only history writer. Private scenarios retain their existing fragment formats. */
export function useHomeLocation(home: HomeWorkspace, trips: HomeTripsPort, restored: (scenario: 'addresses' | 'standalone' | null) => void) {
    const invalidPointLink = ref(false), invalidPersonalLink = ref(false)
    const savedStandalone = ref<TripSelection | null>(null)
    const pending = new Map<SideKey, string>()
    let restoring = false, disposed = false, locationKey = '', addressSignature = '', standaloneSignature = ''
    let standaloneRunMaySave = true, standaloneIncluded = false
    const fragment = () => {
        const params = new URLSearchParams()
        const shared = trips.addresses.linkSelection.value
        if (shared) params.set('places', new URLSearchParams(comparisonTripsFragment(shared).slice(1)).get('places')!)
        if (savedStandalone.value) params.set('trip', new URLSearchParams(tripUrl(savedStandalone.value).split('#')[1]).get('trip')!)
        return params.size ? '#' + params : ''
    }
    const ordinaryUrl = computed(() => new URL(homeSelectionUrl({ ...home.selection(), point: null, context: 'profile' }), window.location.origin).href)
    const personalUrl = computed(() => fragment() ? new URL(homeSelectionUrl(home.selection()) + fragment(), window.location.origin).href : null)
    function remember() {
        locationKey = window.location.search + '|' + window.location.hash
        const params = new URLSearchParams(window.location.hash.slice(1))
        addressSignature = params.get('places') ?? ''; standaloneSignature = params.get('trip') ?? ''
    }
    function write(mode: 'push' | 'replace', selection = home.selection()) {
        if (restoring || disposed) return
        const url = homeSelectionUrl(selection, window.location.search) + fragment()
        const next = new URL(url, window.location.origin), current = new URL(window.location.href)
        next.searchParams.sort(); current.searchParams.sort()
        if (next.href !== current.href) window.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url)
        remember()
    }
    function saveHome(selection: HomeSelection) { invalidPointLink.value = false; write('push', selection) }
    function saveAddressTrips(_value: ComparisonTripLink | null, mode: 'push' | 'replace') {
        if (restoring) return
        pending.clear(); invalidPersonalLink.value = false; write(mode)
    }
    function saveStandalone(value: TripSelection, mode: 'push' | 'replace') {
        if (restoring || mode === 'replace' && !standaloneRunMaySave) return
        standaloneIncluded = true; savedStandalone.value = value; write(mode)
    }
    function beginStandaloneRun() { standaloneRunMaySave = !restoring }
    function tryPending() {
        if (disposed) return
        for (const [side, id] of pending) {
            const value = home.sides[side]
            if (value.id !== id) { pending.delete(side); continue }
            if (value.id && value.status === 'ready' && value.profile?.address.id === value.id && trips.addresses.starts[side].point) {
                pending.delete(side); void trips.addresses.calculate(side)
            }
        }
    }
    for (const side of ['left', 'right'] as const) watch(() => [home.sides[side].status, home.sides[side].profile, trips.addresses.starts[side].point], tryPending, { flush: 'post' })
    watch(trips.addresses.mode, () => pending.clear(), { flush: 'sync' })
    // Once explicitly shared/calculated, draft edits keep that fragment current.
    // Accepted engine hints alone are handled by saveStandalone(replace), so a
    // restored run cannot echo its response back into history.
    watch(() => JSON.stringify({ mode: trips.standalone.mode.value, start: [trips.standalone.draft.start.lon, trips.standalone.draft.start.lat],
        places: trips.standalone.draft.places.map(p => [p.lon, p.lat, p.label]) }), (value, previous) => {
        if (restoring || !standaloneIncluded) return
        savedStandalone.value = trips.standalone.selection()
        const geometry = (key: string) => { const value = JSON.parse(key); value.places = value.places.map((p: unknown[]) => p.slice(0, 2)); return JSON.stringify(value) }
        write(geometry(value) === geometry(previous) ? 'replace' : 'push')
    })
    async function restore() {
        const key = window.location.search + '|' + window.location.hash
        if (key === locationKey) return
        restoring = true; pending.clear()
        const params = new URLSearchParams(window.location.hash.slice(1))
        const shared = parseComparisonTrips(window.location.hash), standalone = parseTripLink(window.location.hash)
        const next = parseHomeSelection(window.location.search)
        const changed = (['left', 'right'] as const).filter(side => home.sides[side].id !== next[side])
        const sharedChanged = (params.get('places') ?? '') !== addressSignature || !locationKey
        const standaloneChanged = (params.get('trip') ?? '') !== standaloneSignature || !locationKey
        home.restore(next)
        invalidPointLink.value = next.invalid
        invalidPersonalLink.value = shared.invalid
        // A link containing two different global modes cannot silently reinterpret either draft.
        const conflicting = !!shared.selection && !!standalone.selection && shared.selection.mode !== standalone.selection.mode
        if (sharedChanged) trips.addresses.restore(shared.selection)
        if (standaloneChanged || conflicting) {
            standaloneIncluded = !!standalone.selection && !conflicting
            savedStandalone.value = conflicting ? null : standalone.selection
            trips.standalone.restore(savedStandalone.value, standalone.invalid || conflicting)
        }
        const mode = shared.selection?.mode ?? standalone.selection?.mode
        if (mode) trips.addresses.setMode(mode)
        if (shared.selection) for (const side of sharedChanged ? ['left', 'right'] as const : changed) if (next[side]) pending.set(side, next[side]!)
        if (sharedChanged || standaloneChanged) restored(shared.selection || shared.invalid ? 'addresses' : standalone.selection || standalone.invalid ? 'standalone' : null)
        remember(); tryPending()
        await nextTick(); restoring = false
    }
    onMounted(() => { void restore(); window.addEventListener('popstate', restore); window.addEventListener('hashchange', restore) })
    onBeforeUnmount(() => { disposed = true; pending.clear(); window.removeEventListener('popstate', restore); window.removeEventListener('hashchange', restore) })
    return { saveHome, saveAddressTrips, saveStandalone, beginStandaloneRun, ordinaryUrl, personalUrl, invalidPointLink, invalidPersonalLink }
}
