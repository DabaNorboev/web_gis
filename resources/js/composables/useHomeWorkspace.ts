import { computed, ref, shallowRef } from 'vue'
import { useAddressComparison } from '@/composables/useAddressComparison'
import { useTransportAnalysis } from '@/composables/useTransportAnalysis'
import type { HomeSelection } from '@/utils/homeSelection'
import type { SideKey } from '@/utils/comparison'
import type { Coordinates } from '@/types/transport'
import type { AddressMapState } from '@/utils/addressMap'
import type { HomeMapContext } from '@/types/homeWorkspace'

export function useHomeWorkspace(onChange: (selection: HomeSelection) => void) {
    const addresses = useAddressComparison({ left: null, right: null, radius: 500 }, () => {})
    const transport = useTransportAnalysis(() => {})
    // addresses.radius is authoritative. Transport receives the same radius through restore.
    const { radius, sides, loadSide } = addresses
    const activeSide = ref<SideKey>('left')
    const context = shallowRef<HomeMapContext>({ kind: 'profile', side: 'left' })
    const choice = shallowRef<AddressMapState>({ groups: [], selectedId: null, highlightedId: null, highlightedGroupId: null })
    const searching = ref(true)
    const searchResetKey = ref(0)
    const selectedSides = computed(() => (['left', 'right'] as const).filter(side => sides[side].id))
    function selection(): HomeSelection {
        return { left: sides.left.id, right: sides.right.id, radius: radius.value, point: transport.point.value,
            activeSide: activeSide.value, context: context.value.kind === 'point' ? 'point' : 'profile' }
    }
    function clearSearch() {
        choice.value = { groups: [], selectedId: null, highlightedId: null, highlightedGroupId: null }
        searchResetKey.value++
    }
    function activate(next: HomeMapContext) {
        context.value = next
        if (next.kind === 'profile') activeSide.value = next.side
        else if ((next.kind === 'trip' || next.kind === 'pick-street') && next.trip.scenario === 'addresses') activeSide.value = next.trip.side
    }
    function showSide(side: SideKey) {
        clearSearch(); searching.value = !sides[side].id
        activate({ kind: 'profile', side }); onChange(selection())
    }
    function editSide(side: SideKey) { showSide(side); searching.value = true }
    function chooseAddress(id: string) {
        addresses.choose(activeSide.value, id)
        activate({ kind: 'profile', side: activeSide.value })
        searching.value = false; clearSearch(); onChange(selection())
    }
    function removeSide(side: SideKey) {
        addresses.choose(side, null)
        const remaining = selectedSides.value[0]
        activate({ kind: 'profile', side: remaining ?? side })
        searching.value = !remaining; clearSearch(); onChange(selection())
    }
    function setRadius(value: number) {
        if (![300, 500].includes(value) || value === radius.value) return
        addresses.setRadius(value)
        transport.restore({ point: transport.point.value, radius: radius.value })
        onChange(selection())
    }
    async function selectPoint(point: Coordinates) {
        activate({ kind: 'point' }); clearSearch(); searching.value = false
        const pending = transport.selectPoint(point, false)
        onChange(selection()); await pending
    }
    function showPoint() { activate({ kind: 'point' }); clearSearch(); searching.value = false; onChange(selection()) }
    function resetPoint(resetSearch = true) {
        transport.reset(false); if (resetSearch) clearSearch()
        activate({ kind: 'profile', side: activeSide.value }); searching.value = !sides[activeSide.value].id
        onChange(selection())
    }
    function restore(next: HomeSelection) {
        addresses.restore(next)
        transport.restore({ point: next.point, radius: radius.value })
        activeSide.value = next.activeSide
        activate(next.context === 'point' ? { kind: 'point' } : { kind: 'profile', side: next.activeSide })
        searching.value = next.context !== 'point' && !sides[next.activeSide].id
        clearSearch()
    }
    return { radius, sides, loadSide, activeSide, context, activate, choice, searching, searchResetKey, selectedSides,
        transport: { point: transport.point, analysis: transport.analysis, status: transport.status, selectedStopId: transport.selectedStopId,
            retry: () => { if (transport.point.value) return transport.selectPoint(transport.point.value, false) } },
        selection, restore, chooseAddress, removeSide, showSide, editSide, setRadius, selectPoint, showPoint, resetPoint }
}
export type HomeWorkspace = ReturnType<typeof useHomeWorkspace>
