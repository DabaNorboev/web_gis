import type { MapLayerContext, MapLayerKey } from '@/types/mapLayers'

export const mapLayerDefinitions = [
    { key: 'stops', label: 'Официальные остановки', symbol: 'stop', color: '#708cad' },
    { key: 'parks', label: 'Парки', symbol: 'area', color: '#247346' },
    { key: 'vegetation', label: 'Растительные территории', symbol: 'area-dashed', color: '#879326' },
    { key: 'water', label: 'Водные объекты', symbol: 'area', color: '#287db0' },
    { key: 'roads', label: 'Крупные дороги', symbol: 'line', color: '#b45d17' },
    { key: 'railways', label: 'Железнодорожные линии', symbol: 'line-dashed', color: '#68427f' },
] as const

// Only describe the supplied snapshot. An empty collection is not a real-world absence.
export function mapLayerNotice(key: MapLayerKey, context: MapLayerContext): string | null {
    if (context.loading) return 'Загрузка данных…'
    const profile = context.profile
    if (!profile) return 'Данные недоступны для этого варианта.'
    if (key === 'stops') {
        const data = profile.blocks.transport.data
        if (!data || data.metrics.stops_count.dataset_import_id == null || ['UNKNOWN', 'OUTSIDE_SERVICE_AREA'].includes(data.coverage.status)) return 'Слой недоступен.'
        if (data.coverage.status === 'PARTIAL') return 'Неполное покрытие радиуса.'
        return data.stops_in_radius.length ? null : 'В снимке не найдены точки в радиусе.'
    }
    const layer = key === 'roads' || key === 'railways' ? profile.map.linear_layers?.[key] : profile.map.area_layers?.[key]
    const data = layer?.data
    if (!data || data.quality.availability === 'UNAVAILABLE' || ['UNKNOWN', 'OUTSIDE_SERVICE_AREA'].includes(data.coverage.status)) return 'Слой недоступен.'
    if (data.coverage.status === 'PARTIAL') return 'Неполное покрытие радиуса.'
    if (data.quality.availability === 'INSUFFICIENT_DATA') return 'Недостаточно данных.'
    return data.features.length ? null : 'В снимке не найдены объекты в области.'
}
