import type { MetricResult } from '@/types/profile'
import type { SpatialCoverage } from '@/types/transport'

export type SideKey = 'left' | 'right'
export interface ComparisonSelection { left: string | null; right: string | null; radius: number }
export function parseComparison(search: string): ComparisonSelection {
    const params = new URLSearchParams(search)
    return { left: params.get('left')?.trim() || null, right: params.get('right')?.trim() || null, radius: params.get('radius_m') === '300' ? 300 : 500 }
}
export function comparisonUrl(selection: ComparisonSelection): string {
    const params = new URLSearchParams()
    if (selection.left) params.set('left', selection.left)
    if (selection.right) params.set('right', selection.right)
    params.set('radius_m', String(selection.radius === 300 ? 300 : 500))
    return `/compare?${params}`
}
export function comparisonDifferences(left?: MetricResult, right?: MetricResult, leftCoverage?: SpatialCoverage, rightCoverage?: SpatialCoverage): string[] {
    if (!left || !right) return []
    const notes: string[] = []
    if (left.unit !== right.unit) notes.push('Единицы различаются; значения нельзя сопоставлять напрямую.')
    if (left.source !== right.source || left.dataset_import_id !== right.dataset_import_id) notes.push('Использованы разные источники или снимки данных.')
    if (left.observed_at !== right.observed_at) notes.push('Даты наблюдения различаются; у одной стороны дата может быть неизвестна.')
    if (left.source_updated_at !== right.source_updated_at) notes.push('Версии или даты публикации источника различаются.')
    if (left.quality.method !== right.quality.method || left.method_version !== right.method_version) notes.push('Методы или наличие расчётного результата различаются.')
    if (left.quality.availability !== right.quality.availability) notes.push('Доступность данных различается. Отсутствие результата не означает ноль.')
    if (left.quality.freshness !== right.quality.freshness) notes.push('Актуальность данных различается.')
    if (leftCoverage?.status !== rightCoverage?.status) notes.push('Покрытие источника различается; ограничения указаны у каждой стороны.')
    return notes
}
