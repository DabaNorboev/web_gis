import { projectDocument } from './document'
import type { SearchDocument } from './types'

const databaseName = 'placelens-search-v1'
const schemaVersion = 1
export const settingKeys = Object.freeze(['placelens:map-theme:v1', 'placelens.overview-topics.v1',
    'placelens:sidebar:home:v1', 'placelens:sidebar:profile:v1', 'placelens:interface:v1'])
export type StorageCode = 'unavailable' | 'blocked' | 'closed' | 'deleted' | 'conflict' | 'corrupt' | 'version' | 'write_failed' | 'crypto'
const explanations: Record<StorageCode, string> = {
    unavailable: 'Хранилище недоступно. Работа возможна без сохранения.', blocked: 'Закройте другую вкладку, мешающую открытию хранилища.',
    closed: 'Соединение с хранилищем закрыто. Откройте актуальное состояние явно.', deleted: 'Данные удалены в другой вкладке',
    conflict: 'Поиск изменён в другой вкладке. Откройте сохранённое или продолжите временно.',
    corrupt: 'Сохранённый поиск повреждён. Запись не изменена.', version: 'Версия сохранённого поиска несовместима. Запись не изменена.',
    write_failed: 'Не удалось записать изменения. Повторите сохранение.', crypto: 'Безопасный генератор недоступен. Запись не начата.',
}
export class SearchStorageError extends Error {
    constructor(readonly code: StorageCode) { super(explanations[code]); this.name = 'SearchStorageError' }
}
export interface StoredSearch extends SearchDocument { schemaVersion: 1; storageRevision: number }
export function encodeStoredSearch(value: unknown, storageRevision: number): StoredSearch {
    if (!Number.isSafeInteger(storageRevision) || storageRevision < 1) throw new SearchStorageError('corrupt')
    return { schemaVersion, storageRevision, ...projectDocument(value) }
}
export function decodeStoredSearch(value: unknown): StoredSearch {
    if (!value || typeof value !== 'object') throw new SearchStorageError('corrupt')
    const input = value as StoredSearch
    if (input.schemaVersion !== schemaVersion) throw new SearchStorageError('version')
    try { return encodeStoredSearch(input, input.storageRevision) } catch { throw new SearchStorageError('corrupt') }
}
export interface StorageOptions {
    name?: string
    factory?: IDBFactory
    random?: Pick<Crypto, 'getRandomValues'>
    openTimeoutMs?: number
    onExternalChange?: () => void
    // Only a wake-up hint; never a lock or a carrier of personal fields/generation.
    channel?: (name: string) => Pick<BroadcastChannel, 'postMessage' | 'close' | 'onmessage'>
}

