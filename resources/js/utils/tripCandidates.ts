import type { Coordinates } from '@/types/transport'
import type { TripRoadCandidate } from '@/types/trips'

export interface TripCandidateGroup { key: string; label: string; candidates: TripRoadCandidate[]; selected: Coordinates | null }
// Display identity only; this tolerance never establishes road access or accepts a route.
export function sameRoadPoint(a: Coordinates | null | undefined, b: Coordinates | null | undefined): boolean {
    return !!a && !!b && Math.abs(a.lon - b.lon) < 1e-7 && Math.abs(a.lat - b.lat) < 1e-7
}
export function candidateId(key: string, index: number) { return `${key}-${index}` }

/** Pixel offsets for legible buttons. Actual coordinates remain anchored and tethered. */
export function candidateMarkerOffsets(points: { x: number; y: number }[], originals: { x: number; y: number }[]): [number, number][] {
    const offsets: [number, number][] = points.map(() => [0, 0])
    const seen = new Set<number>()
    for (let i = 0; i < points.length; i++) {
        if (seen.has(i)) continue
        const cluster = [i]; seen.add(i)
        for (let n = 0; n < cluster.length; n++) for (let j = 0; j < points.length; j++) {
            const p = points[cluster[n]!]!, q = points[j]!
            if (!seen.has(j) && Math.hypot(p.x - q.x, p.y - q.y) < 112) { seen.add(j); cluster.push(j) }
        }
        if (cluster.length === 1 && !originals.some(o => Math.hypot(o.x - points[i]!.x, o.y - points[i]!.y) < 34)) continue
        const cx = cluster.reduce((s, n) => s + points[n]!.x, 0) / cluster.length
        const cy = cluster.reduce((s, n) => s + points[n]!.y, 0) / cluster.length
        const columns = Math.min(2, cluster.length)
        cluster.forEach((n, k) => { offsets[n] = [cx + (k % columns - (columns - 1) / 2) * 112 - points[n]!.x, cy - 42 - Math.floor(k / columns) * 48 - points[n]!.y] })
    }
    return offsets
}
