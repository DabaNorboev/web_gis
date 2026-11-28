import type { AirObservation } from '@/types/placeAnalysis'

const metres = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const kilometres = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })

export function airStationDistanceLabel(distance: number | null, kilometresOnly = false) {
    if (distance === null) return 'Расстояние неизвестно'
    if (kilometresOnly) return `${kilometres.format(distance / 1000)} км`
    return distance < 1000 ? `${metres.format(distance)} м по прямой` : `${kilometres.format(distance / 1000)} км по прямой`
}

const number = new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 15 })

export function airDateLabel(value: string, withYear = true) {
    const date = `${value.slice(8, 10)}.${value.slice(5, 7)}`
    return withYear ? `${date}.${value.slice(0, 4)}` : date
}

export function airHourLabel(value: string, withYear = true) {
    return `${airDateLabel(value, withYear)}, ${value.slice(11, 16)}`
}

export function airReadingLabel(row: AirObservation) {
    if (row.value !== null) return number.format(row.value)
    return row.missing_reason === 'SOURCE_ROW_MISSING' ? 'Пропущен час' : 'Пустое значение'
}
