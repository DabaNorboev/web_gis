import type { AddressProfile } from '@/types/profile'
import { ApiRequestError, requestJson } from './errors'

export class ProfileRequestError extends ApiRequestError {
    constructor(status: number, code: string | null = null, retryAfter: string | null = null) {
        super('http', status, code, retryAfter, `Address profile: HTTP ${status}`)
    }
}
export async function fetchAddressProfile(id: string, radius: number, signal: AbortSignal): Promise<AddressProfile> {
    try {
        return await requestJson(`/api/v1/addresses/${encodeURIComponent(id)}/profile?radius_m=${radius}`, {
            signal, cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
        }) as AddressProfile
    } catch (error) {
        if (error instanceof ApiRequestError && error.kind === 'http' && error.status !== null) {
            throw new ProfileRequestError(error.status, error.code, error.retryAfter)
        }
        throw error
    }
}
