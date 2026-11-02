export type ApiFailureKind = 'http' | 'network' | 'timeout' | 'cancelled' | 'invalid_response'
export class ApiRequestError extends Error {
    constructor(public kind: ApiFailureKind, public status: number | null = null,
        public code: string | null = null, public retryAfter: string | null = null,
        message = 'Запрос не выполнен. Повторите позже.') {
        super(message)
        this.name = 'ApiRequestError'
    }
}
function transportError(error: unknown, signal?: AbortSignal | null): ApiRequestError {
    const name = signal?.aborted ? (signal.reason as { name?: string } | undefined)?.name : (error as { name?: string } | null)?.name
    return new ApiRequestError(name === 'TimeoutError' ? 'timeout' : signal?.aborted || name === 'AbortError' ? 'cancelled' : 'network')
}
export async function requestJson(url: string, options: RequestInit): Promise<unknown> {
    let response: Response
    try { response = await fetch(url, options) }
    catch (error) { throw transportError(error, options.signal) }
    if (!response.ok) {
        let code: string | null = null
        try {
            const body = await response.json()
            if (typeof body?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(body.code)) code = body.code
        } catch { /* Never expose error bodies, URLs or personal input. */ }
        const message = response.status === 422 ? 'Проверьте координаты и количество мест.'
            : response.status === 429 ? 'Слишком много расчётов. Подождите немного и повторите.' : 'Расчёт сейчас недоступен. Повторите позже.'
        throw new ApiRequestError('http', response.status, code, response.headers?.get('Retry-After') ?? null, message)
    }
    try { return await response.json() }
    catch (error) {
        if (options.signal?.aborted || ['TimeoutError', 'AbortError'].includes((error as { name?: string })?.name ?? '')) throw transportError(error, options.signal)
        throw new ApiRequestError('invalid_response')
    }
}
