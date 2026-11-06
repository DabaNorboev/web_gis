import type {
    SatelliteCoverage, SatelliteData, SatelliteReleaseRef, SatelliteSelected, SatelliteWarning,
} from '@/types/placeAnalysis'

const dateFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
})
const percentFormatter = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 })
const ndviFormatter = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatObservationDate(value: string | null | undefined): string {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '—'
    return dateFormatter.format(new Date(`${value}T00:00:00Z`))
}
export function formatObtainedAt(value: string | null | undefined): string {
    if (!value || !Number.isFinite(Date.parse(value))) return '—'
    return `${dateTimeFormatter.format(new Date(value))} UTC`
}
export function formatCircleFraction(value: number): string {
    return percentFormatter.format(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)
}
export function formatMeanNdvi(value: number | null): string {
    return value === null ? '—' : ndviFormatter.format(value)
}

const reasonLabels: Record<string, string> = {
    DATE_NOT_SELECTED: 'Дата не выбрана',
    DATE_NOT_IN_CATALOG: 'Даты нет в каталоге этого круга',
    NO_PREPARED_DATA: 'Для круга нет подготовленных пикселей',
    NO_GEOGRAPHIC_DATA: 'В круге нет исходных данных',
    NO_USABLE_NDVI: 'Нет пригодных пикселей NDVI',
    SATELLITE_RELEASE_UNTRUSTED: 'Данные даты не прошли проверку',
    READ_BUDGET_EXCEEDED: 'Превышен бюджет чтения данных',
}
export function satelliteReasonLabel(value: string | null | undefined): string {
    return value ? reasonLabels[value] ?? 'Данные недоступны' : 'Данные недоступны'
}

const coverageReasonLabels: Record<string, string> = {
    nodata: 'нет данных',
    ambiguous_COG_DN1: 'неоднозначные DN',
    saturated: 'пересвет',
    cloud_shadow: 'тень облаков',
    cloud_or_cirrus: 'облака и перистые',
    unclassified: 'не классифицировано',
    SCL2_dark_or_shadow: 'тёмная поверхность или тень',
    snow: 'снег',
    defective: 'дефект',
    numerical: 'числовая ошибка',
    unsupported_SCL: 'неподдержанный SCL',
    outside_target: 'вне подготовленной области',
    outside_source_footprints: 'вне футпринтов источника',
}
export interface CoverageReason { key: string; label: string; count: number }
export function coverageReasons(coverage: SatelliteCoverage | null): CoverageReason[] {
    if (!coverage) return []
    return Object.entries(coverage.reason_counts)
        .filter(([key, count]) => key !== 'valid' && count > 0)
        .map(([key, count]) => ({ key, label: coverageReasonLabels[key] ?? key, count }))
}

export function satelliteWarnings(value: SatelliteSelected | SatelliteReleaseRef | null | undefined): SatelliteWarning[] {
    return Array.isArray(value?.warnings) ? value.warnings : []
}
export function satelliteLayerLabel(mode: 'snapshot' | 'ndvi', data: SatelliteData | null): string {
    const base = mode === 'ndvi' ? 'NDVI (Sentinel-2)' : 'Спутниковый снимок'
    const date = data?.selected.date
    return date ? `${base} · ${formatObservationDate(date)}` : base
}
export function satelliteCatalogLabel(data: SatelliteData | null): string {
    if (!data) return ''
    const count = data.available_dates.length
    return count === 0 ? 'Пригодных дат нет' : `Доступно дат: ${count}`
}
