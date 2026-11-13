---
status: current
updated: 2026-11-04
verified: not verified
---

# Контракты функций

Каждая функция имеет основное место для поведения, API и ограничений. Карта модулей — [frontend](../frontend-structure.md), продуктовые границы — [product](../product.md).

## Текущее поведение

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
| Площади OSM и независимые категории | [area-analysis](area-analysis.md) |
| Территория и покрытие данных | [coverage](coverage.md) |

## Проектный контракт

[Анализ одного места](place-analysis.md) — будущий API адреса/точки, радиуса 200–1000 м, POI, спутников и станций. Пока не реализован.
