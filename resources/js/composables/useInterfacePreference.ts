import { computed, readonly, ref } from 'vue'

export type InterfaceVersion = 'classic' | 'workspace'
export const interfaceStorageKey = 'placelens:interface:v1'

// Legacy values never gate access to the current workspace. No storage is needed.
const version = ref<InterfaceVersion>('workspace')
const isWorkspace = computed(() => true)
export function useInterfacePreference() {
    return { version: readonly(version), isWorkspace, setVersion: (_value: InterfaceVersion) => {} }
}
