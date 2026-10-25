import type { AddressProfile, EnvironmentKind, MetricResult } from '@/types/profile'
import type { SpatialCoverage } from '@/types/transport'
type SourceRow = { metric: MetricResult; coverage: SpatialCoverage; labels: string[] }

/** Presentation only. Distances and quality always come from the API. */
export const environmentGroups: { title: string; kinds: EnvironmentKind[] }[] = [
    { title: 'Парки и вода', kinds: ['parks', 'water'] },
    { title: 'Дороги и пути', kinds: ['roads', 'railways'] },
]
export const environmentTitles: Record<EnvironmentKind, string> = {
    parks: 'Ближайший парк', water: 'Вода', roads: 'Крупная дорога', railways: 'Железнодорожные пути', vegetation: 'Растительные территории',
}
export function isBeyondRadius(metric: MetricResult | undefined, coverage: SpatialCoverage | undefined, radius: number): boolean {
    // Missing/uncertain coverage must remain visible, even if a distance was returned.
    return coverage?.status === 'COVERED' && metric?.quality.availability === 'AVAILABLE'
        && metric.value !== null && Number.isFinite(metric.value) && metric.value > radius
}
export function sourceName(source: string): string {
    return source === '24bpd' ? 'Официальный набор остановок' : source
}
export const freshnessNames = { CURRENT: 'актуальные', STALE: 'устаревшие', UNKNOWN: 'неизвестна' }
export const methodNames: Record<string, string> = { DIRECT: 'Исходные данные', DERIVED: 'Расчёт по данным', PROXY: 'Косвенная оценка' }
export const availabilityNames = { AVAILABLE: 'Результат доступен', INSUFFICIENT_DATA: 'Недостаточно данных', UNAVAILABLE: 'Данные недоступны' }

export function profileSources(profile: AddressProfile, options: { includeAreas?: boolean } = {}) {
    const entries: { label: string; metric: MetricResult; coverage: SpatialCoverage }[] = []
    const errors: { title: string; message: string }[] = []
    const transport = profile.blocks.transport
    if (transport.status === 'ERROR') errors.push({ title: 'Остановки', message: transport.message })
    else {
        entries.push({ label: 'Ближайшая остановка', metric: transport.data.metrics.nearest_stop_distance, coverage: transport.data.coverage })
        entries.push({ label: 'Число остановок', metric: transport.data.metrics.stops_count, coverage: transport.data.coverage })
    }
    for (const kind of ['parks', 'water', 'roads', 'railways', 'vegetation'] as EnvironmentKind[]) {
        const block = profile.blocks[kind]
        if (block.status === 'ERROR') errors.push({ title: environmentTitles[kind], message: block.message })
        else for (const key of ['nearest_distance', 'share', ...(options.includeAreas ? ['area'] : [])]) {
            const metric = block.data.metrics[key]
            if (metric) entries.push({ label: `${environmentTitles[kind]} · ${key === 'share' ? 'доля круга' : key === 'area' ? 'площадь' : 'расстояние'}`, metric, coverage: block.data.coverage })
        }
    }
    const rows = new Map<string, SourceRow>()
    for (const { label, metric, coverage } of entries) {
        // Do not merge different snapshots, coverage, reasons, methods or timestamps.
        const key = JSON.stringify([metric.source, metric.dataset_import_id, metric.observed_at, metric.source_updated_at ?? null,
            metric.calculated_at, metric.method_version ?? null, metric.quality, coverage])
        const row = rows.get(key)
        if (row) row.labels.push(label)
        else rows.set(key, { metric, coverage, labels: [label] })
    }
    const sections = new Map<string, { metric: MetricResult; coverage: SpatialCoverage; rows: SourceRow[] }>()
    for (const row of rows.values()) {
        const { metric, coverage } = row
        // Factor only shared provenance. Each row keeps its own explanation;
        // different reasons are never combined into a general statement.
        const key = JSON.stringify([metric.source, metric.dataset_import_id, metric.observed_at, metric.source_updated_at ?? null,
            metric.calculated_at, metric.method_version ?? null, metric.quality.method, metric.quality.availability, metric.quality.freshness, coverage])
        const section = sections.get(key)
        if (section) section.rows.push(row)
        else sections.set(key, { metric, coverage, rows: [row] })
    }
    return { rows: [...rows.values()], sections: [...sections.values()], errors }
}
