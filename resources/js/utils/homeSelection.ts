import { parseComparison, type ComparisonSelection, type SideKey } from '@/utils/comparison'
import { parsePointSelection, pointSelectionUrl } from '@/utils/pointSelection'
import type { Coordinates } from '@/types/transport'

export interface HomeSelection extends ComparisonSelection {
    point: Coordinates | null
    activeSide: SideKey
    context: 'profile' | 'point'
}
export function parseHomeSelection(search: string): HomeSelection & { invalid: boolean } {
    const addresses = parseComparison(search), point = parsePointSelection(search), params = new URLSearchParams(search)
    const activeSide = params.get('side') === 'right' ? 'right' : 'left'
    return { ...addresses, point: point.point, activeSide,
        context: point.point && (params.get('context') === 'point' || (!addresses.left && !addresses.right)) ? 'point' : 'profile', invalid: point.invalid }
}
/** Root-only adapter. Existing /address, /compare, /trips and fragment versions are untouched. */
export function homeSelectionUrl(selection: HomeSelection, search = ''): string {
    const url = pointSelectionUrl({ point: selection.point, radius: selection.radius }, search)
    const params = new URLSearchParams(url.split('?')[1] ?? '')
    for (const key of ['left', 'right', 'side', 'context']) params.delete(key)
    for (const side of ['left', 'right'] as const) if (selection[side]) params.set(side, selection[side]!)
    if (selection.left || selection.right) {
        params.set('radius_m', String(selection.radius))
        if (selection.activeSide === 'right') params.set('side', 'right')
        if (selection.context === 'point' && selection.point) params.set('context', 'point')
    }
    return params.size ? `/?${params}` : '/'
}
