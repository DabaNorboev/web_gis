import { test as base, expect, chromium } from '@playwright/test'
const test = process.env.STORAGE_CDP_URL ? base.extend({ browser: [async ({}, use) => {
    const browser = await chromium.connectOverCDP(process.env.STORAGE_CDP_URL)
    try { await use(browser) } finally { await browser.close() }
}, { scope: 'worker' }] }) : base

test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => window.storageHarness)
    await page.evaluate(() => {
        let sequence = 0
        window.synthetic = {
            address: n => ({ kind: 'address', addressId: `osm:way:${n}`, lon: .1, lat: .2, label: `Synthetic ${n}`, provenance: null }),
            ports: () => { const prefix = ++sequence; let id = 0; return { nextId: () => `synthetic-${prefix}-${++id}`, now: () => 'synthetic-time' } },
            name: () => `synthetic-storage-${++sequence}`,
            async raw(name, operation) {
                const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('Synthetic raw open failed')) })
                try { return await new Promise((resolve, reject) => {
                    const tx = db.transaction(['records', 'cache'], 'readwrite'), store = tx.objectStore('records')
                    const keys = store.getAllKeys(), values = store.getAll(), caches = tx.objectStore('cache').count()
                    values.onsuccess = () => { operation?.(store, tx.objectStore('cache')) }
                    // Only aggregate assertions leave the page; never return a generation marker.
                    tx.oncomplete = () => resolve({ keys: keys.result, markerValid: /^[0-9a-f]{32}$/.test(storeMarker(values.result, keys.result)), caches: caches.result }); tx.onabort = () => reject(Error('Synthetic raw abort'))
                }) } finally { db.close() }
                function storeMarker(values, keys) { return values[keys.indexOf('generation')] }
            },
            async failure(promise) { try { await promise; return null } catch (e) { return { code: e.code, message: e.message } } },
        }
    })
})

test('allowlisted storage restores inputs and annotations, not calculation results', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = storageHarness, s = synthetic, name = s.name()
        const p = await h.createSearchPersistence({ name, ports: s.ports() })
        const c = p.task.addCandidate(s.address(1)), place = p.task.addPlace({ kind: 'point', lon: .2, lat: .3, label: 'Point' }, 'Place', 'walking', 30)
        p.task.addNote(c, 'Synthetic note', place); p.task.setChecklistMark(c, 'entrance', place, true)
        const job = p.task.calculateCandidate(c).find(j => j.input.kind === 'environment')
        p.task.acceptResult(job.token, { kind: 'environment', status: 'READY', value: { synthetic: 42 }, calculatedAt: 'synthetic-time', provenance: null })
        const promise = p.save(), saving = p.state().status; await promise
        const saved = p.state().status; p.close()
        const restored = await h.createSearchPersistence({ name, ports: s.ports() })
        const doc = restored.task.exportDocument(), snapshot = restored.task.snapshot()
        const r = { saving, saved, restored: restored.state().status, places: doc.places.length, notes: doc.candidates[0].notes.length,
            cells: snapshot.runtime.cells.length, resolution: snapshot.runtime.resolutions[0].status, marker: await s.raw(name) }
        restored.close(); return r
    })
    expect(result).toEqual({ saving: 'saving', saved: 'saved', restored: 'saved', places: 1, notes: 1, cells: 0, resolution: 'unresolved', marker: { keys: ['active', 'generation'], markerValid: true, caches: 0 } })
})

