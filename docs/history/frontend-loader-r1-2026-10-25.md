---
status: history
updated: 2026-10-27
verified: not verified
---

> Исторический материал: утверждения и результаты ниже относятся к исходному этапу. Это не текущая инструкция и не новый успешный запуск. Читать только по прямому указанию. Действующие документы выбираются через [индекс](../README.md).

# R1 — единая загрузка Vue/TypeScript в frontend-тестах

Дата: 25.10.2026. Статус: перенос выполнен; результаты завершающих проверок ниже. Это протокол R1, не независимый финальный аудит.

Исходное дерево: ветка `feature/transport-stops-import`, HEAD `7e8a39a5d340efc6ffecfb291c020d2d23b856f5`, staged-изменений нет, многочисленные исходные tracked/untracked изменения сохранены. Точные копии frontend-файлов и затрагиваемой документации, исходные staged/unstaged binary patches и status находятся вне дерева: `/tmp/placelens-r1-original/`. Git reset/clean/stash/add/commit не выполнялись.

## Карта прежних загрузчиков

| Место | Настоящие модули / компоненты | Поддержка и передаваемые зависимости до переноса |
|---|---|---|
| `support/vue-component.mjs` | TS, ProfileSummary/ProfileMetric, TransportResults, PointAddressLabel, comparison trips, overview | TypeScript CommonJS transform, Vue SFC compiler, default/named imports через явные namespaces; Vue/SSR по умолчанию. Неизвестный модуль уже отклонялся, отсутствующий named export отдельно не проверялся |
| `support/map-dependencies.mjs`, потребители map-visual/comparison-presentation/address-comparison | mapTheme/mapLabels/mapLayerPresentation/mapAnalysis, useMapTheme, profilePresentation/comparisonPresentation | ESNext transpile, regex удалял imports/exports, строка экспортов и плоские параметры new Function. Передавались реальные утилиты, Vue hooks, storage/window |
| address-search / transport-analysis / address-profile / address-comparison | Соответствующие composables, comparison и metricDisplay | Удаление imports и замена export function; вручную перечисленные возвращаемые функции. Настоящая реактивность Vue, hooks очистки и управляемый API |
| address-profile / address-search-presentation / address-comparison | MetricCard, AddressSearch, ProfileMetric, ComparisonMetric/Row/Data/MapSplit, ComparePage | Локальные SFC-компиляции, regex named aliases `as` → деструктуризация; отдельные варианты default imports. Vue/SSR, icons, search/state, компоненты и presentation в плоском объекте |
| area-layers / linear-layers / stop-layer / map-mode / map-layer-panel | CityMap, Area/Linear/StopLayerInfo, MapLayersPanel | Повторяющиеся SFC loaders: named/default imports разруливались по форме строки, CSS удалялся; сторонние модули попадали в один deps. FakeMap, worker/style, реальные theme/labels, address stubs, hooks/observers; SSR либо setup без inline template |
| address-choice | useAddressChoice/addressMap и AddressPicker | Отдельные TS/SFC transforms; named imports из Vue/choice, все default imports становились одним stub. Client render, настоящий in-memory Vue renderer, props/events/expose, mount/unmount |
| sidebar-width / comparison-view | useSidebarWidth / useComparisonView | ESNext + удаление import/export, ручное получение функции; реальные Vue refs/computed/nextTick, hooks, window/document, observers/animation frame |
| stop-groups / point-selection | stopGroups / pointSelection | Удаление export function и ручной список возвращаемых функций; внешних runtime зависимостей нет |
| trips | trips/tripFailure/tripCandidates/tripMap, useTripAnalysis, API trips, TripsPage | Несколько локальных transforms; default/named imports объединялись в deps. Vue/SSR, управляемые fetch/API, hooks, layout с настоящим slot, stub карты/picker; setup страницы извлекался regex и выполнялся с browser globals |

Всего было 21 место вызова `ts.transpileModule` в 18 файлах и 38 выражений `new Function`. Теперь по одному вызову transform/evaluator в `support/vue-component.mjs`. Regex-проверки HTML/текста, не преобразующие модули, сохранены.

## Принятые архитектурные решения

- Сохранены установленные TypeScript и Vue SFC compiler. Зависимости и runner не менялись. `loadModule` — чтение файла перед `evaluateModule`; `loadComponent` использует тот же evaluator, поддерживая прежние SSR/client/setup режимы.
- Импорты разрешаются по точным спецификаторам в явных namespaces. AST TypeScript перечисляет необходимые default/named exports с учётом aliases/type-only; неизвестный runtime импорт и отсутствующий необходимый экспорт дают понятную ошибку. CommonJS default interoperability сохранена.
- Browser globals передаются локальными аргументами, без изменения `globalThis`. Результаты вычисления модулей не кэшируются: разные mocks получают независимое состояние.
- `loadSetup` использует SFC parser и явный список bindings существующих state-тестов ComparePage/TripsPage. Это ограниченный стенд для этих тестов; остальные тесты продолжают компилировать настоящие SFC с props/slots/lifecycle.
- Таблица CityMap в map-dependencies объединяет только его import boundary. CSS явно обозначен как зависимость без Node runtime; tripMap/mapSidebarScroll подключены настоящими модулями. Остальные FakeMap/API/hooks/observers и очистка ресурсов сохранены.

