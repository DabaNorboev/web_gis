export type OrientationStatus = 'unset' | 'unavailable' | 'within' | 'over'

export interface OrientationResult {
    status: OrientationStatus
    value: number | null
    threshold: number | null
    text: string
    reason: string
}

export function parseOrientation(text: string): { value: number | null; error: string } {
    const normalized = text.trim().replace(',', '.')
    if (normalized === '') return { value: null, error: '' }
    if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
        return { value: null, error: 'Введите положительное число.' }
    }
    const value = Number(normalized)
    if (!Number.isFinite(value)) return { value: null, error: 'Число должно быть конечным.' }
    if (value <= 0) return { value: null, error: 'Значение должно быть больше нуля.' }
    return { value, error: '' }
}

function formatNumber(value: number): string {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)
}

function overText(value: number, threshold: number, unit: 'minutes' | 'meters'): string {
    if (unit === 'minutes') {
        const excessSeconds = value - threshold * 60
        // Avoid overflow in threshold * 60 for very large minute values.
        const exceedsByRatio = value / 60 - threshold
        const safeExcess = Number.isFinite(excessSeconds) ? excessSeconds : exceedsByRatio * 60
        if (safeExcess < 60 || exceedsByRatio < 1) return '↑ менее 1 мин сверх'
        const wholeMinutes = Math.floor(safeExcess / 60)
        const seconds = Math.floor(safeExcess - wholeMinutes * 60)
        return seconds > 0
            ? `↑ ${formatNumber(wholeMinutes)} мин ${formatNumber(seconds)} с сверх`
            : `↑ ${formatNumber(wholeMinutes)} мин сверх`
    }
    const excess = value - threshold
    return excess < 1 ? '↑ менее 1 м сверх' : `↑ ${formatNumber(excess)} м сверх`
}

export function compareOrientation(
    value: number | null,
    threshold: number | null,
    unit: 'minutes' | 'meters',
    reason = 'Значение неизвестно.',
): OrientationResult {
    if (threshold === null || !Number.isFinite(threshold) || threshold <= 0) {
        return { status: 'unset', value, threshold, text: 'Ориентир не задан.', reason: '' }
    }
    if (value === null || !Number.isFinite(value) || value < 0) {
        return { status: 'unavailable', value: null, threshold, text: 'Недостаточно данных для сравнения.', reason }
    }
    const limit = unit === 'minutes' ? threshold * 60 : threshold
    const within = value <= limit
    return within
        ? { status: 'within', value, threshold, text: '✓ В ориентире', reason: '' }
        : { status: 'over', value, threshold, text: overText(value, threshold, unit), reason: '' }
}

export function orientationScale(
    results: OrientationResult[],
    unit: 'minutes' | 'meters',
): { maximum: number; thresholdPercent: number | null; values: (number | null)[] } {
    const normalized = results.map(result => result.value !== null && Number.isFinite(result.value)
        ? unit === 'minutes' ? result.value / 60 : result.value
        : null)
    const thresholds = results.map(result => result.threshold !== null && Number.isFinite(result.threshold) && result.threshold > 0
        ? result.threshold
        : null)
    let largest = 0
    for (const value of [...normalized, ...thresholds]) if (value !== null && value > largest) largest = value
    const padded = largest > 0 ? largest * 1.1 : 1
    const maximum = Number.isFinite(padded) ? padded : largest
    const percent = (value: number | null): number | null => value === null ? null : value / maximum * 100
    return {
        maximum,
        thresholdPercent: percent(thresholds.reduce<number | null>((largestThreshold, value) =>
            value !== null && (largestThreshold === null || value > largestThreshold) ? value : largestThreshold, null)),
        values: normalized.map(value => percent(value)),
    }
}
