---
status: current
updated: 2026-11-04
verified: code
---

# Реестр причин для задачи поиска

Реестр машинных причин и представлений в [search/reasons.ts](../../resources/js/search/reasons.ts). Он ещё не подключён к публичному UI. Этот документ задаёт точные объяснения и действия; [diagnostics](local-routing-diagnostics-contract.md) — формат и локализацию issues.

## Источники и правила

Авторитетный набор — [reason-codes.json](../../resources/contracts/reason-codes.json), version 1. Независимое представление — [search/reasons.ts](../../resources/js/search/reasons.ts). Таблицы ниже перечисляют точные коды, группируя одинаковые объяснения; wildcard не засчитывается как запись. Изменять набор нужно вместе с backend-производителями, UI-реестром и тестом покрытия, без разбора текста reason/message. Версия/пространство кода, режимы и допустимые статусы определяются соответствующим API и diagnostic issue, а не близостью координат.

| Действие | Смысл и доступность |
|---|---|
| none | Нет операционной кнопки: например, вне покрытия. Можно отдельно редактировать условия |
| retry | «Повторить» только соответствующий отказавший запрос/блок; Retry-After соблюдается, автоповтора нет |
| refine | «Уточнить» допустимый объект/уличный конец. Для routing/road_choice нужен location start/target/both_endpoints; при route/unknown применяется inspect |
| inspect | «Подробнее»: объяснение без запуска, переноса точки или оценки неизвестного как результата |

CHOOSE — состояние выбора конца, не статус успеха поездки; UNKNOWN результата, UNKNOWN выбора и location unknown независимы. «Выбрать улицу» использует только непустой список текущего CHOOSE-ответа с проверенной идентичностью. Пустой список не позволяет выбрать придуманного кандидата; ручное уточнение допустимо только по контракту режима/конца. Сам выбор не запускает расчёт.

Вне покрытия повтор недоступен. Сервисный отказ допускает ручной повтор; отсутствие пути в статическом графе не доказывает физическую непроходимость. Наличие нескольких issues не позволяет скрыть остальные или назначить ближайший конец. Безопасный fallback для будущего неизвестного кода — inspect и объяснение неизвестности; это не запись покрытия.

## Точные коды

### Маршрутизация: checks и issues

Пространство: `routing`.

