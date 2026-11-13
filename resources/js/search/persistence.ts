import { createSearchTask } from './task'
import { openSearchStorage, SearchStorageError, settingKeys } from './storage'
import type { StorageCode, StorageOptions, SearchStorage } from './storage'
import type { SearchTaskPorts } from './types'

type Task = ReturnType<typeof createSearchTask>
type DeleteKind = 'search' | 'all'
export interface DeleteConfirmation { readonly kind: DeleteKind; readonly items: readonly string[]; readonly notice: string }
export type PersistenceState = { status: 'unsaved' | 'saving' | 'saved' | 'error' | 'deleted' | 'partial' | 'temporary'; message: string; code: StorageCode | null; settingsCleanupPending?: boolean }
export interface PersistenceOptions extends StorageOptions {
    ports: SearchTaskPorts
    temporary?: boolean
    removeSetting?: (key: string) => void
    resetSettings?: () => void
    cancelRequests?: () => void
}

/** No watcher, HTTP, hidden creation or autosave: the future UI issues explicit save commands. */
export async function createSearchPersistence(options: PersistenceOptions) {
    const task = createSearchTask(options.ports)
    let externalCheck: () => void = () => {}
    let storage: SearchStorage | null = null, initialError: SearchStorageError | null = null
    try { storage = await openSearchStorage({ ...options, onExternalChange: () => { options.onExternalChange?.(); externalCheck() } }) } catch (error) {
        initialError = error instanceof SearchStorageError ? error : new SearchStorageError('unavailable')
    }
    if (!options.temporary && storage?.read()) task.restoreDocument(storage.read())
    let state: PersistenceState = { status: options.temporary ? 'temporary' : initialError ? 'error' : storage?.read() ? 'saved' : 'unsaved',
        message: options.temporary ? 'Временный поиск. Изменения не сохраняются.' : initialError?.message ?? (storage?.read() ? 'Сохранено на устройстве' : 'Не сохранено'), code: initialError?.code ?? null }
    let savedRevision = state.status === 'saved' ? task.exportDocument().documentRevision : -1
    let savedSearchId: string | null = state.status === 'saved' ? task.exportDocument().searchId : null
    let serial = 0, deleting = false, pending = 0, cleanupPending = false
    let queue: Promise<unknown> = Promise.resolve()
    const confirmations = new WeakMap<DeleteConfirmation, { revision: number; searchId: string; serial: number; generation: number }>()
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = queue.then(operation); queue = next.catch(() => undefined); return next
    }
    function report(error: unknown) {
        const safe = error instanceof SearchStorageError ? error : new SearchStorageError('write_failed')
        state = { status: 'error', message: safe.message, code: safe.code }
        return safe
    }
    function writable() {
        if (options.temporary) throw new SearchStorageError('conflict')
        if (!storage) throw initialError ?? new SearchStorageError('unavailable')
        return storage
    }
    // A stable facade prevents input edits while the confirmed deletion is in flight.
    const reads = new Set(['snapshot', 'exportDocument', 'trip', 'environment', 'annotations'])
    const guarded = new Proxy(task, { get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
            if (deleting && !reads.has(String(property))) throw new SearchStorageError('conflict')
            return value(...args)
        }
    } }) as Task
    function cleanup() {
        let failed = false
        for (const key of settingKeys) {
            try { (options.removeSetting ?? (key => globalThis.localStorage.removeItem(key)))(key) } catch { failed = true }
        }
        try { options.resetSettings?.() } catch { failed = true }
        cleanupPending = failed
        if (failed) state = { status: 'partial', message: savedRevision < 0 ? 'Поиск удалён. Не все настройки сброшены; повторите очистку настроек.' : 'Не все настройки сброшены; повторите очистку настроек.', code: null }
    }
    const check = async () => {
        try { await writable().check() } catch (error) { throw report(error) }
    }
    externalCheck = () => { void check().catch(() => undefined) }
    return {
        task: guarded,
        check,
        state(): Readonly<PersistenceState> {
            if ((state.status === 'saved' && (task.exportDocument().documentRevision !== savedRevision || task.exportDocument().searchId !== savedSearchId))
                || (state.status === 'deleted' && task.exportDocument().documentRevision > 0))
                return { status: 'unsaved', message: cleanupPending ? 'Не сохранено. Не все настройки сброшены.' : 'Не сохранено', code: null, settingsCleanupPending: cleanupPending }
            return { ...state, settingsCleanupPending: cleanupPending, ...(cleanupPending && state.status !== 'partial' ? { message: `${state.message} Не все настройки сброшены.` } : {}) }
        },
        save() {
            const snapshot = task.exportDocument(), version = serial
            if (deleting) return Promise.reject(new SearchStorageError('conflict'))
            if (!options.temporary) state = { status: 'saving', message: 'Сохранение…', code: null }
            pending++
            return enqueue(async () => {
                try {
                    if (version !== serial) throw new SearchStorageError('deleted')
                    const saved = await writable().save(snapshot)
                    if (version === serial) {
                        savedRevision = saved.documentRevision; savedSearchId = saved.searchId
                        const isCurrent = task.exportDocument().documentRevision === savedRevision && task.exportDocument().searchId === savedSearchId
                        state = { status: pending > 1 ? 'saving' : isCurrent ? 'saved' : 'unsaved',
                            message: pending > 1 ? 'Сохранение…' : isCurrent ? 'Сохранено на устройстве' : 'Не сохранено', code: null }
                    }
                } catch (error) { if (version === serial && !options.temporary) throw report(error); throw error }
                finally { pending-- }
            })
        },
        prepareDelete(kind: DeleteKind): DeleteConfirmation {
            if (kind !== 'search' && kind !== 'all') throw new SearchStorageError('corrupt')
            const doc = task.exportDocument()
            const ticket = Object.freeze({ kind, items: Object.freeze([
                ...doc.candidates.map(c => `Кандидат: ${c.address.label}; заметки: ${c.notes.length}; отметки: ${c.checklist.length}`),
                ...doc.places.map(p => `Место: ${p.label}; режим: ${p.mode}; личный ориентир: ${p.thresholdMinutes ?? 'не задан'}`),
                'Выбранная пара кандидатов',
                'Заметки, отметки чек-листа, результаты в памяти и производный кэш',
                kind === 'all' ? 'Известные настройки PlaceLens' : 'Настройки приложения останутся',
            ]), notice: 'Останется случайная отметка, чтобы другая вкладка не восстановила удалённый поиск' })
            confirmations.set(ticket, { revision: doc.documentRevision, searchId: doc.searchId, serial, generation: task.snapshot().runtime.generation })
            return ticket
        },
        delete(confirmation: DeleteConfirmation) {
            const evidence = confirmations.get(confirmation), doc = task.exportDocument()
            if (deleting || !evidence || evidence.serial !== serial || evidence.revision !== doc.documentRevision || evidence.searchId !== doc.searchId || evidence.generation !== task.snapshot().runtime.generation)
                return Promise.reject(new SearchStorageError('conflict'))
            confirmations.delete(confirmation); deleting = true; serial++
            // Revoke all old result tokens even if the later durable operation aborts.
            try { options.cancelRequests?.() } catch { /* Tokens still revoke late results. */ }
            task.restoreDocument(doc)
            state = { status: 'saving', message: 'Удаление…', code: null }
            return enqueue(async () => {
                try {
                    await writable().delete()
                    task.restoreDocument(createSearchTask(options.ports).exportDocument())
                    savedRevision = -1; savedSearchId = null
                    state = { status: 'deleted', message: 'Поиск удалён. Осталась случайная отметка поколения.', code: null }
                    if (confirmation.kind === 'all') cleanup()
                } catch (error) { throw report(error) }
                finally { deleting = false }
            })
        },
        retrySettingsCleanup() {
            if (cleanupPending) {
                state = savedRevision >= 0 ? { status: 'saved', message: 'Сохранено на устройстве', code: null }
                    : { status: 'deleted', message: 'Поиск удалён. Осталась случайная отметка поколения.', code: null }
                cleanup()
            }
        },
        async reload() {
            if (deleting || pending) throw new SearchStorageError('conflict')
            const current = await writable().refresh()
            serial++
            task.restoreDocument(current ?? createSearchTask(options.ports).exportDocument())
            savedRevision = current?.documentRevision ?? -1; savedSearchId = current?.searchId ?? null
            state = { status: current ? 'saved' : 'unsaved', message: current ? 'Сохранено на устройстве' : 'Не сохранено', code: null }
        },
        close() { serial++; storage?.close() },
    }
}
