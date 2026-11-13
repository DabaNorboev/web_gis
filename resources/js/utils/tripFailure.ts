import type { TripDiagnosticIssue, TripResult } from '@/types/trips'

export interface TripFailureMessage {
    title: string; description: string; action: 'point' | 'road' | 'choice' | 'retry' | 'review'
    location: TripDiagnosticIssue['location']; label: string
}
export interface TripActionNotice { index: number; text: string; action: TripFailureMessage['action']; label: string }

/** Only the versioned diagnostic contract establishes location. No reason parsing,
 * proximity guesses or assumptions from the overall result status. */
export function tripFailureMessages(row: TripResult, targetLabel?: string): TripFailureMessage[] {
    if (row.status === 'AVAILABLE') return []
    const walking = row.route_scope === 'street_points'
    const issues = row.diagnostics?.version === 1 ? row.diagnostics.issues : []
    const groups = new Map<TripDiagnosticIssue['location'], TripDiagnosticIssue[]>()
    for (const issue of issues) {
        const location = (issue.location === 'target' || issue.location === 'both_endpoints') && issue.target_index !== row.index ? 'unknown' : issue.location
        const key = ['start', 'target', 'both_endpoints', 'route', 'unknown'].includes(location) ? location : 'unknown'
        groups.set(key, [...(groups.get(key) ?? []), issue])
    }
    // Older responses can establish ambiguity from the explicit per-end choices.
    if (!groups.size) {
        const start = row.road_choices?.start.status === 'CHOOSE', target = row.road_choices?.target.status === 'CHOOSE'
        groups.set(start && target ? 'both_endpoints' : start ? 'start' : target ? 'target' : 'unknown', start || target
            ? [{ code: 'SNAP_CHOICE_REQUIRED', category: 'ambiguity', stage: 'snap', location: 'unknown', target_index: null }] : [])
    }
    return [...groups].map(([location, details]) => {
        const endpoint = ['start', 'target', 'both_endpoints'].includes(location)
        const subject = location === 'start' ? 'старта' : location === 'target' ? (targetLabel ? `цели «${targetLabel}»` : `места ${row.index + 1}`) : 'старта и места'
        const label = location === 'start' ? 'Уточнить старт' : location === 'target' ? (targetLabel ? 'Уточнить цель' : `Уточнить место ${row.index + 1}`) : 'Уточнить обе точки'
        const categories = new Set(details.map(issue => issue.category))
        if (categories.has('service') || categories.has('check_failure')) return {
            title: categories.has('service') ? 'Расчёт временно недоступен' : 'Проверка пути не завершилась',
            description: 'Повторите расчёт. Менять точки не обязательно.', action: 'retry', location, label: 'Повторить расчёт',
        }
        if (categories.has('ambiguity')) return {
            title: endpoint ? `Выберите дорожную точку ${subject}` : 'Нужно выбрать дорожную точку',
            description: walking ? 'Уличная точка неоднозначна. Выберите другую улицу на карте; исходный объект сохранится.' : 'Маршрут пока не рассчитан: рядом несколько допустимых вариантов привязки. Выберите вариант в списке или на карте.',
            action: 'choice', location, label: 'Выбрать вариант',
        }
        const causes = [
            categories.has('distance') ? `В пределах ${walking ? 20 : 35} м нет подтверждённой дорожной точки.` : '',
            categories.has('obstacle') ? `В модели найдено препятствие; возможность ${walking ? 'прохода' : 'проезда'} не подтверждена.` : '',
            categories.has('access') ? `Недостаточно данных о разрешённом ${walking ? 'пешем' : 'автомобильном'} доступе.` : '',
            categories.has('coverage') ? 'Положение выходит за подтверждённую территорию пилота.' : '',
            categories.has('insufficient_data') ? 'Подготовленных сведений недостаточно для проверки пути.' : '',
        ].filter(Boolean).join(' ')
        if (endpoint) return {
            title: location === 'both_endpoints' ? 'Нужно уточнить обе привязки' : `Нужно уточнить ${location === 'start' ? 'старт' : targetLabel ? `цель «${targetLabel}»` : `место ${row.index + 1}`}`,
            description: `${causes || 'Связь с дорогой не подтверждена.'} ${walking ? 'Выберите другую уличную точку; исходный объект сохранится.' : 'Проверьте исходную точку или выберите другой проезд.'}`,
            action: 'point', location, label,
        }
        return {
            title: location === 'route' ? 'Ограничение на участке маршрута' : 'Положение проблемы неизвестно',
            description: `${causes || 'Путь не удалось подтвердить.'} ${location === 'route' ? 'Точный проблемный участок на карте не показан.' : 'Данные не указывают, какой конец или участок требует изменения.'}`,
            action: 'review', location, label: 'Проверить точки',
        }
    })
}
export function tripFailureMessage(row: TripResult): TripFailureMessage {
    return tripFailureMessages(row)[0] ?? { title: 'Путь рассчитан', description: '', action: 'review', location: 'unknown', label: 'К результату' }
}
export function tripActionNotice(row: TripResult): TripActionNotice | null {
    if (row.status === 'AVAILABLE') return null
    const message = tripFailureMessage(row)
    const count = Object.values(row.road_choices ?? {}).filter(choice => choice.status === 'CHOOSE').reduce((sum, choice) => sum + (choice.candidates?.length ?? 0), 0)
    return { index: row.index, text: `Место ${row.index + 1}: ${message.title.toLocaleLowerCase('ru')}${message.action === 'choice' && count ? ` — вариантов: ${count}` : ''}`, action: message.action, label: message.label }
}
