import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { ComparisonSide } from '@/composables/useAddressComparison'
import type { useComparisonTrips } from '@/composables/useComparisonTrips'
import { comparisonUrl, parseComparison, type ComparisonSelection, type SideKey } from '@/utils/comparison'
import { comparisonTripsFragment, parseComparisonTrips } from '@/utils/comparisonTrips'

// Query remains address state; this boundary coordinates writes to the shared URL.
export function useComparisonLink(
    addresses: { radius: Ref<number>; sides: Record<SideKey, ComparisonSide>; restore: (selection: ComparisonSelection) => void },
    trips: ReturnType<typeof useComparisonTrips>,
    effects: { changed: () => void; restored: (personal: boolean) => void; addressesRestored: () => void },
) {
    const keys: SideKey[] = ['left', 'right']
    const invalidPersonalLink = ref(false)
    const pendingSides = new Set<SideKey>()
    let locationKey = '', lastFragment: string | null = null, lastSelection = '', disposed = false
    const selection = () => ({ left: addresses.sides.left.id, right: addresses.sides.right.id, radius: addresses.radius.value })
    const personalFragment = () => trips.linkSelection.value ? comparisonTripsFragment(trips.linkSelection.value) : ''
    const signature = (parsed: ReturnType<typeof parseComparisonTrips>) => parsed.selection ? comparisonTripsFragment(parsed.selection) : parsed.invalid ? `invalid:${window.location.hash}` : ''
    const shareUrl = computed(() => new URL(comparisonUrl(selection()), window.location.origin).href)
    const personalShareUrl = computed(() => trips.linkSelection.value ? shareUrl.value + personalFragment() : null)
    function remember(fragment: string) {
        locationKey = window.location.search + '|' + window.location.hash
        lastFragment = fragment; lastSelection = fragment
    }
    function saveAddresses(next: ComparisonSelection) {
        if (disposed) return
        window.history.pushState(null, '', comparisonUrl(next) + personalFragment())
        effects.changed()
    }
    function tryRestoredTrips() {
        if (disposed) return
        for (const side of pendingSides) if (trips.starts[side].point && trips.starts[side].id === addresses.sides[side].id && addresses.sides[side].profile?.address.id === addresses.sides[side].id) {
            pendingSides.delete(side)
            void trips.calculate(side)
        }
    }
    for (const side of keys) watch(() => [addresses.sides[side].id, addresses.sides[side].profile?.point.lon, addresses.sides[side].profile?.point.lat], () => {
        if (disposed) return
        const value = addresses.sides[side]
        trips.setStart(side, value.id, value.profile?.address.id === value.id ? value.profile?.point ?? null : null)
        tryRestoredTrips()
    }, { immediate: true, flush: 'sync' })
    function restorePersonal() {
        if (disposed) return
        const key = window.location.search + '|' + window.location.hash
        if (key === locationKey) return
        locationKey = key
        const parsed = parseComparisonTrips(window.location.hash), fragment = signature(parsed)
        if (lastFragment === fragment) return
        // Remember before restore: its queued state watcher must not write history.
        lastFragment = fragment
        trips.restore(parsed.selection)
        lastSelection = personalFragment()
        invalidPersonalLink.value = parsed.invalid
        pendingSides.clear()
        if (parsed.selection) keys.forEach(side => pendingSides.add(side))
        effects.changed()
        effects.restored(!!parsed.selection || parsed.invalid)
        tryRestoredTrips()
    }
    // Only selection is persisted. Responses and candidates never trigger routing here.
    watch(trips.linkSelection, (value, previous) => {
        if (disposed) return
        const fragment = value ? comparisonTripsFragment(value) : ''
        if (fragment === lastSelection) return
        invalidPersonalLink.value = false
        effects.changed()
        const geometry = (input: typeof value) => input ? comparisonTripsFragment({ ...input, places: input.places.map(p => ({ ...p, label: '' })) }) : ''
        const sameGeometry = geometry(value) === geometry(previous)
        if (!sameGeometry) pendingSides.clear()
        const url = comparisonUrl(selection()) + fragment
        if (sameGeometry) window.history.replaceState(null, '', url)
        else window.history.pushState(null, '', url)
        remember(fragment)
    }, { deep: true })
    function resetPersonal() {
        if (disposed) return
        const hadSelection = !!trips.linkSelection.value
        trips.reset(); pendingSides.clear(); invalidPersonalLink.value = false
        if (hadSelection || window.location.hash) {
            window.history.pushState(null, '', comparisonUrl(selection()))
            remember('')
        }
    }
    function popstate() {
        if (disposed) return
        const next = parseComparison(window.location.search)
        const changedSides = keys.filter(side => addresses.sides[side].id !== next[side])
        const samePlaces = lastFragment === signature(parseComparisonTrips(window.location.hash))
        addresses.restore(next)
        effects.changed(); effects.addressesRestored()
        restorePersonal()
        if (samePlaces && trips.places.value.length) {
            changedSides.forEach(side => pendingSides.add(side))
            tryRestoredTrips()
        }
        // Address restoration may clear obsolete hints. It is still navigation, not an edit.
        // Keep the URL signature for paired-event deduplication and the resulting state
        // signature for suppressing its queued watcher; a later user edit differs from it.
        lastSelection = personalFragment()
    }
    onMounted(() => {
        restorePersonal()
        window.addEventListener('popstate', popstate)
        window.addEventListener('hashchange', restorePersonal)
    })
    onBeforeUnmount(() => {
        disposed = true; pendingSides.clear()
        window.removeEventListener('popstate', popstate)
        window.removeEventListener('hashchange', restorePersonal)
    })
    return { invalidPersonalLink, shareUrl, personalShareUrl, saveAddresses, resetPersonal }
}
