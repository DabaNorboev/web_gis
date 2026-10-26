import { isBeyondRadius, environmentTitles } from './profilePresentation'
import type { AddressProfile, EnvironmentKind, MetricResult } from '@/types/profile'
import type { SpatialCoverage } from '@/types/transport'
export type ComparisonCategory = 'transport' | EnvironmentKind
export type ComparisonRow = { category: ComparisonCategory; key: string; label: string }
export const comparisonGroups: { title: string; rows: ComparisonRow[]; note: string }[] = [
    { title: 'Транспорт', rows: [
        { category: 'transport', key: 'nearest_stop_distance', label: 'Ближайшая остановка' },
        { category: 'transport', key: 'stops_count', label: 'Точек остановок в радиусе' },
    ], note: 'До остановки — по прямой. Подход и направления не проверены.' },
    { title: 'Парки и вода', rows: (['parks', 'water'] as const).map(category => ({ category, key: 'nearest_distance', label: environmentTitles[category] })), note: 'До контура по прямой. Вход в парк и доступ к берегу не подтверждены.' },
    { title: 'Дороги и пути', rows: (['roads', 'railways'] as const).map(category => ({ category, key: 'nearest_distance', label: environmentTitles[category] })), note: 'До линии по прямой. Близость не определяет шум или загрязнение; движение поездов не подтверждено.' },
]
export const comparisonExtraRows: ComparisonRow[] = [
    { category: 'vegetation', key: 'nearest_distance', label: environmentTitles.vegetation },
    ...(['parks', 'vegetation', 'water'] as const).flatMap(category => [
        { category, key: 'share', label: `${environmentTitles[category]} · доля круга` },
        { category, key: 'area', label: `${environmentTitles[category]} · площадь` },
    ]),
]
export function comparisonMetric(profile: AddressProfile | null, row: ComparisonRow): MetricResult | undefined {
    return (profile?.blocks[row.category].data?.metrics as Record<string, MetricResult> | undefined)?.[row.key]
}
export function bothBeyondRadius(left: MetricResult | undefined, right: MetricResult | undefined, leftCoverage: SpatialCoverage | undefined, rightCoverage: SpatialCoverage | undefined, radius: number): boolean {
    return isBeyondRadius(left, leftCoverage, radius) && isBeyondRadius(right, rightCoverage, radius)
}