for (const kind of ['search', 'all']) test(`${kind} deletion fences stale tabs and lets its own tab save without reload`, async ({ page }) => {
    const result = await page.evaluate(async kind => {
        const h = storageHarness, s = synthetic, name = s.name()
        const a = await h.createSearchPersistence({ name, ports: s.ports() })
        a.task.addCandidate(s.address(1)); await a.save()
        const b = await h.createSearchPersistence({ name, ports: s.ports() })
        localStorage.setItem('placelens:map-theme:v1', 'synthetic'); localStorage.setItem('unrelated', 'keep')
        await s.raw(name, (_r, cache) => cache.put({ synthetic: true }, 'derived'))
        const ticket = a.prepareDelete(kind)
        await a.delete(ticket)
        const after = await s.raw(name), status = a.state().status, stale = await s.failure(b.save())
        const settingsKept = localStorage.getItem('placelens:map-theme:v1') !== null, unrelatedKept = localStorage.getItem('unrelated') === 'keep'
        a.task.addCandidate(s.address(7)); await a.save()
        const continued = a.state().status, snapshot = await s.raw(name)
        a.close(); b.close()
        return { after, status, stale: stale.code, message: stale.message, settingsKept, unrelatedKept, continued,
            snapshot, notice: ticket.notice.includes('Останется случайная отметка') }
    }, kind)
    expect(result).toEqual({ after: { keys: ['generation'], markerValid: true, caches: 0 }, status: 'deleted', stale: 'deleted',
        message: 'Данные удалены в другой вкладке', settingsKept: kind === 'search', unrelatedKept: true, continued: 'saved',
        snapshot: { keys: ['active', 'generation'], markerValid: true, caches: 0 }, notice: true })
})

test('separate tabs cannot overwrite a newer storage revision even at the same document revision', async ({ page, context }) => {
    await page.evaluate(async () => {
        window.tabA = await storageHarness.createSearchPersistence({ name: 'synthetic-cas', ports: synthetic.ports() })
        tabA.task.addCandidate(synthetic.address(1)); await tabA.save()
    })
    const other = await context.newPage(); await other.goto('/'); await other.waitForFunction(() => window.storageHarness)
    await other.evaluate(async () => {
        window.tabB = await storageHarness.openSearchStorage({ name: 'synthetic-cas' })
        window.staleDocument = tabB.read()
    })
    await page.evaluate(async () => { tabA.task.addCandidate(synthetic.address(2)); await tabA.save() })
    expect(await other.evaluate(async () => { try { await tabB.save(staleDocument); return 'unexpected' } catch (e) { return e.code } })).toBe('conflict')
    await page.evaluate(() => tabA.close()); await other.evaluate(() => tabB.close())
})

for (const deletionFirst of [false, true]) test(`transaction race: deletion first=${deletionFirst}`, async ({ page }) => {
    const result = await page.evaluate(async deletionFirst => {
        const h = storageHarness, s = synthetic, name = s.name(), a = await h.openSearchStorage({ name })
        const task = h.createSearchTask(s.ports()); task.addCandidate(s.address(1)); await a.save(task.exportDocument())
        const b = await h.openSearchStorage({ name }); task.addCandidate(s.address(2))
        const first = deletionFirst ? a.delete() : b.save(task.exportDocument())
        const second = deletionFirst ? b.save(task.exportDocument()) : a.delete()
        const results = await Promise.allSettled([first, second])
        const out = { statuses: results.map(r => r.status), code: results[1].reason?.code ?? null, after: await s.raw(name) }
        a.close(); b.close(); return out
    }, deletionFirst)
    expect(result).toEqual({ statuses: ['fulfilled', deletionFirst ? 'rejected' : 'fulfilled'], code: deletionFirst ? 'deleted' : null,
        after: { keys: ['generation'], markerValid: true, caches: 0 } })
})

test('missing marker cannot be re-created by an attached tab; a fresh explicitly created search can initialize empty storage', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = storageHarness, s = synthetic, name = s.name(), old = await h.openSearchStorage({ name })
        const doc = h.createSearchTask(s.ports()).exportDocument(); await old.save(doc)
        await s.raw(name, records => records.clear())
        const failure = await s.failure(old.save(doc)), refresh = await s.failure(old.refresh()), empty = await s.raw(name)
        const fresh = await h.openSearchStorage({ name }); await fresh.save(doc)
        const initialized = await s.raw(name); old.close(); fresh.close()
        return { failure: failure.code, refresh: refresh.code, empty, initialized }
    })
    expect(result).toEqual({ failure: 'deleted', refresh: 'deleted', empty: { keys: [], markerValid: false, caches: 0 }, initialized: { keys: ['active', 'generation'], markerValid: true, caches: 0 } })
})