/** A connection is a capability: once lost it is never reopened for a queued write. */
export async function openSearchStorage(options: StorageOptions = {}) {
    const name = options.name ?? databaseName
    const factory = options.factory ?? globalThis.indexedDB
    if (!factory) throw new SearchStorageError('unavailable')
    let closed = false
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        let ended = false
        const fail = (code: StorageCode) => { if (!ended) { ended = true; clearTimeout(timer); reject(new SearchStorageError(code)) } }
        const timer = setTimeout(() => fail('blocked'), options.openTimeoutMs ?? 3000)
        let request: IDBOpenDBRequest
        try { request = factory.open(name, 1) } catch { fail('unavailable'); return }
        request.onblocked = () => fail('blocked')
        request.onerror = () => fail(request.error?.name === 'VersionError' ? 'version' : 'unavailable')
        request.onupgradeneeded = () => {
            if (ended) { request.transaction?.abort(); return }
            request.result.createObjectStore('records')
            request.result.createObjectStore('cache')
        }
        request.onsuccess = () => {
            if (ended) { request.result.close(); return }
            ended = true; clearTimeout(timer); resolve(request.result)
        }
    })
    const closeConnection = () => { closed = true; db.close() }
    db.onversionchange = closeConnection
    db.onclose = () => { closed = true }
    if (!db.objectStoreNames.contains('records') || !db.objectStoreNames.contains('cache')) {
        closeConnection(); throw new SearchStorageError('corrupt')
    }
    let channel: ReturnType<NonNullable<StorageOptions['channel']>> | undefined
    try {
        const make = options.channel ?? (typeof BroadcastChannel === 'undefined' ? undefined : (id: string) => new BroadcastChannel(id))
        channel = make?.(name)
        if (channel) channel.onmessage = () => options.onExternalChange?.()
    } catch { /* Transaction checks do not depend on notifications. */ }
    let epoch: string | null = null, active: StoredSearch | null = null, bound = false
    let queue: Promise<unknown> = Promise.resolve()
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = queue.then(operation); queue = next.catch(() => undefined); return next
    }
    function marker(): string {
        try {
            const bytes = new Uint8Array(16)
            ;(options.random ?? globalThis.crypto).getRandomValues(bytes)
            return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('')
        } catch { throw new SearchStorageError('crypto') }
    }
    function transaction<T>(write: boolean, action: (records: IDBObjectStore, cache: IDBObjectStore, currentEpoch: unknown,
        currentActive: unknown) => { value: T; epoch: string | null; active: StoredSearch | null }): Promise<T> {
        if (closed) return Promise.reject(new SearchStorageError('closed'))
        return new Promise((resolve, reject) => {
            let tx: IDBTransaction
            try { tx = db.transaction(['records', 'cache'], write ? 'readwrite' : 'readonly') }
            catch { closed = true; reject(new SearchStorageError('closed')); return }
            let failure: SearchStorageError | undefined
            let result: ReturnType<typeof action> | undefined
            tx.onabort = () => reject(failure ?? new SearchStorageError('write_failed'))
            tx.onerror = () => { /* The transaction abort is the terminal failure. */ }
            tx.oncomplete = () => {
                if (!result) { reject(new SearchStorageError('write_failed')); return }
                // Adopt generation/revision only after commit, including for the deleting tab.
                epoch = result.epoch; active = result.active; bound = true
                if (write) { try { channel?.postMessage({ type: 'changed' }) } catch { /* hint only */ } }
                resolve(result.value)
            }
            const records = tx.objectStore('records'), cache = tx.objectStore('cache')
            const e = records.get('generation'), a = records.get('active')
            a.onsuccess = () => {
                try { result = action(records, cache, e.result, a.result) }
                catch (error) {
                    failure = error instanceof SearchStorageError ? error : new SearchStorageError('write_failed')
                    tx.abort()
                }
            }
        })
    }
    function inspect(currentEpoch: unknown, value: unknown) {
        if (currentEpoch !== undefined && (typeof currentEpoch !== 'string' || !/^[0-9a-f]{32}$/.test(currentEpoch))) throw new SearchStorageError('corrupt')
        if (currentEpoch === undefined && value !== undefined) throw new SearchStorageError('corrupt')
        return { epoch: (currentEpoch ?? null) as string | null, active: value === undefined ? null : decodeStoredSearch(value) }
    }
    function expected(currentEpoch: unknown, value: unknown, deleting = false) {
        if (bound && epoch !== null && currentEpoch !== epoch) throw new SearchStorageError('deleted')
        const current = inspect(currentEpoch, value)
        const sameRevision = current.active?.storageRevision === active?.storageRevision
        // Confirmed deletion consumes earlier writes to this same search, not a replacement search.
        const laterSameSearch = deleting && active !== null && current.active !== null && current.active.storageRevision >= active.storageRevision
        if (current.epoch !== epoch || current.active?.searchId !== active?.searchId || (!sameRevision && !laterSameSearch))
            throw new SearchStorageError('conflict')
        return current
    }
    const refresh = () => enqueue(() => transaction(false, (_records, _cache, e, a) => {
        if (bound && epoch !== null && e === undefined) throw new SearchStorageError('deleted')
        const current = inspect(e, a); return { ...current, value: current.active }
    }))
    try { await refresh() } catch (error) { channel?.close(); closeConnection(); throw error }
    return {
        /** Explicit rebind only; callers must not invoke this as an automatic retry. */
        refresh,
        read: () => active === null ? null : decodeStoredSearch(active),
        check: () => enqueue(() => transaction(false, (_r, _c, e, a) => ({ ...expected(e, a), value: undefined }))),
        save(value: unknown, replace = false) {
            // Capture the allowlisted snapshot at invocation, before joining the queue.
            let document: SearchDocument
            try { document = projectDocument(value) } catch { return Promise.reject(new SearchStorageError('corrupt')) }
            return enqueue(() => transaction(true, (records, _cache, e, a) => {
                const current = expected(e, a)
                if (current.active && current.active.searchId !== document.searchId && !replace) throw new SearchStorageError('conflict')
                if (current.active?.searchId === document.searchId && document.documentRevision < current.active.documentRevision) throw new SearchStorageError('conflict')
                const nextEpoch = current.epoch ?? marker()
                const next = encodeStoredSearch(document, (current.active?.storageRevision ?? 0) + 1)
                records.put(nextEpoch, 'generation'); records.put(next, 'active')
                return { epoch: nextEpoch, active: next, value: decodeStoredSearch(next) }
            }))
        },
        delete() {
            return enqueue(() => transaction(true, (records, cache, e, a) => {
                expected(e, a, true)
                const nextEpoch = marker()
                if (nextEpoch === epoch) throw new SearchStorageError('crypto')
                records.clear(); cache.clear(); records.put(nextEpoch, 'generation')
                return { epoch: nextEpoch, active: null, value: undefined }
            }))
        },
        close() { channel?.close(); closeConnection() },
    }
}
export type SearchStorage = Awaited<ReturnType<typeof openSearchStorage>>