Переведены address-search, transport-analysis, address-profile, address-comparison, address-choice, address-search-presentation, sidebar-width, comparison-view, stop-groups, point-selection, area-layers, linear-layers, stop-layer, map-mode, map-layer-panel, trips; также map-visual и comparison-presentation — потребители прежнего `loadUtility`. Сам `loadUtility` и локальные regex-преобразователи удалены после переноса потребителей; `map-dependencies.mjs` сохранён как таблица зависимостей. MetricCard и весь продуктовый код сохранены.

## Изменённые проверки и эквивалентность

Поведенческие assertions не менялись и не отключались. Строки всех исходных `assert.*` сверены с сохранёнными версиями; имена и фактический перечень исходных сценариев сопоставлены до/после. Проверки zero/null/малых значений, дат/происхождения/покрытия, доступа, независимости, поздних ответов, истории/приватности сохранены. Замены assertions, требующие обоснования эквивалентности, отсутствуют.

Добавлены четыре регрессии общего loader: default/named/aliased imports и re-export; type-only imports; отказ для неизвестной зависимости и отсутствующих named/default/re-export exports; изоляция двух вычислений с разными mocks и состоянием. Существующий client-render тест AddressPicker продолжает проверять реальные события и unmount; SSR профиля/сравнения/поездок сохраняет проверки props/slots, карты — lifecycle/cleanup.

Во время переноса целевые проверки обнаружили потерянные stop/map fixtures; они восстановлены из исходных копий. Полный запуск также обнаружил ошибочно удалённый aliased fixture import в profile-summary; файл восстановлен целиком до исходной версии. Эти промежуточные красные прогоны не считаются итоговым успехом и не исправлялись ослаблением assertions.

## Команды и результаты

Все Node-команды выполнялись через `docker compose exec -T --user node node …` в существующем контейнере, без установки или изменения окружения.

- До правок: `npm test` — **151/151**, skips/cancelled/todo = 0, 4702,82 мс; `npm run typecheck` — exit 0.
- Поэтапно: composables/утилиты 13/13; выбор/поиск/панель/view 17/17; карты/слои 22/22; сравнение 14/14; поездки 49/49; завершающие loader/map-mode/comparison/trips 66/66. Четыре регрессии loader отдельно также прошли. После уточнения Vue namespaces — 69/69.
- Итоговый `npm test`: **155/155**, skips/cancelled/todo = 0, **8011,98 мс**; исходные 151 фактически выполненный сценарий сохранены, добавлены только 4 loader regressions.
- Итоговый `npm run typecheck`: **exit 0**.
- Полный `npm run test:smoke`: **164/164, 5,4 мин, exit 0**. Конфигурация 4 viewport, 1 worker, retries 0 сохранена; сервер собирает настоящий app во временный outDir.
- Статическая сверка assertions/сценариев, единственного места transform/evaluation, отсутствия ссылок `loadUtility`, сохранности индекса/постороннего tracked diff и `git diff --check`: **прошла**.

Логи before-test/after-test/typecheck/smoke и результаты сверок сохранены в `/tmp/placelens-r1-original/`; браузерные артефакты — штатные `playwright-report` и `test-results/compare-smoke`.

Исходный frontend запуск был без browser smoke, итоговый — при параллельно работающем Chromium. До: 4,70 с; после: 8,01 с. Их время не является контролируемым сравнением производительности. Ускорение не заявляется: цель — одна точка исправления module transform вместо независимых regex loaders.

## Оставшиеся сомнения

`loadSetup` намеренно проверяет выбранные внутренние bindings страниц и не исполняет их render/lifecycle сам по себе; поведение в браузере страхуется отдельным полным smoke. Общий loader ограничен нынешними синхронными TS/SFC потребителями, полноценным Vite resolver он не является.

## Места, требующие независимой проверки

Отдельный финальный аудит должен оценить полноту явных dependency boundaries и сохранение намерения сценариев. Mocked frontend/browser не доказывает API/GIS/OSRM, реальные геоданные, физическое сенсорное устройство или screen reader. Эти области, опубликованные localhost assets, browser viewport/retries, manifests/lock, Compose и рабочая БД в R1 не изменялись и не проверялись.
