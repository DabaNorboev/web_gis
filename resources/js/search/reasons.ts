export type ReasonAction = 'none' | 'retry' | 'refine' | 'inspect'
export interface ReasonPresentation { explanation: string; action: ReasonAction; actionLabel: string | null }
// Deliberately independent of the backend catalogue: completeness is enforced by a test.
export const reasonRegistry: Readonly<Record<string, Readonly<ReasonPresentation>>> = (() => {
    const entries: Record<string, Readonly<ReasonPresentation>> = {}
    const labels = { none: null, retry: 'Повторить', refine: 'Уточнить', inspect: 'Подробнее' }
    function add(namespace: string, codes: string[], explanation: string, action: ReasonAction) {
        for (const code of codes) {
            const key = `${namespace}.${code}`
            if (Object.hasOwn(entries, key)) throw new Error('Duplicate reason registration')
            entries[key] = Object.freeze({ explanation, action, actionLabel: labels[action] })
        }
    }
    add('routing', ['SNAP_RADIUS_EXCEEDED', 'SNAP_HINT_OUTSIDE_RADIUS', 'SNAP_LIMIT_EXCEEDED', 'SOURCE_ENDPOINT_OUTSIDE_RADIUS'],
        'Уличная точка не подтверждена в допустимом радиусе. Уточните выбор; радиус не увеличивается автоматически.', 'refine')
    add('routing', ['SNAP_CHOICE_REQUIRED', 'DISTINCT_SOURCE_JUNCTION_OR_EDGE_CHOICES'],
        'Есть несколько вариантов улицы. Нужен явный выбор из проверенных предложений.', 'refine')
    add('routing', ['OUTSIDE_CONFIRMED_COVERAGE', 'LINE_OUTSIDE_CONFIRMED_SCOPE'],
        'Точка или путь вне подтверждённого покрытия этого режима. Вне покрытия расчёт недоступен.', 'none')
    add('routing', ['ROUTER_UNAVAILABLE'], 'Сервис маршрутизации не ответил. Готовые независимые результаты сохранены.', 'retry')
    add('routing', ['SNAP_CHECK_FAILED', 'ROUTE_CHECK_FAILED', 'SOURCE_DATA_OR_BUDGET_UNAVAILABLE'],
        'Проверку не удалось завершить в доступном бюджете или из-за отказа данных. Это не подтверждает отсутствие пути.', 'retry')
    add('routing', ['ROUTING_DATA_UNAVAILABLE', 'WALKING_DATA_UNAVAILABLE', 'SNAP_DATA_UNAVAILABLE', 'ROUTE_DATA_UNAVAILABLE'],
        'Подготовленный локальный набор недоступен или изменился. Подмена источника и режима не выполняется.', 'retry')
    add('routing', ['SNAP_NO_SAFE_CANDIDATE', 'NO_SOURCE_POLICY_SNAP', 'ROUTER_NO_SEGMENT', 'ROUTER_ENDPOINT_MISMATCH', 'ENGINE_ENDPOINT_DIFFERS_FROM_SOURCE_CANDIDATE'],
        'Выбранная уличная точка не получила подтверждённого сопоставления с графом. Уточните выбор.', 'refine')
    add('routing', ['CANDIDATE_BUDGET', 'SNAP_CANDIDATE_BUDGET', 'SNAP_SEARCH_INCOMPLETE', 'SNAP_ROAD_DATA_MISSING', 'SOURCE_ANNOTATIONS_INSUFFICIENT', 'INCOMPLETE_SOURCE_MATCH', 'SOURCE_MODEL_NOT_CONFIRMED', 'ROUTE_NOT_CONFIRMED'],
        'Данных недостаточно для подтверждения пути или однозначности выбора. Неизвестность не означает непроходимость.', 'inspect')
    add('routing', ['NO_ROUTE'], 'В статическом графе путь не найден. Реальная невозможность поездки или прохода не установлена.', 'inspect')
    add('routing', ['SNAP_THROUGH_BUILDING', 'START_IN_BUILDING', 'TARGET_IN_BUILDING', 'ORIGINAL_IN_BUILDING', 'CONNECTOR_BUILDING', 'ROUTE_BUILDING', 'ROUTE_THROUGH_BUILDING', 'INDOOR_ROUTE', 'INDOOR_OR_CONVEYING_UNKNOWN'],
        'Проверка обнаружила здание или неподтверждённый внутренний проход. Контур не подтверждает вход.', 'refine')
    add('routing', ['SNAP_THROUGH_WATER', 'ORIGINAL_IN_WATER', 'CONNECTOR_WATER', 'ROUTE_WATER', 'WATER_CROSSING_REVIEW'],
        'Модель обнаружила водную преграду или неподтверждённое пересечение воды. Доступ к берегу не установлен.', 'refine')
    add('routing', ['SNAP_THROUGH_BARRIER', 'SNAP_THROUGH_RAILWAY', 'SNAP_CROSSES_ROAD', 'CONNECTOR_ROAD_SIDE_UNKNOWN', 'ROUTE_BARRIER_REVIEW', 'BARRIER_REVIEW', 'RAILWAY_CROSSING_REVIEW', 'RAILWAY_LEVEL_OR_CROSSING_UNKNOWN'],
        'Пересечение ограды, дороги или железнодорожного пути не подтверждено. Близость не доказывает возможность прохода.', 'refine')
    add('routing', ['SNAP_NODE_ACCESS_UNKNOWN', 'SNAP_ROAD_ACCESS_UNKNOWN', 'SOURCE_NODE_ACCESS_UNKNOWN', 'SOURCE_EDGE_ACCESS_UNKNOWN', 'SOURCE_DIRECTION_OR_CONDITION_UNKNOWN', 'ACCESS_DENIED_OR_UNKNOWN', 'BARRIER_NODE_UNKNOWN', 'CONDITIONAL_ACCESS_UNKNOWN', 'ENDPOINT_ACCESS_REVIEW', 'ENDPOINT_NODE_ACCESS_REVIEW', 'GATE_ACCESS_UNKNOWN', 'LOCKED_GATE', 'MAJOR_ROAD_PEDESTRIAN_ACCESS_UNKNOWN', 'PEDESTRIAN_DIRECTION_REVIEW', 'UNSUPPORTED_OR_FORBIDDEN_HIGHWAY'],
        'Разрешение доступа, направление или условия прохода не подтверждены. Это не универсальный вывод о юридическом запрете.', 'refine')
    add('routing', ['AMBIGUOUS_SOURCE_CHAIN', 'DECLARED_OSM_WAY_NOT_IN_SOURCE', 'LENGTH_MISMATCH', 'SOURCE_CHAIN_ENDPOINT_MISMATCH', 'SOURCE_CHAIN_REPRESENTATION_MISMATCH', 'SOURCE_NODE_CONTINUITY_MISMATCH', 'ZERO_LENGTH_SHAPE_SEGMENT'],
        'Ответ маршрутизатора не удалось однозначно согласовать с сохранёнными исходными линиями. Геометрия не считается проверенной.', 'inspect')
    add('resolver', ['ADDRESS_NOT_FOUND'], 'Объект отсутствует в активном адресном снимке. Старые координаты не подставляются; выберите объект явно.', 'refine')
    add('resolver', ['ADDRESS_SOURCE_UNAVAILABLE'], 'Адресный набор временно недоступен. Это отличается от отсутствующего объекта.', 'retry')
    add('environment', ['BLOCK_CALCULATION_FAILED'], 'Этот блок окружения не рассчитан из-за ошибки. Остальные блоки доступны независимо.', 'retry')
    add('environment', ['LAYER_CALCULATION_FAILED'], 'Геометрия этого слоя недоступна. Готовые показатели окружения сохранены.', 'retry')
    add('http', ['INVALID_REQUEST'], 'Параметры запроса не прошли проверку. Исправьте ввод перед следующим расчётом.', 'refine')
    add('http', ['RATE_LIMITED'], 'Достигнут предел запросов. Повторите вручную после разрешённого срока; автоповтора нет.', 'retry')
    add('http', ['SERVICE_UNAVAILABLE'], 'Сервис временно недоступен. Независимые готовые результаты сохраняются.', 'retry')
    add('http', ['REQUEST_FAILED'], 'Запрос не выполнен. Подробности ответа не определяют ошибочный конец маршрута.', 'retry')
    add('trip_status', ['AVAILABLE'], 'Результат рассчитан по указанной методике и исходным условиям; реальная доступность не гарантирована.', 'none')
    add('trip_status', ['NEEDS_REFINEMENT'], 'Нужно уточнение по конкретным кодам диагностики. Ошибочный конец не угадывается.', 'inspect')
    add('trip_status', ['NO_PATH'], 'Путь не найден в графе. Это не доказательство невозможности пути в действительности.', 'inspect')
    add('trip_status', ['UNKNOWN'], 'Проверяемых сведений недостаточно. Причина и действие уточняются диагностикой.', 'inspect')
    add('trip_status', ['UNAVAILABLE'], 'Расчёт недоступен; смотрите конкретную причину отказа сервиса или данных.', 'retry')
    add('trip_status', ['OUTSIDE_PILOT'], 'Результат вне подтверждённого покрытия режима.', 'none')
    add('road_choice_status', ['SELECTED'], 'Уличная точка выбрана; расчёт запускается отдельной кнопкой.', 'none')
    add('road_choice_status', ['CHOOSE'], 'Нужен явный выбор улицы. Он не запускает расчёт автоматически.', 'refine')
    add('road_choice_status', ['NONE', 'NEEDS_REFINEMENT'], 'Проверенного однозначного уличного выбора нет. Уточните соответствующий конец.', 'refine')
    add('road_choice_status', ['UNKNOWN'], 'Проверка улицы не завершена или данных недостаточно; это не состояние выбора CHOOSE.', 'inspect')
    add('road_choice_status', ['OUTSIDE_PILOT'], 'Уличная точка вне подтверждённого покрытия.', 'none')
    return Object.freeze(entries)
})()
export function explainReason(namespace: string, code: string, location: 'start' | 'target' | 'both_endpoints' | 'route' | 'unknown' = 'unknown'): Readonly<ReasonPresentation> {
    const value = reasonRegistry[`${namespace}.${code}`]
    if (!value) return Object.freeze({ explanation: 'Причина не распознана этой версией. Результат не подтверждён; положение проблемы неизвестно.', action: 'inspect', actionLabel: 'Подробнее' })
    if ((namespace === 'routing' || namespace === 'road_choice_status') && value.action === 'refine'
        && !['start', 'target', 'both_endpoints'].includes(location)) {
        return Object.freeze({ ...value, explanation: `${value.explanation} Конкретный конец не установлен.`, action: 'inspect', actionLabel: 'Подробнее' })
    }
    return value
}

export function explainRequestFailure(namespace: 'routing' | 'resolver' | 'environment', failure: {
    kind: 'http' | 'network' | 'timeout' | 'cancelled' | 'invalid_response'; status: number | null; code: string | null
}): Readonly<ReasonPresentation> {
    if (failure.kind === 'http') {
        if (failure.code !== null) return explainReason(Object.hasOwn(reasonRegistry, `http.${failure.code}`) ? 'http' : namespace, failure.code)
        const code = failure.status === 422 ? 'INVALID_REQUEST' : failure.status === 429 ? 'RATE_LIMITED'
            : failure.status !== null && failure.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'REQUEST_FAILED'
        return explainReason('http', code)
    }
    if (failure.kind === 'cancelled') return Object.freeze({ explanation: 'Запрос отменён. Это не отказ сервиса.', action: 'none', actionLabel: null })
    const explanation = failure.kind === 'timeout' ? 'Запрос не завершился за отведённое время.'
        : failure.kind === 'network' ? 'Не удалось связаться с сервисом.' : 'Ответ не соответствует ожидаемому контракту и не принят.'
    return Object.freeze({ explanation, action: 'retry', actionLabel: 'Повторить' })
}
