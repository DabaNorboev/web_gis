import type { AddressProfile } from '@/types/profile'

export class ProfileRequestError extends Error {
    constructor(public status: number) { super(`Address profile: HTTP ${status}`) }
}
export async function fetchAddressProfile(id: string, radius: number, signal: AbortSignal): Promise<AddressProfile> {
    const response = await fetch(`/api/v1/addresses/${encodeURIComponent(id)}/profile?radius_m=${radius}`, { signal, headers: { Accept: 'application/json' } })
    if (!response.ok) throw new ProfileRequestError(response.status)
    return response.json()
}
