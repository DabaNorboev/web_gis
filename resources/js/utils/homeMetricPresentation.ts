import { comparisonMetric, type ComparisonRow } from './comparisonPresentation'
import { availabilityNames, environmentTitles, freshnessNames, isBeyondRadius, methodNames, sourceName } from './profilePresentation'
import type { AddressProfile, AnalysisCategory, MetricResult } from '@/types/profile'
import type { TransportAnalysis } from '@/types/transport'
import type { SpatialCoverage } from '@/types/transport'
import { formatDate } from './metricDisplay'

export type HomeMetricState = 'ready' | 'loading' | 'empty' | 'not_found' | 'unavailable' | 'error'

export function metricExplanation(row: ComparisonRow): { short: string; full: string } {
    if (row.category === 'transport' && row.key === 'nearest_stop_distance') return {
        short: 'По прямой до ближайшей остановки из официального набора; подход и маршруты не проверены.',
        full: 'Расстояние измерено по прямой до ближайшей точки официального набора остановок. Это не длина пути: подход к остановке и направления движения не проверены. Радиус задаёт круг подсчёта, а не предел поиска ближайшего объекта; дальняя остановка может отсутствовать в слое карты.',
    }
    if (row.category === 'transport' && row.key === 'stops_count') return {
        short: 'Число точек остановок в круге анализа.',
        full: 'Число точек официального набора остановок внутри круга анализа заданного радиуса. Это количество точек, а не маршрутов.',
    }
    if (row.key === 'nearest_distance') {
        const title = environmentTitles[row.category as keyof typeof environmentTitles] ?? row.label
        const shape = ['roads', 'railways'].includes(row.category) ? 'линии' : 'контура'
        const qualification = row.category === 'parks' ? 'Близость не подтверждает вход или доступ.' : row.category === 'water' ? 'Близость не подтверждает доступ к берегу.' : row.category === 'roads' ? 'Близость не измеряет шум или загрязнение.' : row.category === 'railways' ? 'Близость не подтверждает движение поездов.' : ''
        const specifics = row.category === 'roads' ? 'Крупные дороги: motorway, trunk, primary, secondary.' : ['parks', 'water', 'vegetation'].includes(row.category) ? 'Внутри контура расстояние равно 0 м. Контуры OSM не подтверждают место для прогулки.' : ''
        return { short: `По прямой до ${shape}. ${qualification}`.trim(), full: `Расстояние по прямой от выбранной точки до ${shape} ближайшего объекта слоя «${title}». ${qualification} ${specifics} Радиус задаёт круг подсчёта, а не предел поиска ближайшего объекта; дальний объект может отсутствовать в слое карты.`.trim() }
    }
    if (row.key === 'share') return { short: 'Доля площади круга, покрытая объектами слоя; наложения могут присутствовать.', full: 'Отношение площади объединённой геометрии объектов слоя внутри круга анализа к площади круга. Данные могут иметь пробелы, а доли разных слоёв не складываются.' }
    if (row.key === 'area') return { short: 'Площадь объектов слоя внутри круга анализа.', full: 'Площадь объединения объектов этого слоя внутри круга анализа; наложения между разными слоями не суммируются.' }
    return { short: 'Значение рассчитано по указанным источнику и методике.', full: 'Значение, доступность и ограничения определяются ответом источника данных.' }
}

export function homeMetricPresentation(profile: AddressProfile | null, row: ComparisonRow, radius: number) {
    const metric = comparisonMetric(profile, row)
    const block = profile?.blocks[row.category]
    const data: AnalysisCategory | TransportAnalysis | undefined = block?.status === 'READY' ? block.data : undefined
    const coverage: SpatialCoverage | undefined = data?.coverage
    const nearest = data ? (row.category === 'transport' && 'nearest_stop' in data ? data.nearest_stop : 'nearest' in data ? data.nearest : null) : null
    return {
        metric,
        coverage,
        nearestName: row.key.includes('distance') ? nearest?.name ?? null : null,
        access: row.key.includes('distance') && row.category !== 'transport' && nearest && 'access' in nearest ? nearest.access ?? null : null,
        beyond: row.key.includes('distance') && isBeyondRadius(metric, coverage, radius),
        explanation: metricExplanation(row),
        source: metric ? sourceName(metric.source) : null,
    }
}

export function homeMetricStateText(state: HomeMetricState, errorMessage?: string | null): string {
    if (state === 'loading') return 'Загрузка данных…'
    if (state === 'not_found') return 'Адрес не найден в доступных данных.'
    if (state === 'unavailable') return 'Источник профиля временно недоступен.'
    if (state === 'error') return errorMessage || 'Не удалось загрузить профиль.'
    if (state === 'empty') return 'Выберите адрес для сравнения.'
    return 'Данные этой категории недоступны.'
}

export function homeMetricDetails(metric: MetricResult, coverage?: SpatialCoverage) {
    return {
        reason: metric.quality.reason,
        method: metric.quality.method ? (methodNames[metric.quality.method] ?? metric.quality.method) : 'не указан',
        availability: availabilityNames[metric.quality.availability],
        freshness: freshnessNames[metric.quality.freshness],
        source: sourceName(metric.source),
        snapshot: metric.dataset_import_id ?? 'отсутствует',
        observationDate: formatDate(metric.observed_at),
        publicationDate: formatDate(metric.source_updated_at),
        calculationDate: formatDate(metric.calculated_at),
        methodVersion: metric.method_version ?? 'не указана',
        coverageStatus: coverage?.status ?? 'неизвестен',
        coverageRadius: coverage?.available_radius_m ?? 'неизвестен',
        coverageBuffer: coverage?.buffer_m ?? 'неизвестен',
        coverageReason: coverage?.reason ?? 'Сведения об охвате отсутствуют.',
    }
}
