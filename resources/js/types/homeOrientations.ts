import type { Ref } from 'vue'
import type { TripMode } from './trips'
import type { OrientationResult } from '@/utils/homeOrientation'
import type { useHomeOrientations } from '@/composables/useHomeOrientations'
export type HomeOrientationTarget = { kind: 'trip'; scenario: 'addresses' | 'standalone'; placeId: string; mode: TripMode } | { kind: 'stop' }
export interface HomeOrientationCell {
    key: string
    side: 'left' | 'right' | 'start'
    label: string
    displayValue: string
    state: 'ready' | 'loading' | 'error' | 'need' | 'refinement' | 'unknown'
    reason: string
    result: OrientationResult
    percent: number | null
}
export interface HomeOrientationGroup {
    key: string
    target: HomeOrientationTarget
    title: string
    unit: 'minutes' | 'meters'
    threshold: number | null
    thresholdPercent: number | null
    cells: HomeOrientationCell[]
    explanation: string
}
export interface HomeOrientationContext {
    owner: ReturnType<typeof useHomeOrientations>
    enabled: Ref<boolean>
    edit: (target: HomeOrientationTarget, event: MouseEvent) => void
}
