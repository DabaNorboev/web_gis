import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { requestGeocoding } from '@/api/geocoding'
import { ApiRequestError } from '@/api/errors'
import type { AnalysisPoint } from '@/types/placeAnalysis'
import type { GeocodingCandidate, GeocodingLookup, GeocodingSelection } from '@/types/geocoding'

type Job = { epoch: number; operation: 'search' | 'reverse'; fields: Record<string, unknown> }
export function useGeocoding(onSelection: (value: GeocodingSelection) => void, onPreview: (value: AnalysisPoint | null) => void) {
    const query = ref(''), phase = ref('idle'), message = ref(''), now = ref(Date.now()), retryAt = ref(0), retried = ref(false)
    const lookup = shallowRef<GeocodingLookup | null>(null), preview = shallowRef<GeocodingCandidate | null>(null), selection = shallowRef<GeocodingSelection | null>(null)
    let epoch = 0, disposed = false, active = false, queued: Job | null = null, lastJob: Job | null = null
    let debounce: ReturnType<typeof setTimeout> | undefined, lookupController: AbortController | null = null, confirmationController: AbortController | null = null
    const clock = setInterval(() => { now.value = Date.now() }, 1000)
    const expired = computed(() => !!selection.value && now.value >= Date.parse(selection.value.expires_at))
    const absoluteExpired = computed(() => !!selection.value && now.value >= Date.parse(selection.value.snapshot_expires_at))
    const waitSeconds = computed(() => Math.max(0, Math.ceil((retryAt.value - now.value) / 1000)))
    const canRetry = computed(() => phase.value === 'error' && !retried.value && !!lastJob && waitSeconds.value === 0)
    const confirming = computed(() => phase.value === 'confirming')
    const errorCode = ref<string | null>(null)
    function resetDraft() {
        epoch++; clearTimeout(debounce); queued = null
        lookupController?.abort(); confirmationController?.abort(); confirmationController = null
        lookup.value = null; preview.value = null; onPreview(null)
        phase.value = 'idle'; message.value = ''; errorCode.value = null
    }
    function clearSelection() { resetDraft(); selection.value = null }
    function fail(error: unknown) {
        const e = error instanceof ApiRequestError ? error : new ApiRequestError('network')
        errorCode.value = e.code
        now.value = Date.now()
        retryAt.value = now.value + Math.min(86400, Math.max(0, Number(e.retryAfter) || 0)) * 1000
        message.value = e.kind === 'invalid_response' ? 'Ответ поиска не прошёл проверку. Выберите точку на карте.'
            : e.kind === 'timeout' ? 'Время ожидания поиска истекло. Можно выбрать точку на карте.'
                : e.code === 'GEOCODING_QUOTA_EXHAUSTED' ? 'Лимит адресного поиска исчерпан. Выберите точку на карте.'
                    : e.status === 429 ? 'Поиск временно занят. Повторите после ожидания или выберите точку на карте.'
                        : e.code === 'SNAPSHOT_EXPIRED' ? 'Срок снимка истёк. Найдите и выберите адрес заново.'
                            : 'Адресный поиск недоступен. Можно выбрать точку на карте.'
        phase.value = 'error'
    }
    function run(job: Job) {
        if (disposed || job.epoch !== epoch) return
        lastJob = job
        if (Date.now() < retryAt.value) { phase.value = 'error'; return }
        if (active) { queued = job; return }
        active = true; lastJob = job; phase.value = 'loading'; message.value = ''; errorCode.value = null
        const controller = new AbortController(); lookupController = controller
        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true; controller.abort()
            if (!disposed && job.epoch === epoch) fail(new ApiRequestError('timeout'))
        }, 10000)
        // Retain the client slot until fetch/body actually settles, including a late body reader.
        void requestGeocoding(job.operation, job.fields, controller.signal).then(response => {
            if (disposed || timedOut || job.epoch !== epoch) return
            lookup.value = response.data; phase.value = 'results'
            message.value = response.data.status === 'EMPTY' ? 'Адреса не найдены. Можно выбрать точку на карте.'
                : response.data.status === 'NO_SELECTABLE_RESULTS' ? 'Найдены только ориентиры. Уточните положение точкой на карте.' : ''
        }).catch(error => { if (!disposed && !timedOut && job.epoch === epoch) fail(error) }).finally(() => {
            clearTimeout(timer); active = false
            if (lookupController === controller) lookupController = null
            const next = queued; queued = null
            if (next && !disposed && next.epoch === epoch) run(next)
        })
    }
    watch(query, () => {
        resetDraft(); retried.value = false; lastJob = null
        const q = query.value.trim()
        if ([...q].length < 3) return
        phase.value = 'debouncing'
        const current = epoch
        debounce = setTimeout(() => run({ epoch: current, operation: 'search', fields: { q, mode: 'autocomplete' } }), 350)
    }, { flush: 'sync' })
    function search() {
        resetDraft(); retried.value = false
        if ([...query.value.trim()].length >= 3) run({ epoch, operation: 'search', fields: { q: query.value.trim(), mode: 'search' } })
    }
    function reverse(point: AnalysisPoint) {
        resetDraft(); retried.value = false
        run({ epoch, operation: 'reverse', fields: { lon: point.lon, lat: point.lat } })
    }
    function retry() {
        if (!canRetry.value || !lastJob) return
        const previous = lastJob; resetDraft(); retried.value = true
        run({ ...previous, epoch })
    }
    function choose(candidate: GeocodingCandidate) {
        if (!lookup.value?.candidates.some(c => c.candidate_id === candidate.candidate_id)) return
        epoch++; confirmationController?.abort(); lookupController?.abort(); queued = null; clearTimeout(debounce)
        preview.value = candidate; phase.value = 'preview'; message.value = ''; errorCode.value = null; onPreview(candidate.point)
    }
    async function confirm(reconfirm = false) {
        const expected = reconfirm ? selection.value : preview.value
        if (!expected || confirming.value || reconfirm && absoluteExpired.value || !reconfirm && !preview.value?.can_confirm) return
        if (!reconfirm && (!preview.value?.expires_at || Date.now() >= Date.parse(preview.value.expires_at))) {
            message.value = 'Подсказка устарела. Повторите поиск.'; return
        }
        const current = ++epoch; queued = null; clearTimeout(debounce); lookupController?.abort()
        const controller = new AbortController(); confirmationController?.abort(); confirmationController = controller
        phase.value = 'confirming'; message.value = ''; errorCode.value = null
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
                controller.abort(); reject(new ApiRequestError('timeout'))
            }, 5000) })
            const response = await Promise.race([requestGeocoding(reconfirm ? 'reconfirm' : 'confirm', reconfirm
                ? { selection_token: selection.value!.selection_token, position_confirmed: true }
                : { candidate_token: preview.value!.candidate_token, position_confirmed: true }, controller.signal, expected), deadline])
            if (disposed || current !== epoch) return
            now.value = Date.now()
            if (now.value >= Date.parse(response.data.snapshot_expires_at)) {
                phase.value = 'error'; message.value = 'Срок снимка истёк. Найдите и выберите адрес заново.'; return
            }
            selection.value = response.data; preview.value = null; lookup.value = null; onPreview(null)
            phase.value = 'selected'; now.value = Date.now(); onSelection(response.data)
        } catch (error) { if (!disposed && current === epoch) fail(error) }
        finally { clearTimeout(timer); if (confirmationController === controller) confirmationController = null }
    }
    watch(absoluteExpired, value => {
        if (value) {
            // Retain only display data after absolute expiry, never the bearer token.
            selection.value = selection.value ? { ...selection.value, selection_token: '' } : null
        }
    })
    onBeforeUnmount(() => { disposed = true; resetDraft(); clearInterval(clock); selection.value = null })
    return { query, phase, message, errorCode, lookup, preview, selection, expired, absoluteExpired, waitSeconds, canRetry, confirming,
        search, reverse, retry, choose, confirm, resetDraft, clearSelection }
}
