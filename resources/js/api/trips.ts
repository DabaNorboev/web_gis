import type { TripAnalysis, TripSelection } from '@/types/trips'

export async function fetchTrips(selection: TripSelection, signal: AbortSignal): Promise<TripAnalysis> {
    const response = await fetch('/api/v1/trips/analyze', { method: 'POST', signal, cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: selection.mode, start: selection.start, places: selection.places }) })
    if (!response.ok) throw new Error(response.status === 422 ? 'Проверьте координаты и количество мест.'
        : response.status === 429 ? 'Слишком много расчётов. Подождите немного и повторите.' : 'Расчёт сейчас недоступен. Повторите позже.')
    return response.json() as Promise<TripAnalysis>
}
