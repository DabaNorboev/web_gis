---
status: current
updated: 2026-11-02
verified: not verified
---

# Фронтенд PlaceLens

Работающая версия по исходникам `fe6f92d`, без нового runtime-прогона. Целевая замена оболочки и владельца состояния — [контракт задачи поиска](plans/search-task-contract.md) и [карта изменений](plans/interface-replacement-plan.md); новая оболочка ещё не подключена. Изолированное ядро П1 описано ниже.

## Каталоги и соглашения

Vue/TypeScript — `resources/js`, CSS — `resources/css`, оболочка Blade — `resources/views/welcome.blade.php`.

| Каталог в resources/js | Ответственность |
|---|---|
| `pages` | Сборка сценария страницы, связь состояния с UI и DOM-эффектами |
| `layouts` | Общий каркас/навигация, сейчас PlaceLayout |
| `components` | Отображение и конкретные взаимодействия; `map` — карты/управление; `ui` — место для генерируемых shadcn-компонентов по необходимости |
| `composables` | Реактивное состояние и жизненный цикл запросов/выбора |
| `search` | Чистое ядро нового поиска; документ, результаты в памяти и команды, пока без подключения к UI |
| `api` | HTTP к Laravel, без GIS и владения состоянием страницы |
| `types` | Контракты ответов и локального выбора |
| `utils` | Чистые преобразования, форматирование, подготовка display data |
| `maps` | Стиль подложки; не источник аналитических показателей |

Компоненты — PascalCase и script setup с TypeScript; composables — use*. Локальные типы держать рядом с кодом, общие — в types. Алиас `@` указывает на resources/js в Vite и tsconfig. TypeScript 6 закреплён для совместимости с vue-tsc; проверка — [testing](testing.md).

## Ядро нового поиска: П1

[search/task.ts](../resources/js/search/task.ts) предоставляет `createSearchTask({ nextId, now })`: один независимый owner, команды редактирования/расчёта, `snapshot`, `exportDocument`, проекции `trip`/`environment`/`annotations`. Документ, runtime и view раздельны; наружу возвращаются копии, замороженные на всех уровнях. [types](../resources/js/search/types.ts) задаёт локальные типы, [document](../resources/js/search/document.ts) — проверку ввода и явную проекцию без runtime. Это не формат хранения или ссылки.

Ядро реализует постоянные ID, лимиты и независимость из [целевого контракта](plans/search-task-contract.md). Расчёт возвращает намерения по ячейкам с token и снимком условий, не HTTP-запросы. `markLoading`/`acceptResult`/`rejectRequest` принимает будущий адаптер; token действует только у своего owner и до изменения зависимости. Группировка этих намерений в API-запросы, очередь, реестр действий и проверка backend response остаются следующим поставкам. Нельзя подключать непроверенный HTTP-ответ напрямую к `acceptResult`.

Восстановление документа очищает runtime и требует разрешения адресных ID. `resolutionRequest`/`applyResolution` — чистая граница, без вызова resolver; пропавший ID не заменяется сохранёнными координатами. Неразрешённое место/кандидат не блокирует независимые задания. Замена исходной точки сбрасывает зависимости; обнаруженная смена известного снимка источника делает их stale. Порог/роль не меняют отпечаток поездки. Stale и ожидающая повторная проверка не получают текущую оценку порога или маршрутную линию.

П1а разделяет обычную смену и замену missing: `changeCandidateAddress` добавляет отдельного кандидата с новым ID, оставляя прежний вариант/пару/данные. Старого `replaceCandidateAddress` нет. `prepareMissingCandidateReplacement` требует завершённого resolver-состояния missing и фиксирует адрес, заметки, удаляемые отметки/hints и роли. `replaceMissingCandidate` принимает только своё неизменённое подтверждение при прежних generation/documentRevision и том же resolver-evidence; замена с новым ID выполняется за одну ревизию даже при пяти кандидатах. Старый slot переходит новому ID по подтверждённому перечню, просмотр возвращается к адресам; расчёт не запускается.

Переносятся только заметки: `previousObject` хранит исходный candidateId/адрес, а basis и время пользовательской правки сохраняются. `annotations` даёт постоянную пометку «Относилось к прежнему объекту» и needsReview; повторная замена/правка текста/restore не стирают происхождение. Чек-лист, результаты и street choices не переносятся. Исправление координат того же OSM ID в источнике остаётся обновлением существующего кандидата, без переноса заметок.

`exportDocument` сохраняет исходные сведения о выборе и основания заметок/отметок, включая ссылки на удалённые места для пересмотра; результаты и calculatedAt туда не входят. Реального storage, сохранения/подтверждения удаления, Vue provide/inject, HTTP и публичного UI пока нет. Регрессии — [search-task.test.mjs](../tests/frontend/search-task.test.mjs) через существующий TS loader; порядок подключения — [план поставок](plans/search-task-delivery-plan.md).

