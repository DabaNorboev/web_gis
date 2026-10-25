import { computed, onMounted, readonly, ref } from 'vue'

export const overviewTopics = [
    { id: 'transport', label: 'Остановки' },
    { id: 'parks', label: 'Парки' },
    { id: 'water', label: 'Вода' },
    { id: 'roads', label: 'Крупные дороги' },
    { id: 'railways', label: 'Железнодорожные пути' },
] as const
export type OverviewTopic = typeof overviewTopics[number]['id']
// Version is in the key; the value contains only topic identifiers.
export const overviewStorageKey = 'placelens.overview-topics.v1'
export function parseOverviewTopics(raw: string | null): OverviewTopic[] | null {
    try {
        const value: unknown = raw === null ? null : JSON.parse(raw)
        if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return null
        return overviewTopics.filter(topic => value.includes(topic.id)).map(topic => topic.id)
    } catch { return null }
}
const selection = ref<OverviewTopic[] | null>(null)
const storageFailed = ref(false)
let initialized = false
function readStorage() {
    try { selection.value = parseOverviewTopics(window.localStorage.getItem(overviewStorageKey)); storageFailed.value = false }
    catch { storageFailed.value = true }
}
export function useOverviewTopics() {
    onMounted(() => {
        if (initialized) return
        initialized = true
        readStorage()
        window.addEventListener('storage', event => { if (event.key === overviewStorageKey || event.key === null) readStorage() })
    })
    function persist() {
        try {
            if (selection.value === null) window.localStorage.removeItem(overviewStorageKey)
            else window.localStorage.setItem(overviewStorageKey, JSON.stringify(selection.value))
            storageFailed.value = false
        } catch { storageFailed.value = true }
    }
    function includes(id: string) { return selection.value === null || selection.value.includes(id as OverviewTopic) }
    function toggle(id: OverviewTopic) {
        const current = selection.value ?? overviewTopics.map(topic => topic.id)
        selection.value = overviewTopics.filter(topic => topic.id === id ? !current.includes(id) : current.includes(topic.id)).map(topic => topic.id)
        persist()
    }
    function reset() { selection.value = null; persist() }
    return { selection: readonly(selection), configured: computed(() => selection.value !== null), storageFailed: readonly(storageFailed), includes, toggle, reset }
}
