import type { Coordinates, TransportAnalysis } from '@/types/transport'

export async function fetchTransportAnalysis(point: Coordinates, signal: AbortSignal): Promise<TransportAnalysis> {
    const query = new URLSearchParams({ lon: String(point.lon), lat: String(point.lat) })
    const response = await fetch(`/api/v1/transport/analysis?${query}`, { signal, headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Transport analysis: HTTP ${response.status}`)
    return response.json()
}
