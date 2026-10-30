import { computed, readonly, ref } from 'vue'

export type InterfaceVersion = 'classic' | 'workspace'
export const interfaceStorageKey = 'placelens:interface:v1'

// One preference per document. Page state and requests never belong to a view.
const version = ref<InterfaceVersion>('classic')
const isWorkspace = computed(() => version.value === 'workspace')
let initialized = false

export function useInterfacePreference() {
    if (!initialized && typeof window !== 'undefined') {
        initialized = true
        try {
            if (window.localStorage.getItem(interfaceStorageKey) === 'workspace') version.value = 'workspace'
        } catch { /* The current interface is the safe default without storage. */ }
    }

    function setVersion(value: InterfaceVersion) {
        if (value !== 'classic' && value !== 'workspace') return
        version.value = value
        try { window.localStorage.setItem(interfaceStorageKey, value) }
        catch { /* The explicit choice still works for this document. */ }
    }

    return { version: readonly(version), isWorkspace, setVersion }
}