| Точные коды | Объяснение | Базовое действие |
|---|---|---|
| `SNAP_RADIUS_EXCEEDED`, `SNAP_HINT_OUTSIDE_RADIUS`, `SNAP_LIMIT_EXCEEDED`, `SOURCE_ENDPOINT_OUTSIDE_RADIUS` | Уличная точка не подтверждена в допустимом радиусе. Уточните выбор; радиус не увеличивается автоматически. | `refine` |
| `SNAP_CHOICE_REQUIRED`, `DISTINCT_SOURCE_JUNCTION_OR_EDGE_CHOICES` | Есть несколько вариантов улицы. Нужен явный выбор из проверенных предложений. | `refine` |
| `OUTSIDE_CONFIRMED_COVERAGE`, `LINE_OUTSIDE_CONFIRMED_SCOPE` | Точка или путь вне подтверждённого покрытия этого режима. Вне покрытия расчёт недоступен. | `none` |
| `ROUTER_UNAVAILABLE` | Сервис маршрутизации не ответил. Готовые независимые результаты сохранены. | `retry` |
| `SNAP_CHECK_FAILED`, `ROUTE_CHECK_FAILED`, `SOURCE_DATA_OR_BUDGET_UNAVAILABLE` | Проверку не удалось завершить в доступном бюджете или из-за отказа данных. Это не подтверждает отсутствие пути. | `retry` |
| `ROUTING_DATA_UNAVAILABLE`, `WALKING_DATA_UNAVAILABLE`, `SNAP_DATA_UNAVAILABLE`, `ROUTE_DATA_UNAVAILABLE` | Подготовленный локальный набор недоступен или изменился. Подмена источника и режима не выполняется. | `retry` |
| `SNAP_NO_SAFE_CANDIDATE`, `NO_SOURCE_POLICY_SNAP`, `ROUTER_NO_SEGMENT`, `ROUTER_ENDPOINT_MISMATCH`, `ENGINE_ENDPOINT_DIFFERS_FROM_SOURCE_CANDIDATE` | Выбранная уличная точка не получила подтверждённого сопоставления с графом. Уточните выбор. | `refine` |
| `CANDIDATE_BUDGET`, `SNAP_CANDIDATE_BUDGET`, `SNAP_SEARCH_INCOMPLETE`, `SNAP_ROAD_DATA_MISSING`, `SOURCE_ANNOTATIONS_INSUFFICIENT`, `INCOMPLETE_SOURCE_MATCH`, `SOURCE_MODEL_NOT_CONFIRMED`, `ROUTE_NOT_CONFIRMED` | Данных недостаточно для подтверждения пути или однозначности выбора. Неизвестность не означает непроходимость. | `inspect` |
| `NO_ROUTE` | В статическом графе путь не найден. Реальная невозможность поездки или прохода не установлена. | `inspect` |
| `SNAP_THROUGH_BUILDING`, `START_IN_BUILDING`, `TARGET_IN_BUILDING`, `ORIGINAL_IN_BUILDING`, `CONNECTOR_BUILDING`, `ROUTE_BUILDING`, `ROUTE_THROUGH_BUILDING`, `INDOOR_ROUTE`, `INDOOR_OR_CONVEYING_UNKNOWN` | Проверка обнаружила здание или неподтверждённый внутренний проход. Контур не подтверждает вход. | `refine` |
| `SNAP_THROUGH_WATER`, `ORIGINAL_IN_WATER`, `CONNECTOR_WATER`, `ROUTE_WATER`, `WATER_CROSSING_REVIEW` | Модель обнаружила водную преграду или неподтверждённое пересечение воды. Доступ к берегу не установлен. | `refine` |
| `SNAP_THROUGH_BARRIER`, `SNAP_THROUGH_RAILWAY`, `SNAP_CROSSES_ROAD`, `CONNECTOR_ROAD_SIDE_UNKNOWN`, `ROUTE_BARRIER_REVIEW`, `BARRIER_REVIEW`, `RAILWAY_CROSSING_REVIEW`, `RAILWAY_LEVEL_OR_CROSSING_UNKNOWN` | Пересечение ограды, дороги или железнодорожного пути не подтверждено. Близость не доказывает возможность прохода. | `refine` |
| `SNAP_NODE_ACCESS_UNKNOWN`, `SNAP_ROAD_ACCESS_UNKNOWN`, `SOURCE_NODE_ACCESS_UNKNOWN`, `SOURCE_EDGE_ACCESS_UNKNOWN`, `SOURCE_DIRECTION_OR_CONDITION_UNKNOWN`, `ACCESS_DENIED_OR_UNKNOWN`, `BARRIER_NODE_UNKNOWN`, `CONDITIONAL_ACCESS_UNKNOWN`, `ENDPOINT_ACCESS_REVIEW`, `ENDPOINT_NODE_ACCESS_REVIEW`, `GATE_ACCESS_UNKNOWN`, `LOCKED_GATE`, `MAJOR_ROAD_PEDESTRIAN_ACCESS_UNKNOWN`, `PEDESTRIAN_DIRECTION_REVIEW`, `UNSUPPORTED_OR_FORBIDDEN_HIGHWAY` | Разрешение доступа, направление или условия прохода не подтверждены. Это не универсальный вывод о юридическом запрете. | `refine` |
| `AMBIGUOUS_SOURCE_CHAIN`, `DECLARED_OSM_WAY_NOT_IN_SOURCE`, `LENGTH_MISMATCH`, `SOURCE_CHAIN_ENDPOINT_MISMATCH`, `SOURCE_CHAIN_REPRESENTATION_MISMATCH`, `SOURCE_NODE_CONTINUITY_MISMATCH`, `ZERO_LENGTH_SHAPE_SEGMENT` | Ответ маршрутизатора не удалось однозначно согласовать с сохранёнными исходными линиями. Геометрия не считается проверенной. | `inspect` |

### Разрешение адреса

Пространство: `resolver`.

| Точные коды | Объяснение | Базовое действие |
|---|---|---|
| `ADDRESS_NOT_FOUND` | Объект отсутствует в активном адресном снимке. Старые координаты не подставляются; выберите объект явно. | `refine` |
| `ADDRESS_SOURCE_UNAVAILABLE` | Адресный набор временно недоступен. Это отличается от отсутствующего объекта. | `retry` |

### Окружение

Пространство: `environment`.

| Точные коды | Объяснение | Базовое действие |
|---|---|---|
| `BLOCK_CALCULATION_FAILED` | Этот блок окружения не рассчитан из-за ошибки. Остальные блоки доступны независимо. | `retry` |
| `LAYER_CALCULATION_FAILED` | Геометрия этого слоя недоступна. Готовые показатели окружения сохранены. | `retry` |

