import { computed, shallowRef, ref } from 'vue'
import type { AddressResult, AddressObject } from '@/types/address'

// Receiving results and highlighting never commit; only explicit choices notify the caller.
export function useAddressChoice(onSelect: (id: string) => void = () => {}) {
    const matches = shallowRef<AddressResult[]>([])
    const pending = shallowRef<AddressResult | null>(null)
    const selected = shallowRef<AddressObject | null>(null)
    const highlightedId = ref<string | null>(null)
    const highlightedGroupId = ref<string | null>(null)
    const groups = computed(() => pending.value ? [pending.value] : matches.value)
    function clear() {
        matches.value = []; pending.value = null; selected.value = null
        highlightedId.value = null; highlightedGroupId.value = null
    }
    function chooseGroup(group: AddressResult) {
        pending.value = group
        selected.value = null
        highlightedId.value = null; highlightedGroupId.value = null
        if (group.objects.length === 1) chooseObject(group.objects[0]!.id)
    }
    function chooseObject(id: string) {
        const group = groups.value.find(group => group.objects.some(object => object.id === id))
        const object = group?.objects.find(object => object.id === id)
        if (!group || !object) return false
        pending.value = group; selected.value = object
        highlightedId.value = null; highlightedGroupId.value = null
        onSelect(object.id)
        return true
    }
    const mapState = computed(() => ({ groups: groups.value, selectedId: selected.value?.id ?? null, highlightedId: highlightedId.value, highlightedGroupId: highlightedGroupId.value }))
    return { matches, pending, selected, highlightedId, highlightedGroupId, groups, mapState, clear, chooseGroup, chooseObject }
}