for (const defect of ['missing-marker', 'future-version', 'corrupt-document']) test(`invalid storage is reported and preserved: ${defect}`, async ({ page }) => {
    const result = await page.evaluate(async defect => {
        const h = storageHarness, s = synthetic, name = s.name(), store = await h.openSearchStorage({ name })
        const doc = h.createSearchTask(s.ports()).exportDocument(); await store.save(doc); store.close()
        await s.raw(name, records => {
            if (defect === 'missing-marker') records.delete('generation')
            else { const r = records.get('active'); r.onsuccess = () => records.put({ ...r.result, ...(defect === 'future-version' ? { schemaVersion: 99 } : { candidates: 'broken' }) }, 'active') }
        })
        let original, final
        const before = await s.raw(name, records => { const r = records.get('active'); r.onsuccess = () => { original = JSON.stringify(r.result) } }), session = await h.createSearchPersistence({ name, ports: s.ports() })
        const initial = session.state(), rejected = await s.failure(session.save()), after = await s.raw(name, records => { const r = records.get('active'); r.onsuccess = () => { final = JSON.stringify(r.result) } })
        session.close(); return { code: initial.code, rejected: rejected.code, unchanged: original === final && JSON.stringify(before) === JSON.stringify(after) }
    }, defect)
    const code = defect === 'future-version' ? 'version' : 'corrupt'
    expect(result).toEqual({ code, rejected: code, unchanged: true })
})

test('abort after put success never adopts generation, reports saved, or leaves loading results', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = storageHarness, s = synthetic, name = s.name(), a = await h.createSearchPersistence({ name, ports: s.ports() })
        const c = a.task.addCandidate(s.address(1)); await a.save()
        const b = await h.openSearchStorage({ name }), previous = b.read()
        const jobs = a.task.calculateCandidate(c)
        const original = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function(...args) {
            const request = original.apply(this, args)
            if (this.name === 'records' && args[1] === 'generation') request.addEventListener('success', () => this.transaction.abort())
            return request
        }
        let error
        try { error = await s.failure(a.delete(a.prepareDelete('all'))) } finally { IDBObjectStore.prototype.put = original }
        const status = a.state().status, acceptedLate = a.task.acceptResult(jobs[0].token, { kind: 'environment', status: 'READY', value: 1, calculatedAt: null, provenance: null })
        await a.save() // The deleting tab must retain its old generation after abort.
        const staleRevision = await s.failure(b.save(previous))
        if (staleRevision?.code !== 'conflict') throw Error('Expected revision conflict, not an adopted aborted generation')
        const cells = a.task.snapshot().runtime.cells.length, after = await s.raw(name)
        a.close(); b.close(); return { code: error.code, status, acceptedLate, cells, after }
    })
    expect(result).toEqual({ code: 'write_failed', status: 'error', acceptedLate: false, cells: 0,
        after: { keys: ['active', 'generation'], markerValid: true, caches: 0 } })
})

test('quota failure is retryable; an older commit never confirms newer unsaved edits', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = storageHarness, s = synthetic, name = s.name(), a = await h.createSearchPersistence({ name, ports: s.ports() })
        a.task.addCandidate(s.address(1))
        const original = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function() { throw new DOMException('Synthetic private payload must not escape', 'QuotaExceededError') }
        let failure
        try { failure = await s.failure(a.save()) } finally { IDBObjectStore.prototype.put = original }
        const error = a.state().status, pending = a.save(); a.task.addCandidate(s.address(2)); await pending
        const older = a.state().status; await a.save(); const latest = a.state().status
        a.close(); return { code: failure.code, safe: !failure.message.includes('payload'), error, older, latest }
    })
    expect(result).toEqual({ code: 'write_failed', safe: true, error: 'error', older: 'unsaved', latest: 'saved' })
})

test('delete all reports partial settings failure and retries only known keys', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = storageHarness, s = synthetic, name = s.name(); let fail = true, resets = 0
        const p = await h.createSearchPersistence({ name, ports: s.ports(), removeSetting: key => { if (fail && key === 'placelens:map-theme:v1') throw Error('synthetic'); localStorage.removeItem(key) }, resetSettings: () => { resets++ } })
        localStorage.setItem('unrelated', 'keep'); await p.save(); await p.delete(p.prepareDelete('all'))
        const partial = p.state().status, after = await s.raw(name); fail = false; p.retrySettingsCleanup()
        const retried = p.state().status, untouched = localStorage.getItem('unrelated')
        p.task.addCandidate(s.address(7)); await p.save(); const continued = p.state().status
        p.close(); return { partial, after, retried, continued, untouched, resets }
    })
    expect(result).toEqual({ partial: 'partial', after: { keys: ['generation'], markerValid: true, caches: 0 }, retried: 'deleted', continued: 'saved', untouched: 'keep', resets: 2 })
})

