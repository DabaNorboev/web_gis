---
status: current
updated: 2026-11-22
verified: not verified
---

# Контракты функций

Каждая функция имеет основное место для поведения, API и ограничений. Карта модулей — [frontend](../frontend-structure.md), продуктовые границы — [product](../product.md).

## Текущее поведение

| Правило | Основной документ |
|---|---|
| Главная: анализ адреса или точки, POI, спутник и станции | [place-analysis](place-analysis.md) |
| Поиск, группа и явный выбор объекта | [address-search](address-search.md) |
| Точные коды нового поиска, объяснения и допустимые действия | [search-task-reasons](search-task-reasons.md); [формат и локализация](local-routing-diagnostics-contract.md) |
| Свободная точка и локальная адресная подпись | [point-analysis](point-analysis.md) / [point-address](point-address.md) |
| Владельцы состояния и связи модулей | [frontend-structure](../frontend-structure.md); границы стека — [architecture](../architecture.md) |
| Площади OSM и независимые категории | [area-analysis](area-analysis.md) |
| Территория и покрытие данных | [coverage](coverage.md) |

## Сохранённые API и совместимость

| Правило | Основной документ |
|---|---|
| Профиль, сравнение и сохранённые записи | [address-profile](address-profile.md), [address-comparison](address-comparison.md) |
| Поездки, режимы и хранение ссылок | [trips](trips.md), [trip-privacy](trip-privacy.md) |
| Машинные причины отказа и проверки доступности маршрута | [diagnostics](local-routing-diagnostics-contract.md), [car](car-street-choice.md), [walking](walking-backend.md) |
| Источник и GeoJSON слоёв профиля | [остановки](map-stops-layer.md), [площади](map-area-layers.md), [линии](map-linear-layers.md) |