### HTTP

Пространство: `http`.

| Точные коды | Объяснение | Базовое действие |
|---|---|---|
| `INVALID_REQUEST` | Параметры запроса не прошли проверку. Исправьте ввод перед следующим расчётом. | `refine` |
| `RATE_LIMITED` | Достигнут предел запросов. Повторите вручную после разрешённого срока; автоповтора нет. | `retry` |
| `SERVICE_UNAVAILABLE` | Сервис временно недоступен. Независимые готовые результаты сохраняются. | `retry` |
| `REQUEST_FAILED` | Запрос не выполнен. Подробности ответа не определяют ошибочный конец маршрута. | `retry` |

### Статус результата поездки

Пространство: `trip_status`.

| Точные коды | Объяснение | Базовое действие |
|---|---|---|
| `AVAILABLE` | Результат рассчитан по указанной методике и исходным условиям; реальная доступность не гарантирована. | `none` |
| `NEEDS_REFINEMENT` | Нужно уточнение по конкретным кодам диагностики. Ошибочный конец не угадывается. | `inspect` |
| `NO_PATH` | Путь не найден в графе. Это не доказательство невозможности пути в действительности. | `inspect` |
| `UNKNOWN` | Проверяемых сведений недостаточно. Причина и действие уточняются диагностикой. | `inspect` |
| `UNAVAILABLE` | Расчёт недоступен; смотрите конкретную причину отказа сервиса или данных. | `retry` |
| `OUTSIDE_PILOT` | Результат вне подтверждённого покрытия режима. | `none` |

### Статус выбора улицы

Пространство: `road_choice_status`.

| Точные коды | Объяснение | Базовое действие |
|---|---|---|
| `SELECTED` | Уличная точка выбрана; расчёт запускается отдельной кнопкой. | `none` |
| `CHOOSE` | Нужен явный выбор улицы. Он не запускает расчёт автоматически. | `refine` |
| `NONE`, `NEEDS_REFINEMENT` | Проверенного однозначного уличного выбора нет. Уточните соответствующий конец. | `refine` |
| `UNKNOWN` | Проверка улицы не завершена или данных недостаточно; это не состояние выбора CHOOSE. | `inspect` |
| `OUTSIDE_PILOT` | Уличная точка вне подтверждённого покрытия. | `none` |

## Frontend-фазы и ошибки запроса

not_calculated, queued/loading, stale, сохранение и ошибки storage не являются backend-кодами. «Не рассчитано» даёт явное «Рассчитать»; stale показывает старые условия и число без оценки порога/актуальной линии. Состояния и действия хранения — в [разделе 5 контракта](../archive/housing-search/search-task-contract.md#5-сохранение-и-удаление), без добавления маркера поколения в реестр/отчёты.

[ApiRequestError](../../resources/js/api/errors.ts) различает http, network, timeout, cancelled, invalid_response. При code из backend используется точная запись соответствующего пространства; неизвестный code не подменяется догадкой. Если code отсутствует, HTTP-состояния 422/429/5xx сопоставляются известным действиям по статусу, не тексту. Network и timeout дают разные объяснения с повтором, отмена — без повтора/обвинения сервиса, непринятый ответ — объяснение несовместимости. Обычный AbortError не доказывает таймаут: нужен TimeoutError/соответствующий signal.reason. Нормализация — explainRequestFailure, поля status/code/Retry-After сохраняются без сырых тел.

## Проверка полноты и границы

[search-api.test.mjs](../../tests/frontend/search-api.test.mjs) читает реальный backend-каталог независимо от UI-реестра и требует точную запись, непустое объяснение и явное действие. Новый код либо удалённая запись/объяснение/действие должны ломать проверку; runtime-fallback не закрывает пробел. Проверяются неизвестный код, различия UNKNOWN/CHOOSE, unknown/route location, ошибки HTTP и структура ответов. Условия кнопок с пустыми/устаревшими CHOOSE-кандидатами проверяются при подключении нового UI, не считаются выполненными одной проверкой текста реестра.

[ReasonCatalogTest](../../tests/Unit/ReasonCatalogTest.php) охватывает литералы обоих providers, guards, source chain и SQL, адресные сервисы и динамические семейства. Runtime-граница проверяет публичные причины до выпуска. Статический поиск не доказывает любую будущую ветвь: новое семейство требует обновления каталога и предметных тестов. Команды/эффекты проверок — [testing](../testing.md); этим изменением docs приложение и тесты приложения не запускались.