test('stale confirmations fail, writes cannot queue behind deletion, late results are revoked', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const h = storageHarness, s = synthetic, name = s.name(), p = await h.createSearchPersistence({ name, ports: s.ports() })
        const c = p.task.addCandidate(s.address(1)); await p.save(); const stale = p.prepareDelete('search')
        p.task.addNote(c, 'Synthetic change')
        const rejected = await s.failure(p.delete(stale)), jobs = p.task.calculateCandidate(c)
        const deletion = p.delete(p.prepareDelete('search')), queued = await s.failure(p.save())
        let editsBlocked = false; try { p.task.addCandidate(s.address(3)) } catch { editsBlocked = true }
        await deletion
        const late = p.task.acceptResult(jobs[0].token, { kind: 'environment', status: 'READY', value: 1, calculatedAt: null, provenance: null })
        const after = await s.raw(name); p.close()
        return { stale: rejected.code, queued: queued.code, editsBlocked, late, after }
    })
    expect(result).toEqual({ stale: 'conflict', queued: 'conflict', editsBlocked: true, late: false, after: { keys: ['generation'], markerValid: true, caches: 0 } })
})

test('temporary sessions never write, including when there is no saved search', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, name = s.name(), p = await storageHarness.createSearchPersistence({ name, ports: s.ports(), temporary: true })
        p.task.addCandidate(s.address(1)); const denied = await s.failure(p.save()), after = await s.raw(name), state = p.state().status
        p.close(); return { code: denied.code, state, after }
    })
    expect(result).toEqual({ code: 'conflict', state: 'temporary', after: { keys: [], markerValid: false, caches: 0 } })
})

test('closed or versionchanged connections never reopen for a stale write', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, name = s.name(), store = await storageHarness.openSearchStorage({ name })
        const doc = storageHarness.createSearchTask(s.ports()).exportDocument(); await store.save(doc)
        await new Promise((resolve, reject) => { const r = indexedDB.open(name, 2); r.onsuccess = () => { r.result.close(); resolve() }; r.onerror = () => reject(Error('Synthetic upgrade failed')) })
        const changed = await s.failure(store.save(doc)); store.close()
        const closed = await s.failure(store.save(doc)); return { changed: changed.code, closed: closed.code }
    })
    expect(result).toEqual({ changed: 'closed', closed: 'closed' })
})

test('no cryptographic generator means no durable write and no weak fallback', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, name = s.name(), store = await storageHarness.openSearchStorage({ name, random: { getRandomValues() { throw Error('Synthetic crypto unavailable') } } })
        const error = await s.failure(store.save(storageHarness.createSearchTask(s.ports()).exportDocument())), after = await s.raw(name)
        store.close(); return { code: error.code, after }
    })
    expect(result).toEqual({ code: 'crypto', after: { keys: [], markerValid: false, caches: 0 } })
})

test('blocked opening times out safely and never applies a queued creation later', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, name = s.name()
        const hold = await new Promise(resolve => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => { r.result.createObjectStore('records'); r.result.createObjectStore('cache') }; r.onsuccess = () => resolve(r.result) })
        hold.onversionchange = () => {}
        const upgrading = indexedDB.open(name, 2)
        await new Promise(resolve => upgrading.onblocked = resolve)
        const error = await s.failure(storageHarness.openSearchStorage({ name, openTimeoutMs: 30 }))
        hold.close(); await new Promise(resolve => upgrading.onsuccess = () => { upgrading.result.close(); resolve() })
        return error.code
    })
    expect(result).toBe('blocked')
})

