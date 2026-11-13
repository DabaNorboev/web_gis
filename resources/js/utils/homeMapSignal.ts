import type { HomeOrientationCell } from '@/types/homeOrientations'

export function homeMapSignal(cell: HomeOrientationCell): { short: string; detail: string } {
    let short: string
    let meaning: string
    let suffix = ''

    switch (cell.state) {
        case 'ready':
            if (cell.result.status === 'within') {
                short = '✓'
                meaning = 'значение в ориентире'
            } else if (cell.result.status === 'over') {
                short = '↑'
                meaning = 'значение выше ориентира'
            } else if (cell.result.status === 'unset') {
                short = '—'
                meaning = 'ориентир не задан'
            } else {
                short = '?'
                meaning = 'значение неизвестно'
            }
            suffix = cell.result.text
            break
        case 'loading':
            short = '…'
            meaning = 'идёт расчёт'
            break
        case 'need':
            short = 'расчёт'
            meaning = 'нужен расчёт'
            break
        case 'refinement':
            short = 'уточнить'
            meaning = 'нужно уточнить результат'
            suffix = cell.reason
            break
        case 'error':
            short = '!'
            meaning = 'ошибка расчёта'
            suffix = cell.reason
            break
        case 'unknown':
            short = '?'
            meaning = 'значение неизвестно'
            suffix = cell.reason
            break
    }

    const detail = `${cell.label}: ${cell.displayValue} — ${meaning}${suffix ? `. ${suffix}` : ''}`
    return { short, detail }
}
