---
status: current
updated: 2026-11-01
verified: not verified
---

# Контракты функций

Текущее поведение; даты исторических проверок внутри документов не означают новый прогон.

## Основные места UI-правил

| Правило | Основной документ |
|---|---|
| Поиск, группа и явный выбор объекта | [address-search](address-search.md) |
| Профиль: API, качество, прямой экран | [address-profile](address-profile.md) |
| Пара А/Б, таблица и личные ориентиры | [address-comparison](address-comparison.md) |
| Поездки: режимы, актуальность, повторы, восстановление ссылок | [trips](trips.md) |
| Машинные причины и локализация отказа | [diagnostics](local-routing-diagnostics-contract.md); выбор/guards — [car](car-street-choice.md) и [walking](walking-backend.md) |
| Точные коды нового поиска, объяснения и допустимые действия | [search-task-reasons](search-task-reasons.md); формат/локализация — diagnostics |
| Главная: камера, приоритет выбора, навигация, scroll и диалоги | [home-workspace-map](home-workspace-map.md) |
| Свободная точка: смысл и URL / подпись: метод и HTTP | [point-analysis](point-analysis.md) / [point-address](point-address.md) |
| Источник и GeoJSON слоёв | [остановки](map-stops-layer.md), [площади](map-area-layers.md), [линии](map-linear-layers.md) |
| Передача личных данных и защита журналирования | [trip-privacy](trip-privacy.md) |
| Владельцы состояния и связи модулей | [frontend-structure](../frontend-structure.md); границы стека — [architecture](../architecture.md) |

Краткое упоминание со ссылкой допустимо; подробные правила обновляются в основном месте. [Контракт поиска](../plans/search-task-contract.md) описывает цель перехода, а не работающую версию. Исторические прогоны читаются только по прямому указанию.

## Контракты

- [Реестр причин нового поиска](search-task-reasons.md).
- [Сравнение двух адресов](address-comparison.md).
- [Карта и навигация главной](home-workspace-map.md).
- [Профиль адресного объекта](address-profile.md).
- [Локальный поиск адресов](address-search.md).
- [Парки, растительные территории и площади](area-analysis.md).
- [Автомобильная уличная привязка и явный выбор](car-street-choice.md).
- [Территория сервиса и покрытие данных](coverage.md).
- [Диагностика автомобильного пилота: контракт v1](local-routing-diagnostics-contract.md).
- [Парки, растительные территории и вода на карте](map-area-layers.md).
- [Крупные дороги и железнодорожные линии на карте](map-linear-layers.md).
- [Переключаемый слой официальных остановок](map-stops-layer.md).
- [Адресная подпись точки](point-address.md).
- [Выбранная точка на главной без анализа остановок](point-analysis.md).
- [Приватность и доступ в поездках](trip-privacy.md).
- [Локальные поездки](trips.md).
- [Локальный пеший backend](walking-backend.md).
