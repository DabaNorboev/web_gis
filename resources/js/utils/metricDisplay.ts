import type { MetricResult } from '@/types/profile'

export function formatMetric(metric: MetricResult): string {
    if (metric.value === null) return metric.quality.availability === 'INSUFFICIENT_DATA' ? 'Недостаточно данных' : 'Данные недоступны'
    const unit = ({ m: 'м', m2: 'м²', '%': '%', count: '' } as Record<string, string>)[metric.unit] ?? metric.unit
    const minimum = metric.unit === '%' ? 0.1 : 1
    if (metric.value > 0 && metric.value < minimum) return `<${metric.unit === '%' ? '0,1' : '1'} ${unit}`.trim()
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: metric.unit === '%' ? 1 : 0 }).format(metric.value)} ${unit}`.trim()
}
export function formatDate(value: string | null | undefined): string {
    return value ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC' }).format(new Date(value)) : 'неизвестна'
}
export function profileUrl(id: string, radius = 500): string {
    return `/address/${encodeURIComponent(id)}?radius_m=${radius}`
}