test('notification failure cannot bypass transactional checks or fail a committed write', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, name = s.name(), channel = () => ({ onmessage: null, postMessage() { throw Error('Synthetic notification failure') }, close() {} })
        const a = await storageHarness.openSearchStorage({ name, channel }), doc = storageHarness.createSearchTask(s.ports()).exportDocument()
        await a.save(doc); const b = await storageHarness.openSearchStorage({ name, channel }); await a.delete()
        const stale = await s.failure(b.save(doc)); a.close(); b.close(); return stale.code
    })
    expect(result).toBe('deleted')
})

test('atomic replacement fences old revisions and an old delete cannot erase a different search', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, h = storageHarness, name = s.name(), a = await h.openSearchStorage({ name })
        const first = h.createSearchTask(s.ports()).exportDocument(); await a.save(first)
        const b = await h.openSearchStorage({ name }), replacement = h.createSearchTask(s.ports()).exportDocument()
        const denied = await s.failure(b.save(replacement)); await b.save(replacement, true)
        const deleted = await s.failure(a.delete()), written = await s.failure(a.save(first))
        const retained = b.read().searchId === replacement.searchId
        a.close(); b.close(); return { denied: denied.code, deleted: deleted.code, written: written.code, retained }
    })
    expect(result).toEqual({ denied: 'conflict', deleted: 'conflict', written: 'conflict', retained: true })
})

test('a normal save aborted after active.put success does not confirm or partially initialize storage', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, name = s.name(), p = await storageHarness.createSearchPersistence({ name, ports: s.ports() })
        p.task.addCandidate(s.address(1)); const original = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function(...args) {
            const r = original.apply(this, args)
            if (this.name === 'records' && args[1] === 'active') r.addEventListener('success', () => this.transaction.abort())
            return r
        }
        let failure
        try { failure = await s.failure(p.save()) } finally { IDBObjectStore.prototype.put = original }
        const status = p.state().status, after = await s.raw(name)
        await p.save(); const retried = p.state().status; p.close()
        return { code: failure.code, status, after, retried }
    })
    expect(result).toEqual({ code: 'write_failed', status: 'error', after: { keys: [], markerValid: false, caches: 0 }, retried: 'saved' })
})

test('unavailable IndexedDB leaves the input usable without pretending to save', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, p = await storageHarness.createSearchPersistence({ ports: s.ports(), factory: { open() { throw new DOMException('Synthetic denied', 'SecurityError') } } })
        p.task.addCandidate(s.address(1)); const initial = p.state(), failure = await s.failure(p.save())
        const retained = p.task.exportDocument().candidates.length; p.close()
        return { status: initial.status, code: initial.code, failure: failure.code, retained }
    })
    expect(result).toEqual({ status: 'error', code: 'unavailable', failure: 'unavailable', retained: 1 })
})

test('queued snapshots stay ordered and a settings warning survives new search persistence', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, p = await storageHarness.createSearchPersistence({ name: s.name(), ports: s.ports(), removeSetting: () => { throw Error('Synthetic denied') } })
        p.task.addCandidate(s.address(1)); const first = p.save(); p.task.addCandidate(s.address(2)); const second = p.save()
        await Promise.all([first, second]); const queued = p.state().status
        await p.delete(p.prepareDelete('all')); p.task.addCandidate(s.address(3)); await p.save()
        const warning = p.state().settingsCleanupPending === true && p.state().message.includes('настройки')
        p.retrySettingsCleanup(); const misleading = p.state().message.includes('Поиск удалён')
        p.close(); return { queued, warning, misleading }
    })
    expect(result).toEqual({ queued: 'saved', warning: true, misleading: false })
})

test('restoration revokes confirmations and saved status also checks search identity', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const s = synthetic, h = storageHarness, p = await h.createSearchPersistence({ name: s.name(), ports: s.ports() })
        p.task.addCandidate(s.address(1)); await p.save()
        const ticket = p.prepareDelete('search'), same = p.task.exportDocument()
        p.task.restoreDocument(same)
        const restoredTicket = await s.failure(p.delete(ticket))
        const other = h.createSearchTask(s.ports()); other.addCandidate(s.address(2))
        p.task.restoreDocument(other.exportDocument())
        const status = p.state().status, write = await s.failure(p.save())
        p.close(); return { confirmation: restoredTicket.code, status, write: write.code }
    })
    expect(result).toEqual({ confirmation: 'conflict', status: 'unsaved', write: 'conflict' })
})
