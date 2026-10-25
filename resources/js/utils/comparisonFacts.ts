import type { ComparisonSide } from '@/composables/useAddressComparison'
import type { OverviewTopic } from '@/composables/useOverviewTopics'
import { comparisonGroups, comparisonMetric, type ComparisonRow } from './comparisonPresentation'
import { formatMetric } from './metricDisplay'
import type { SideKey } from './comparison'

export const comparisonRowId = (row: ComparisonRow) => `compare-metric-${row.category}-${row.key}`
const subjects: Record<OverviewTopic, string> = { transport: 'остановка', parks: 'парк', water: 'вода', roads: 'крупная дорога', railways: 'железнодорожные пути' }
const sideKeys: SideKey[] = ['left', 'right']
const topics: OverviewTopic[] = ['transport', 'parks', 'water', 'roads', 'railways']
export function comparisonFacts(sides: Record<SideKey, ComparisonSide>, radius: number, selected: readonly OverviewTopic[] | null) {
    return topics.filter(topic => selected === null || selected.includes(topic)).slice(0, 3).map(topic => {
        const row = comparisonGroups.flatMap(group => group.rows).find(row => row.category === topic && row.key.includes('distance'))!
        const subject = subjects[topic]
        const result = (text: string) => ({ topic, target: comparisonRowId(row), text })
        if (sideKeys.some(key => sides[key].status === 'loading')) return result(`${row.label}: предварительно — ждём оба профиля.`)
        if (sideKeys.some(key => {
            const side = sides[key]
            return side.status !== 'ready'
            || !side.profile
            || side.profile.address.id !== side.id
            || side.profile.radius_m !== radius
            || side.profile.blocks[topic].status !== 'READY'
        })) return result(`${row.label}: сравнение неполное — профиль или блок недоступен.`)
        const left = comparisonMetric(sides.left.profile, row), right = comparisonMetric(sides.right.profile, row)
        if (!left
            || !right
            || [left, right].some(metric => metric.quality.availability !== 'AVAILABLE'
            || metric.value === null
            || !Number.isFinite(metric.value)
            || metric.value < 0)) return result(`${row.label}: недостаточно данных для сравнения.`)
        const coverages = [sides.left.profile!.blocks[topic].data!.coverage, sides.right.profile!.blocks[topic].data!.coverage]
        // A nearest distance must also fit inside its own confirmed search extent.
        if (coverages.some((coverage, index) => !coverage
            || coverage.status !== 'COVERED'
            || coverage.radius_m !== radius
            || coverage.available_radius_m === null
            || !Number.isFinite(coverage.available_radius_m)
            || coverage.available_radius_m < Math.max(radius, [left, right][index]!.value!)
            || coverage.dataset_import_id !== [left, right][index]!.dataset_import_id)) return result(`${row.label}: недостаточно подтверждённого покрытия для сравнения.`)
        // Transport's existing API has a fixed straight-line method without method_version.
        // Environmental methods must have an explicit matching version. Unknown dates may match.
        if (left.key !== (topic === 'transport' ? 'nearest_stop_distance' : `${topic}_nearest_distance`)
            || left.key !== right.key
            || left.unit !== 'm'
            || right.unit !== 'm'
            || !left.source
            || left.source !== right.source
            || left.dataset_import_id === null
            || left.dataset_import_id !== right.dataset_import_id
            || left.quality.method !== 'DERIVED'
            || right.quality.method !== 'DERIVED'
            || left.method_version !== right.method_version
            || (topic !== 'transport' && !left.method_version)
            || left.observed_at !== right.observed_at
            || left.source_updated_at !== right.source_updated_at
            || left.quality.freshness !== right.quality.freshness
            || left.quality.reason !== right.quality.reason
            || coverages[0]!.service_boundary_sha256 !== coverages[1]!.service_boundary_sha256
            || coverages[0]!.data_boundary_sha256 !== coverages[1]!.data_boundary_sha256) return result(`${row.label}: условия данных различаются или метод неизвестен; прямой вывод не сделан.`)
        const same = formatMetric(left) === formatMetric(right)
        const text = same ? `${row.label}: одинаково при показанной точности — ${formatMetric(left)} по прямой.` : `У адреса ${left.value! < right.value! ? 'А' : 'Б'} ${subject} ближе по прямой (${formatMetric(left.value! < right.value! ? left : right)} против ${formatMetric(left.value! < right.value! ? right : left)}).`
        const caveat = left.quality.freshness === 'STALE' ? ' Данные устарели.' : left.observed_at === null ? ' Дата наблюдения неизвестна.' : left.quality.freshness === 'UNKNOWN' ? ' Актуальность неизвестна.' : ''
        return result(text + caveat)
    })
}
