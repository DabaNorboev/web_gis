---
status: plan
updated: 2026-11-04
verified: code
---

# Выборочная очистка кода после смены направления

Карта зависимостей и условия удаления существующих модулей. Очередь, исполнители и границы заданий — в [roadmap](roadmap.md#ближайшая-очередь). Удаление выполняется только по соответствующему поручению после проверки потребителей; существующие данные сохраняются.

## Карта компонентов по фактическим зависимостям

Пути от корня репозитория. «Отложить» — заморозить развитие, сохраняя работающие входы и защиту. «Удалить после условий» — кандидат, а не сегодняшнее действие.

Приоритеты очистки: C1 — необязательная небольшая техническая уборка, не условие проверки новых источников; C2–C3 рассматриваются после решений о хранении и интерфейсе; C4 — после работающей принятой замены. Замороженная модель поиска жилья пока не требует исчерпывающего исследования reuse. К вопросу возвращаются при конкретной потребности нового UI/хранения или подготовке удаления, с проверкой только затронутых зависимостей. Сравнение, маршрутизация и общие GIS-модули остаются в категориях сохранения/адаптации.

| Компоненты | Класс | Основание и потребители |
|---|---|---|
| `app/Services/Osm/Search/AddressSearchService.php`, `app/Services/Addresses/{AddressResolverService,PointAddressService}.php`, API clients `addresses.ts`, `pointAddress.ts` | Сохранить | Явный адрес/точка нужны новому ядру и текущим profile/trips; resolver и подпись не объединяют идентичность |
| `app/Services/Gis/{AnalysisArea,DatasetCoverage,GeoJsonBoundary}.php`; `app/Services/Addresses/AddressProfileService.php` | Адаптировать | Общие круг/coverage/независимые блоки; сейчас профиль адресный и шесть блоков, точка получает только подпись. Нужен контракт адрес/точка без выдуманного адресного ID |
| `app/Http/Requests/{AddressProfileRequest,TransportAnalysisRequest}.php`, `resources/js/types/{profile,searchApi}.ts`, `resources/js/search/types.ts`, `api/{profiles,searchProfiles}.ts`, URL utils | Адаптировать | Радиус 300/500 зашит в валидаторах, TS и ссылках; переход 200–1000 требует совместимой версии/обновления потребителей и GIS-тестов, не только ползунка |
| `app/Services/Osm/{Analysis,Import}/`, `app/Services/Transport/`, команды `ImportOsm*`, `ImportTransportStops`, `PrepareCoverageBoundary` | Сохранить / адаптировать по категории | Snapshot/import/coverage нужны вне поиска жилья. Официальные остановки отдельны от OSM POI; здания и линии используются routing guards. Не удалять импорт из-за снятия прежней продуктовой мотивации |
| `resources/js/pages/HomePage.vue`, `composables/useHome{Workspace,Trips,Location,Orientations,TableColumns}.ts`, `components/home/`, `resources/css/home-workspace.css` | Адаптировать после UI-решения | Действующая главная связана с А/Б и поездками; это рабочий UI, а не независимый старый движок. Выделять один анализ только по согласованному контракту; см. C4 |
| `resources/js/pages/{AddressProfilePage,ComparePage}.vue`, `useAddressComparison`, `useComparison{Trips,Link,View}`, `components/Comparison*.vue`, `utils/comparison*.ts` | Сохранить; развитие сравнения отложить | Сравнение остаётся целью второго этапа. `useAddressComparison` также нужен главной, `utils/comparisonPresentation.ts` используется её ячейками; массовое удаление сломает анализ одного адреса |
| `resources/js/components/map/`, `maps/basemap.json`, `utils/map*.ts`, `public/maps/` | Сохранить / адаптировать | MapLibre, слои, легенда, выбор и доступность общие; новая панель с порядком слоёв ещё проектируется. Граница карты и GIS сохраняется |
| `resources/js/search/{task,document,types,reasons}.ts` | Отложить; reuse при конкретной потребности | Ядро постоянных кандидатов/заметок/чек-листа поиска жилья; `createSearchTask` используется persistence и тестами, публичный UI его не монтирует. Не исследовать весь reuse до первичного опыта новых источников; при потребности оценить применимые tokens/происхождение, см. C2 |
| `resources/js/search/{storage,persistence}.ts` | Отложить | Приватное IndexedDB и гонки вкладок ценны; схема searchId/candidateId не принята для нового анализа. UI пока не подключён; не удалять/мигрировать browser records автоматически, см. C2 |
| `resources/js/search-ui/`, `resources/css/search-ui.css`, `components.json` | Отложить; кандидат после UI-решения | Незакоммиченная `/search` — только оболочка без owner/API/хранения/карты. Два работающих полноценных UI не обнаружены. Дальнейшее подключение требует UI-решения; см. C3 |
| Подбор территории: `Section` в `search/types.ts`, отключённый раздел `SearchShell.vue`, старые планы и макеты | Отложить; удалить только заглушку после C3 | Реального API/сервиса territory/isochrone в `routes/api.php` и `app/Services` нет. Нельзя планировать удаление несуществующего алгоритма или общего GIS |
| `app/Services/Routing/`, `api/trips.ts`, `useTripsState`, `useTripAnalysis`, `TripPointPicker.vue`, `types/trips.ts` | Сохранить; требуется исследование методики | `/trips`, главная и сравнение используют один API; guards/privacy/snap не относятся только к жилью. Личные точки не POI. Необходимость обоих режимов открыта, но это не разрешение их удалить. Конкретные guards могут быть пересмотрены по [правилу доказательств](analysis-transition-plan.md#маршрутизация-что-установлено-об-отказах); неизменность реализации не самоцель |
| `utils/{homeSelection,comparison,comparisonTrips,trips}.ts`, `useHomeLocation`, `useComparisonLink`; resolve/profile/selected API | Сохранить / адаптировать | Текущие query/fragment/history и повторная проверка; новая политика хранения/обмена и миграции ссылок не принята. Работающие входы сохраняются до решения о совместимости |
| `resources/contracts/reason-codes.json`, `search/reasons.ts`, `Routing/ReasonCatalog.php` | Сохранить / адаптировать | JSON читается PHP через `file_get_contents` и тестами; независимый TS-реестр сверяется с ним тестами; удаление search namespace требует проверки всех клиентов. Diagnostics обеспечивают честный отказ |
| `tests/{Feature,Integration,Unit,frontend,browser,routing-runtime,etl,security,docs}/`, `.github/workflows/tests.yml` | Сохранить / адаптировать вместе с контрактом | Риск важнее числа тестов. Удалять только тест ушедшего поведения после переноса общей защиты; см. C1–C4. Не сокращать privacy/geometry/late-response ради уменьшения набора |
| Базовый Compose, opt-in routing/walking, Dockerfile, Nginx, `scripts/`, `database/migrations/`, package/composer manifests | Сохранить | Запуск, импорты, CLI discovery и воспроизведение обслуживают несколько функций. Применённые миграции не переписывать; новых сервисов и зависимостей сейчас не назначать |
| `scripts/prepare-osm-areas.py` → `prepare-osm-linear.py`; Laravel CLI discovery; `RoutingGeometryGuard` → соседние SQL | Сохранить | Areas загружает linear через `importlib.util.spec_from_file_location`, Laravel обнаруживает классы команд по convention, car guard читает SQL через `file_get_contents`/подстановку `connector-issues.sql`. Отсутствие статического import не делает файл лишним |
| Спутники, станции воздуха, ветер, новый общий POI importer | Требуется исследование / новая реализация | В текущих routes/services/scripts нет готовых подсистем. Не выдавать OSM vegetation за спутниковый слой или остановки за станции воздуха |

## Кандидаты на удаление и порядок

Общий барьер: отдельное поручение на конкретный diff; повторная сверка HEAD/status и потребителей, включая untracked; проверки из [testing](../testing.md). Сначала перенос/сохранение нужного поведения, затем отключение входа, затем файлы и их специализированные тесты. Новые зависимости не ставить и рабочие данные не менять попутно.

### C1. Остатки переключателя и неиспользуемые компоненты

Необязательная уборка по отдельному поручению. Первое [исследование спутников и воздуха](source-feasibility-task.md) не зависит от C1.

**Точные кандидаты:** `resources/js/components/InterfaceSwitch.vue`, `resources/js/composables/useInterfacePreference.ts`, `resources/js/components/MetricCard.vue`, `resources/js/components/map/{AreaLayerControls,LinearLayerControls}.vue`. Причина: переключение classic/workspace уже отсутствует, последние три компонента не найдены в entry graph; это сокращение старой оболочки, а не удаление сравнения .

**Потребители:** `useInterfacePreference` всё ещё импортируют `pages/HomePage.vue` и `layouts/PlaceLayout.vue`; `InterfaceSwitch` использует его внутри самого кандидата. `tests/frontend/interface-preference.test.mjs` проверяет заглушку, `tests/browser/interface-switch.spec.mjs` — отсутствие переключателя. `MetricCard` напрямую загружается в `tests/frontend/address-profile.test.mjs`, даже без app-import. У controls app-потребители поиском не найдены. В `app.js` динамические импорты страниц явные; `tests/frontend/support/vue-component.mjs` — тестовый loader, не app route. Имена файлов могут участвовать в тестах/CLI, поэтому статического отсутствия одного import недостаточно.

**Сохранить/заменить:** единственный workspace, класс оболочки, поиск/профиль, метрики null/zero и качество, работающие `MapLayersPanel`/`AreaLayerInfo`/`LinearLayerInfo`. Ключ `search/storage.ts` сохраняет строку `placelens:interface:v1` в `settingKeys`; сохранить известный ключ очистки независимо от удаления заглушки.

**Условия/порядок:** обновить HomePage/PlaceLayout на постоянное поведение → перенести содержательные SSR assertions MetricCard на действующий компонент → проверить отсутствующие template/dynamic consumers и локальный CLI → удалить только пять кандидатов, если проверка всё ещё подтверждает ненужность. Не удалять CSS по похожему префиксу без отдельного поиска selectors.

**Проверки/риски:** typecheck, целевые interface-preference/address-profile/area-layers/linear-layers frontend tests, interface-switch + profile/home/map smoke, keyboard/focus. Записи пользовательских настроек не удалять этим заданием; схема БД и API не меняются. Проверить список тестов на момент исполнения, не считать это сегодняшним успешным прогоном.

### C2. Специфическая модель поиска жилья и просмотра

**Кандидат только после решений о хранении и интерфейсе:** `resources/js/search/{task,document,types,reasons,storage,persistence}.ts` и специализированные части `tests/frontend/{search-task,search-storage}.test.mjs`, `tests/browser/storage/`, `tests/browser/search-storage*`. При подготовке конкретного изменения оценить необходимый reuse; сейчас достаточно заморозки. Символы: `createSearchTask`, `createSearchPersistence`, `Candidate`, `ChecklistBasis`, `SearchDocument`. Причина: постоянные кандидаты/чек-лист просмотра больше не основа продукта. Личные `Place`/`PointSelection` не удаляются из концепции вместе с `Candidate`.

**Потребители/связи:** persistence → task/storage; task → document/types и общие types/transport, types/trips; reasons — независимый реестр; backend registry — общий `resources/contracts/reason-codes.json`; loader и import-policy tests читают ядро напрямую. `tests/browser/search-storage.config.mjs` и storage entry поднимают отдельный стенд. `SearchPage.vue` сейчас ядро не импортирует; это не доказательство отсутствия сохранённых records у разработчика. `api/searchProfiles.ts` и `types/searchApi.ts` работают также как новый клиент реального selected API; не включать их автоматически в удаление.

**Сохранить/заменить:** адрес/точка, приватность, tokens/epochs и независимые отказы; полезные гарантии CAS/generation — если выбранное хранение их требует. Метод результата/его хранения ещё не выбран. `placelens-search-v1`, schema/storageRevision и неперсональная generation имеют действующий технический контракт, который нельзя стирать новым UI.

**Условия/порядок:** утвердить необходимость хранения и совместимость → решить reuse отдельных чистых частей → описать чтение/экспорт/сохранение старого формата либо явную несовместимость без перезаписи → перенести регрессии на замену → снять import-policy/стенд только с реально удаляемого → удалить остаток и обновить контракт. Если хранения нет в первой версии, отложить модуль; это само по себе не требует его удаления.

**Проверки/риски:** синтетические documents старой/неизвестной версии, настоящий IndexedDB в отдельном origin, quota/abort/CAS/две вкладки/late response и удаление. Никакого автоматического открытия/сброса личной БД браузера. Неподдержанный документ сохраняется без перезаписи. Для удаления namespace reason-codes проверить PHP/TS consumers, Unit ReasonCatalog и tests/frontend/search-api.test.mjs; API диагностик сохранить.

### C3. Оболочка `/search` и заглушки территории/просмотра

**Кандидаты:** `resources/js/search-ui/{SearchPage,SearchShell}.vue`, `search-ui/copy.ts`, `search-ui/components/ui/button/`, `search-ui/lib/utils.ts`, `resources/css/search-ui.css`. После решений о хранении и интерфейсе, только если UI-решение признало оболочку неприменимой; альтернатива — адаптировать её к одному анализу. Исчерпывающий reuse-аудит сейчас не нужен. Макеты и документация сохраняются как история, а не удаляются вместе с экраном.

**Потребители:** динамический import в `resources/js/app.js`; route `/search` в `routes/web.php`; общая Blade `welcome`; генератор `components.json` направляет будущие компоненты/helpers/CSS сюда, `package.json` содержит `ui:add`; `tests/browser/{server,entry}.mjs` и `search-shell.spec.mjs`; `tests/Feature/SearchPageTest.php`; `tests/frontend/search-ui-{copy,imports}.test.mjs`, `fixtures/search-ui-import-policy.json`, `support/search-ui-policy.mjs`. Классификация включает существующий untracked-код. SearchShell содержит лишь disabled territory/comparison/visit: отдельного territory backend нет.

**Сохранить/заменить:** текущую главную, прямые profile/compare/trips и общий Button/helper только при наличии потребителей нового UI. Tailwind/Reka/shadcn и общие clsx/tailwind-merge не удаляются как побочный эффект: старый и новый код/сборка могут их использовать. Зависимости — отдельная проверка импортов, Vite/CSS и генератора после выбора UI.

**Условия/порядок:** выбрать основной вход/совместимость `/search` → отключить mount/route или дать согласованный переход → перенастроить CLI aliases/CSS и smoke-server → убрать только беспотребительские shell-файлы и их специализированные assertions. Не менять старые `/address`, `/compare`, `/trips` по отменённому П7. Не удалять общий `welcome` или browser server.

**Проверки/риски:** typecheck, import/copy tests при сохранённой оболочке либо новая проверка entry graph; PHP page tests, прямой reload каждого входа, home/profile/compare/trips browser smoke, production build в новый каталог. Проверить HTTP 404/redirect и отсутствие неожиданной записи/расчёта при старой ссылке. Хранение C2 не затрагивается.

### C4. Части прежней главной после готовности замены

Сейчас это **адаптация**, не список готовых к удалению файлов. Потенциальная область: `HomePage.vue`, `components/home/`, `composables/useHome*.ts`, `types/home*.ts`, `utils/home*.ts`, `resources/css/home-workspace.css`. Конкретные файлы удаления выбираются только по diff новой реализации; причина — устранение привязки основного анализа к жилью/АБ, не отказ от сравнения или личных мест.

Потребители: `/` → статический HomePage в `app.js`; HomePage → useHomeWorkspace/useHomeTrips/useHomeLocation → useAddressComparison/useComparisonTrips/useTripsState; общие comparison helpers/CityMap/TripPointPicker/API/types используются прямыми страницами. Домашние helpers тестируются напрямую и участвуют в map/overlay/history. Нельзя удалить каталог composables или comparison* по имени. `home-workspace.css` подключается из `HomePage.vue`; проверяется отдельно от JS-imports.

Сначала работающий принятый UI и новый однопунктовый анализ с проверенной совместимостью старых query/fragment и переносом защиты поздних ответов/геометрии/scroll/focus, затем отключение старого mount. После этого точечный список без потребителей, обновление тестов и удаление остатка. До этих условий удалить ноль файлов. Проверки: typecheck/frontend, home/profile/compare/trips browser, параметры URL/Back/Forward/reload, приватность links/POST, актуальная геометрия/независимость отказов. Рабочие ссылки/настройки сохраняются либо получают заранее принятое поведение; удаление личных данных не входит в эту замену.

## Данные, снимки, отчёты и эксперименты

Проверены существование каталогов и ссылки в исходниках; содержимое личных журналов, браузерных записей, `.env` и запросов не читалось. БД, volumes, hashes всех больших файлов и восстановление из резервных копий не проверялись. Отсутствие в Git, название «отчёт» и производный формат не дают права удаления.

| Область | Установленная зависимость / что сохранить | Условие возможного удаления отдельным заданием |
|---|---|---|
| `data/raw/` (boundaries, osm_addresses/areas/buildings/linear/pbf/stops, transport_stops) | Источники импорта, границы, происхождение; общие здания/вода/линии для guards | Реестр точных файлов/версий и потребителей, проверенное восстановление вне удаляемого места, отдельное согласование. Не выполнять импорт/очистку в этом задании |
| `data/prepared/local-routing/{osrm-car-20261021-v1,ors-foot-20261026-v1}` | Пути закреплены в config, startup и Compose; графы/guards/source/manifest нужны runtime | Только после вывода всех режимных потребителей и новой принятой схемы воспроизведения, либо согласованной замены снимка. Сохранить исходный выпуск/свидетельства; не переписывать pin ради удаления |
| `data/reports/local-routing-2026-10-21` и `local-routing-integration-2026-10-21/guard-export` | `scripts/prepare-routing-runtime.py` читает report; walking prepare также читает prepared context и guard export | Сначала перенести входы в явно описанное хранилище с hashes и обновить CLI/docs/tests, доказать воспроизведение в новом каталоге. До этого это необходимые входы, не мусор |
| `data/reports/ors-routing-poc-2026-10-26` | `scripts/prepare-walking-runtime.py --report` по умолчанию читает закреплённый отчёт/граф | Аналогично: сохранённые inputs, явные новые пути, повтор без перезаписи, отдельное разрешение удаления |
| `data/reports/local-routing-integration-2026-10-21/no-path-candidates.json` | Default input `scripts/verify-trips-runtime.py`; CLI `--no-path-candidates` разрешает другой вход | Сохранить отрицательные контроли и provenance, проверить новый путь и изолированный `test_verify_trips_runtime.py`; не читать реальные запросы ради аудита |
| Остальные `data/reports/*`, screenshots и manifests | Исторические свидетельства, некоторые каталоги содержат исполняемые диагностические материалы; не доказана полная независимость | Пофайловый реестр reader/writer + восстановление; нет общей команды удаления каталога |
| `experiments/local-routing-poc/controls.json` | Читается `scripts/check-routing-provider.php` и `scripts/verify-trips-runtime.py`; PoC воспроизведение и отрицательные контроли | Перенести необходимые fixtures и потребителей, сохранить датированные свидетельства. Поиск app-import не охватывает эти CLI |
| `experiments/{ors-routing-poc,routing-clicks,grocery-poc}/` | Методические/диагностические scripts, проверки source-chain и POI; отдельные CLI из README | Отдельная проверка dynamic imports/CLI/данных и воспроизводимости. Исторический PoC не становится production-модулем автоматически |
| `experiments/{interface-v2,placelens-studio,placelens-visual}/`, `docs/archive/housing-search/search-task-mockups/` | История UI, assets, версии/QA и контекст прежних решений | Неактивные макеты, но не кандидаты на попутное удаление. Сохранить связанные снимки и лицензии; новые изображения не требуются до UI-решения |
| `public/maps/`, `public/build/`, `storage/`, `bootstrap/cache/`, `test-results/`, `playwright-report/`, Docker volumes | Ресурсы работающего пилота, публикация, runtime/диагностика или персональные следы; Node volume и PostGIS общие | Разные политики, отдельное окружение/согласование; неизвестная ценность/личное содержимое не исследуются массовым чтением. Не выполнять prune, build поверх assets или volume reset |

Уборка экспериментов/данных сейчас не назначается. Даже при отказе от маршрутизации сохраняются общие GIS-данные и необходимые для прежних выпусков входы. Удаление snapshots/volumes требует явного согласования по AGENTS независимо от будущего задания на очистку кода.

## Проверки выполнения будущих заданий

Для каждого задания нужен исходный diff, ограниченный список разрешённых файлов и выбранные проверки из [testing](../testing.md). По контрактам обновляются основной документ, updated и одна запись changelog; после docs всегда `scripts/check-docs`. Node — в `node` от пользователя `node`; GIS — только через защиту `web_gis_test`. Синтетические privacy/late-response/geometry/identity regressions переносятся прежде удаления старых стендов. Успешные проверки одного и того же diff не повторяются без причины. Техническая проверка данных, UX-приёмка и подтверждение пользы остаются разными результатами.
