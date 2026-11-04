// User-facing strings only. Keep technical names in implementation, not here.
export const searchCopy = {
    brand: 'PlaceLens',
    search: 'Мой поиск',
    skip: 'К содержимому',
    navigation: 'Разделы поиска',
    sections: { conditions: 'Условия', territory: 'Территория', addresses: 'Адреса', comparison: 'Сравнение', visit: 'Просмотр' },
    unavailable: 'Раздел пока недоступен',
    conditions: 'Добавьте важные места, чтобы учитывать поездки до них при выборе адреса.',
    addresses: 'Здесь можно будет добавить до пяти адресов и выбрать два для сравнения.',
    empty: 'Начните с того, что уже знаете',
    placesFirst: 'Пока не знаю, где искать',
    addressesFirst: 'Уже есть варианты',
    pending: 'Добавление мест и адресов появится на следующих шагах. Расчёты ещё не выполняются.',
    map: 'Карта',
    mapUnavailable: 'Карта пока недоступна',
    temporary: 'Изменения пока не сохраняются',
} as const

export type SearchSection = 'conditions' | 'addresses'
