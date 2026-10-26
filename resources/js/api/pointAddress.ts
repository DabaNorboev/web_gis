import type { Coordinates } from '@/types/transport'
import type { PointAddressResponse } from '@/types/pointAddress'

export async function resolvePointAddress(point: Coordinates, signal: AbortSignal): Promise<PointAddressResponse> {
    const response = await fetch('/api/v1/addresses/resolve-point', {
        method: 'POST', signal, cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ lon: point.lon, lat: point.lat }),
    })
    if (!response.ok) throw new Error(`Point address: HTTP ${response.status}`)
    return response.json()
}
