import type { AddressSearchResponse } from '@/types/address'

export async function searchAddresses(query: string, signal: AbortSignal): Promise<AddressSearchResponse> {
    const response = await fetch(`/api/v1/addresses/search?${new URLSearchParams({ q: query })}`, {
        signal, headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Address search: HTTP ${response.status}`)
    return response.json()
}
