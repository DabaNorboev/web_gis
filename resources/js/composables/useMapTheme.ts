import { onMounted, onBeforeUnmount, readonly, ref } from 'vue'
import { mapThemeStorageKey, parseMapTheme, type MapTheme } from '@/utils/mapTheme'

const theme = ref<MapTheme>('light')
let initialized = false
export function useMapTheme() {
    function restore() {
        try { theme.value = parseMapTheme(window.localStorage.getItem(mapThemeStorageKey)) } catch { /* Private browser storage may be disabled. */ }
    }
    function setTheme(value: MapTheme) {
        theme.value = parseMapTheme(value)
        try { window.localStorage.setItem(mapThemeStorageKey, theme.value) } catch { /* The current session still works. */ }
    }
    function storage(event: StorageEvent) { if (event.key === mapThemeStorageKey || event.key === null) restore() }
    onMounted(() => { if (!initialized) { restore(); initialized = true }; window.addEventListener('storage', storage) })
    onBeforeUnmount(() => window.removeEventListener('storage', storage))
    return { theme: readonly(theme), setTheme }
}