## Хранение нового поиска: П3

[search/storage.ts](../resources/js/search/storage.ts) — IndexedDB `placelens-search-v1`, версия БД 1: `records` (`generation`, `active`) и `cache`. `active` содержит `schemaVersion: 1`, `storageRevision` и allowlisted-документ с `searchId`; метрики, calculatedAt и геометрия результата не проходят проекцию. Маркер не экспортируется. Соединение после close/versionchange не переоткрывается для записи; неизвестный/повреждённый формат сохраняется без перезаписи. Протокол и окно гонки — [контракт](plans/search-task-contract.md#поколение-и-защита-от-старой-вкладки).

[search/persistence.ts](../resources/js/search/persistence.ts) — новый независимый адаптер ядра, не старый composable. `createSearchPersistence({ ports })` восстанавливает ввод без результатов; предоставляет `task`, `state`, `save`, `prepareDelete`/`delete`, `reload`, `check`, `retrySettingsCleanup`, `close`. Подтверждение связано с ревизией и экземпляром; на время удаления правка через facade запрещена. Сброс runtime отзывает поздние tokens даже при abort. Новые состояния не подключены к публичному UI; watcher/HTTP/автозапуска нет. П4 будет вызывать сохранение после явных команд редактирования и `check` при возврате фокуса; BroadcastChannel — только подсказка, CAS остаётся обязательным.

«Сохранено» относится только к завершённой текущей ревизии. Удаляющая вкладка принимает поколение при complete и может сохранить новый поиск без reload. Очистка известных localStorage-ключей и reset настроек в памяти — отдельные эффекты после commit; частичная ошибка остаётся через `settingsCleanupPending`, повтор очистки не удаляет поиск повторно. Порты cancelRequests/resetSettings подключаются новым UI в П4; старые composables не импортируются.

Проверки в уже подготовленном `node` (пользователь `node`):

```bash
docker compose exec --user node node node --test tests/frontend/search-task.test.mjs tests/frontend/search-storage.test.mjs
docker compose exec --user node node node node_modules/@playwright/test/cli.js test --config tests/browser/search-storage.config.mjs
```

Если `node` остановлен, одноразовый `docker compose run --rm --no-deps --user node node ...` запускает только этот процесс без портов и зависимых сервисов. Стенд собирает только storage/kernel-entry во временный `/tmp/search-storage-*`, слушает `127.0.0.1:4178`, использует отдельный browser context с синтетическим origin/IDB. API/карта/приложение не собираются и не запускаются. Выход по умолчанию `test-results/search-storage`, отдельный новый путь задаётся `STORAGE_TEST_OUTPUT`. Существующий app smoke/config не менялся.

Нужен доступный Chromium: обычный Playwright, либо `STORAGE_CHROMIUM` с путём внутри контейнера. Альтернатива для подготовленного внешнего Chrome — `STORAGE_CDP_URL` только к отдельному временному профилю, не пользовательскому; node и браузеру нужен общий localhost (временный network override), без публикации CDP. Сеанс и профиль после прогона закрыть. Проверка моделирует quota/abort/сбой настроек, но транзакции и гонки исполняет настоящий IndexedDB; это не проверка реальных устройств/GIS.

## Загрузка и страницы

`app.js` монтирует HomePage на `/`, лениво загружает AddressProfilePage на `/address/:id`, ComparePage на `/compare`, TripsPage на `/trips`. Laravel отдаёт одну Blade-оболочку при прямом открытии/reload. Обычные ссылки и history API покрывают нынешний объём; отдельного Vue Router/глобального store нет.

| Сценарий | Основные модули и ownership |
|---|---|
| Поиск/объект | AddressSearch → useAddressSearch → api/addresses; AddressPicker/useAddressChoice разделяют группу и конкретный объект. Наведение/фокус не подтверждают выбор |
| Главная/точка | HomePage → useHomeWorkspace хранит точку; PointAddressLabel независимо определяет приблизительную подпись. Запрос остановок для точки выключен |
| Подпись точки | PointAddressLabel → usePointAddress → api/pointAddress; независимые loading/error/retry и явный выбор при неоднозначности. Используется и в TripPointPicker |
| Профиль | AddressProfilePage/useAddressProfile → api/profiles. ProfileSummary/ProfileMetric и profilePresentation показывают обзор/метаданные; страница владеет радиусом/историей/связью карты |
| Сравнение | ComparePage/useAddressComparison → тот же api/profiles; независимые стороны и общий радиус. ComparisonMetricRow → ComparisonMetric compact → ProfileMetric, сведения — ComparisonData |
| Поездки отдельно | TripsPage → useTripsState → useTripAnalysis → api/trips. useTripsState владеет черновиком, сохранением/инвалидацией результатов и дорожными кандидатами; страница — URL/history, представлением, режимом выбора точки и DOM-эффектами |
| Поездки сравнения | useComparisonTrips владеет целями/ячейками/epoch; useComparisonLink — fragment/restore и согласование записей URL с адресным query; ComparePage — контекст карты и DOM-эффекты. ComparisonTrips/TripPointPicker и ComparisonShare/ComparisonTripData отображают действия/сведения |
| Интересы | useOverviewTopics, OverviewTopics, comparisonFacts; один набор для профиля/сравнения, localStorage с обработкой отказа. Ссылка не передаёт предпочтения |

MetricCard.vue и прежние AreaLayerControls/LinearLayerControls пока остаются в дереве, но не входят в entry graph приложения. MetricCard ещё используется прямым SSR-тестом. Это кандидаты [аудита](research/structure-quality-audit.md), не удалённый этой задачей код.

Оба сценария поездок выбирают `driving`/`walking`. `WalkingTripDetails` показывает
только уличные метрики, отдельные объекты/улицы и неизвестные подходы. Выбор улиц
хранится отдельно от объекта; matched endpoints не становятся явным выбором
автоматически. HTTP-граница `api/trips` сверяет identity и walking scope/null-контракт.
Пешая карта показывает выбранные улицы и проверенную линию, без соединителей
от объекта к улице. Основной контракт поведения и ссылок — [trips](features/trips.md).

## Состояние и побочные эффекты

<a id="два-представления-интерфейса"></a>

### Рабочий интерфейс

Главная всегда открывает workspace. `useInterfacePreference` — совместимая заглушка без чтения/записи storage; classic не включается. `PlaceLayout` содержит бренд и город, без переключателя версий. Прямые страницы сохраняют самостоятельные владельцы и URL.

| Ответственность главной | Владелец и граница |
|---|---|
| А/Б, радиус, профили, свободная точка, контекст | `useHomeWorkspace` переиспользует `useAddressComparison`; точка хранится через `useTransportAnalysis` с выключенным HTTP. `PointAddressLabel` независимо получает подпись |
| Поездки | Один `useHomeTrips` связывает `useComparisonTrips` и `useTripsState`: черновики раздельны, mode общий. Старт адресной поездки зависит от готового профиля. Это нынешняя модель, не будущие постоянные кандидаты |
| Редактор и строки результата | `HomeTripsPanel` готовит entries/actions и размещает `HomeTripsEditor` через Teleport. `HomeAddressResults`, `HomeTripCell`, `HomeMetricCell`, `HomeResultDialog` отображают данные без собственных loaders; типы — `homeResults`/`homeWorkspace`, объяснения — `homeMetricPresentation` |
| Ориентиры | Один `useHomeOrientations` вне вкладок; только память страницы, ключ по сценарию/цели/режиму. Чистые правила — `homeOrientation`; UI правки находится в редакторе цели. Совместимые старые компоненты/типы не означают, что модальное окно или настройка остановки доступны |
| URL | `useHomeLocation` — единственный writer главной, согласует query и fragments `places`/`trip`, дедуплицирует popstate/hashchange и не записывает восстановление обратно. Restore поездок запускает перепроверку; точные условия — [trips](features/trips.md#единое-пространство-на-главной) |
| Карта | Одна `HomeWorkspaceMap` оборачивает CityMap. `homeMapEntity/homeMapOverview/homeMapSignal` строят представление текущих результатов. Идентичность/контекст/sequence проверяются при действии; request-local index не становится ID цели |
| DOM и камера | HomePage владеет разделом, мобильной областью, scroll, диалогом поиска, выбранной целью и явным намерением камеры. `HomeMapDetails` возвращает к ячейке по `HomeTripRef`; `homeDialog` ограничивает фокус открытого окна |

`useHomeWorkspace` и `useHomeTrips` создаются один раз, вне условий вкладки; второго загрузчика профилей и MapLibre нет. Один `AddressPicker` сохраняет черновик, hover/focus не подтверждают объект. Подключение выбора/улиц описывают `types/homeWorkspace.ts`, [поездки](features/trips.md) и [контракт карты](features/home-workspace-map.md).

HomePage.section управляет четырьмя вкладками результата. Мобильные области «Сравнение / Карта / Настройки» сохраняют DOM и отдельный scroll; скрытые области inert. Команды карты ждут ready и отменяются при смене контекста/цели/mode/sequence. Ответ, слой, тема и resize не фокусируют карту. `CityMap.automaticCamera=false` используется главной; прямые потребители сохраняют свои defaults.

### Аналитическое состояние

Страница/composable владеет запросом и его актуальностью; компоненты читают представление и передают намерения. API-модули выполняют HTTP, utils форматируют готовые данные без GIS. Подробные переходы состояния не дублируются здесь: [профиль](features/address-profile.md#интерфейс), [сравнение](features/address-comparison.md#данные-и-ограничения), [поездки](features/trips.md#состояние-повтор-и-история), [точка](features/point-analysis.md).

`useTripsState` использует единственные refs результата из `useTripAnalysis`, без второй копии analysis. Его синхронный watcher координат/идентичности цели сохраняет независимые строки и перенумеровывает diagnostics/candidates; переименование не считается геометрической правкой. `useTripAnalysis` отвечает за fetch, timeout, abort и защиту записи response. Epoch в useTripsState защищает продолжение после await: принятие road hints/candidates, запись истории и отложенное раскрытие предупреждения. На unmount транспорт отменяется, epoch становится недействительным.

Страница передаёт `saveSelection(value, push/replace)` и `beginRun(reveal)`: последний возвращает DOM-обработчик завершения с проверкой актуальности, захватив время/пользовательское взаимодействие. Восстановление URL и согласование popstate/hashchange остаются странице; composable получает уже разобранный выбор через `restore`. Формат ссылок и алгоритмы расчёта не менялись.

## Карты и адаптивность

CityMap владеет единственным MapLibre, его жизненным циклом, общим click-dispatch и камерой, а также слоями окружения и адресов. `utils/tripOverlay` устанавливает, обновляет и очищает только маршрутный source/layers и обрабатывает дорожные варианты/ручной выбор через этот dispatch. Он получает getter готового GeoJSON, не хранит результаты/epochs поездок, не подписывается на события карты и не вызывает fitBounds. ComparePage готовит GeoJSON через прежний tripMapData: сопоставляет сторону/цель/request-local index, задаёт подписи и обрабатывает событие дорожного выбора своей поездки. TripMap обслуживает самостоятельный /trips без изменения сценария; обе карты используют единственный installTripLayers. Маркеры сравнения — GeoJSON-слои; DOM-маркеры кандидатов самостоятельного TripMap остаются его ответственностью.

MapLayersPanel/MapLayerDetails и Stop/Area/LinearLayerInfo управляют представлением слоёв, не HTTP. `useMapTheme/mapTheme` меняет paint, AddressMapLabels/mapLabels размещает экранные подписи; их координатная геометрия остаётся серверной. Данные слоёв — контракты [остановок](features/map-stops-layer.md), [площадей](features/map-area-layers.md), [линий](features/map-linear-layers.md).

Камера, контексты, повтор подложки, мобильный scroll и фокус главной — [home-workspace-map](features/home-workspace-map.md). Компоновка прямого профиля — [address-profile](features/address-profile.md#карта-прямой-страницы-профиля), двух карт — [сравнение](features/address-comparison.md). Здесь остаётся распределение ответственности: CityMap — lifecycle/click-dispatch/камера, tripOverlay — собственные sources/layers, HomePage — явные UI-намерения.

Подложка/glyphs требуют сети; worker локальный, sprite с происхождением/лицензией — `public/maps/osm-openmaptiles`. Декоративные POI и OSM-остановки подложки не становятся официальными аналитическими данными. Отказ подложки не отменяет локальную аналитику.

## Стили и UI tooling

Tailwind CSS 4 подключён через Vite, shadcn-vue — components.json/reka-nova/neutral, CSS variables — app.css, cn.ts указан alias генератора. Базовый шрифт Instrument Sans подключается Vite fonts plugin. Существование tooling/dependency не означает, что все готовые UI-компоненты уже установлены или используются.

```bash
docker compose exec node npm run ui:add -- button
docker compose exec node npm run typecheck
```

Первая команда — пример генерации новых исходников, не проверка; выполнять только при потребности в компоненте, проверить CSS/source/lock. Работать в node от пользователя node. Карта имеет собственные темы, а CSS-вариант `.dark` сам по себе не означает готовый переключатель темы всего приложения.

## Развитие и проверка

Состояние самостоятельных поездок выделено в useTripsState ([протокол R2](history/trips-state-r2-2026-10-25.md)); loaders объединены в R1. Fragment/restore сравнения выделен в useComparisonLink ([протокол R3](history/comparison-link-r3-2026-10-25.md)). Маршрутный overlay выделен в R4 ([протокол](history/trip-overlay-r4-2026-10-25.md)). Не вводить общий state manager или универсальный компонент со всеми параметрами ради сокращения строк. Точные findings/Goals — [аудит](research/structure-quality-audit.md); эти рекомендации сами по себе не разрешают новые изменения.

Проверять настоящие компоненты/composables, клавиатуру, фокус, историю, поздние ответы, отказ подложки и независимость результатов. Команды и границы mocked/live проверок — [testing](testing.md), [browser smoke](browser-smoke.md).
