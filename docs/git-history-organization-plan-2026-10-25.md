# План организации истории Git PlaceLens

Дата исследования: 25.10.2026, Asia/Krasnoyarsk. **Статус: исследование и предложение для отдельного задания.** История не собиралась, проверки приложения не запускались. Этот документ — единственный добавленный файл.

## 1. Решение

Предпочтителен вариант A: **шесть содержательных коммитов поверх `7e8a39a5d340efc6ffecfb291c020d2d23b856f5`**, в новой изолированной ветке/worktree после постоянной защищённой страховки. Первые три коммита — локальный backend/GIS, backend автомобильного пилота и итоговый frontend; ещё три — независимые инструменты routing-clicks, grocery PoC и систематизация документации/правил.

Это логическая организация нынешнего результата, **не восстановленная последовательность разработки**. Не выделять Goals и R1–R4 отдельными коммитами без доступного и проверенного состояния «до». Итоговые реализации R1–R4 включить в frontend-коммит вместе с регрессиями и протоколами.

Разделение выглядит технически осуществимым по чтению зависимостей, но безопасность промежуточных состояний ещё не подтверждена сборкой/исполнением. В этом задании они запрещены. Условие принятия A — отдельные проверки каждого промежуточного дерева. Если три основных блока нельзя выделить переносом целых файлов и небольших существующих hunks без реконструкции продуктового кода, объединить их; если остаются сомнения — вариант B, один честный фиксационный коммит отфильтрованного текущего состояния. Сохранность важнее числа коммитов.

## 2. Исходное состояние и границы исследования

Прочитаны `AGENTS.md`, `README.md`, ignored `PROJECT.md`, карта документации, продукт, архитектура, проверки, относящиеся к данным/поездкам инструкции, протокол переноса compare-layout, материалы Goals и R1–R4. В доступной исходной структуре вне зависимостей/данных вложенных AGENTS не найдено.

Локальный PROJECT одновременно содержит правила, старые планы и журнал этапов с устаревшими формулировками. В частности, он запрещает своё включение/публичные ссылки и упоминает прежние правила веток; нынешний docs/README прямо называет его локальной прежней спецификацией. Последнее задание пользователя требует отдельного решения о содержимом PROJECT — **сейчас не включать его автоматически и не менять ignore**. Существующий AGENTS уже служит входом в актуальные контракты; его будущая фиксация предложена отдельно.

| Объект | Факт на начало |
|---|---|
| Рабочее дерево | `/home/daba/projects/web_gis` |
| Ветка | `feature/transport-stops-import` |
| HEAD | `7e8a39a5d340efc6ffecfb291c020d2d23b856f5` |
| Индекс | Staged diff пуст; 106 tracked-путей |
| Unstaged tracked | 33 изменённых файла и 1 удалённый; 1468 добавленных/257 удалённых строк **только tracked diff** |
| Untracked | 318 файлов/симлинков до этого отчёта; полный перечень ниже |
| Удаление | `app/Services/Transport/Import/GeoJsonBoundary.php`; новый `app/Services/Gis/GeoJsonBoundary.php` — связанный перенос, не потеря ненужного файла |
| Worktrees | Один зарегистрированный: текущее дерево; прежний compare-layout worktree из отчёта сейчас не зарегистрирован |
| Tags | Локальных tags нет |
| Upstream | У всех четырёх локальных веток upstream не настроен |
| Remote | Один `origin`, fetch/push через SSH на github.com; пользователь/путь намеренно не публикуются |
| Remote-tracking refs | Только `origin/main=0917dab`, `origin/feature/transport-stops-import=7e8a39a` |

Наличие remote-tracking ref доказывает только состояние **локального ref**. Ни опубликованность текущих изменений, ни актуальность сервера не проверены. Fetch, ls-remote и сетевых обращений к репозиторию не было. Отчёты о «публикации на localhost» относятся к assets локального приложения, не к push Git.

Для последующей сверки в памяти сеанса сохранены SHA-256 422 существующих доступных исходных/конфигурационных файлов (без чтения содержимого .env* и ключей), отсутствие удалённого tracked-файла и цель симлинка. Дополнительно собрана сводная ведомость размеров/mtime/mode 46 883 существующих файлов, включая ignored; содержимое этих ignored-данных, журналов, секретов и личных материалов не открывалось. Это контроль исследования, **не резервная копия**.

SHA-256 исходного raw index:
`2937d1f321a362e426d4207f19e5e7850b34e2356e960dbeccd024d5dc0b3ce3`.

## 3. Что находится в локальной истории

### Основная линия

В HEAD двенадцать коммитов, все последовательные, без merge-коммитов:

| Коммит | Содержание |
|---|---|
| `606c033` | Laravel, Docker-окружение |
| `9beea68` | Vue tooling |
| `0917dab` | CI и запуск; на нём находятся main и локальный origin/main |
| `468eb1a` | Tailwind/shadcn-vue |
| `124ddb3` | PostGIS, dataset_imports и транспортная схема |
| `cd50ccb` | Атомарный импорт официальных остановок |
| `1693d81` | Справочник классификации маршрутов |
| `15b12bf` | API анализа по точке |
| `865c665` | Главная и карта |
| `8e5375b` | Документ схемы |
| `5839773` | Транспортный frontend по выбранной точке |
| `7e8a39a` | Сводка и ближайшие остановки |

В базе уже есть composer/package manifests и lock-файлы, базовый Compose, PHP/Node Dockerfile, Vite/TS config, шаблон окружения `.env.example` (содержимое не читалось), транспортные миграции/импорт/API/UI, начальные PHP/GIS-тесты и `scripts/init-test-db.sh`. Они наследуются, повторно «добавлять проект» не требуется.

В HEAD **нет** OSM-адресов/поиска, импорта зданий/линий/площадей, coverage и union-аналитики окружения, профиля, сравнения, point-address API, routing provider/guards/SQL, нынешних страниц и их composables, браузерного стенда, public/maps со спрайтами и основной нынешней документации. Но часть этого есть в боковой ветке-снимке; утверждать, что всё это вообще отсутствует в Git object database, неверно.

### Ветки и служебные снимки

| Ref / tip | Проверенные отношения и содержимое | Предлагаемое обращение |
|---|---|---|
| `main → 0917dab` | Предок HEAD; на 9 коммитов позади. Самостоятельных коммитов относительно HEAD нет | Сохранить; интеграцию новой линии решать отдельным заданием |
| `feature/transport-stops-import → 7e8a39a` | Исходная ветка с живым WIP | Оставить на месте, не переключать и не очищать |
| `feature/pedestrian-routing-poc-2026-10-22 → 7e8a39a` | Tip совпадает с HEAD; собственных коммитов ветки нет | Не считать эксперимент потерянным: он сохранён в отдельном служебном snapshot; ветку не удалять |
| `feature/compare-layout → 81b1ca6` | Два собственных коммита: `e82c145` от HEAD, затем `81b1ca6`. Первый — большой снимок предшествующего WIP (231 изменённый путь относительно HEAD), второй — 7 файлов layout/accessibility | Сохранить как источник доказательств и полезной реализации, не вливать весь снимок автоматически |
| Snapshot `236a8d8` | Прямой потомок HEAD; 16 файлов `experiments/pedestrian-routing-poc-2026-10-22/`. Доступен через `refs/codex/snapshots/5cb7ab7829846cb28e9ba2364399bfc7f933d88e`, не через tip pedestrian-ветки | Сохранить ref/объекты в защищённой страховке; эксперимент учитывать отдельно, не включать в автомобильный продукт |
| Snapshot `81b1ca6` | Также закреплён `refs/codex/snapshots/19aa1305f1f416781165f91ec3a483490c69a11c` | Дублирующая точка сохранения, не новая feature |
| `refs/codex/turn-diffs/…` | 29 tree refs, 26 уникальных деревьев, не обычные коммиты. Содержат от 159 до 423 путей; у поздних есть useTripsState/useComparisonLink/tripOverlay | Возможные вспомогательные исходные состояния. Не называть их полной хронологией или проверенными версиями; без отдельной атрибуции не превращать в коммиты |

**Перенос compare-layout подтверждён двумя независимыми видами свидетельств.** `docs/comparison-transfer-2026-10-22.md` описывает применение только `81b1ca6^..81b1ca6` через git apply и сверку семи файлов. В нынешнем дереве `useAddressComparison.ts` и `comparison-layout-2026-10-22.md` побайтно совпадают с tip; остальные пять файлов уже отличаются. В коде сохраняются knownAddress и compact/singleMap границы, но ComparePage и компоненты затем существенно переработаны. Поэтому ветка **не слита по ancestry**, её полезная работа перенесена и развита в WIP; повторный cherry-pick её snapshot+feature создаст дублирование/конфликты.

Для масштаба сравнения: из 309 путей дерева `81b1ca6` 228 совпали с нынешними файлами, 78 отличаются; содержимое трёх controls JSON намеренно не читалось. Это не сравнение поведения и не разрешение считать все 78 изменений только последующим UI. В `e82c145` соответственно 226 совпавших и 78 отличающихся из 307, три пропущены. В snapshot пешеходного PoC 13 путей отсутствуют в нынешнем дереве, ещё три controls/diagnostic/freeze не исследовались по содержимому; это отдельное сохранённое дерево, а не кандидат для массового переноса.

**База новой линии — текущий HEAD `7e8a39a`.** Он сохраняет все уже существующие транспортные коммиты и соответствует основанию исходного WIP. `main` слишком ранний и заставит повторять девять полезных коммитов; `e82c145/81b1ca6` уже содержат крупный промежуточный WIP и не дают чистой предметной базы; `236a8d8` добавляет другой эксперимент.

## 4. Состав воспроизводимой версии и ignored

Размеры ниже получены только по метаданным, округление не применяется к указанным байтам. Содержимое runtime, исходных данных и архивов не исследовалось.

| Категория | Фактические пути / роль | Git будущей версии |
|---|---|---|
| Продуктовые исходники | app, предметные SQL рядом с Routing, config, migrations, routes, resources, public entrypoints | Включить по явному списку; сохранить неизменённые tracked-основы |
| Запуск и зависимости | docker-compose.yml; docker-compose.routing.yml; Dockerfile PHP/Node/ETL; docker/routing/start.sh; composer.json/lock, package.json/lock, tsconfig, Vite, components.json | Обязательно; Node-команды только в node от node, TS6 сохранить |
| Проверки и fixtures | tests PHP/frontend/browser/etl/security, Support/PostgisDatabase, PostgisTestCase, phpunit*.xml, Playwright config, CI, init-test-db | Включить с кодом; маленькие геометрии/PBF создаются тестами, не требовать рабочие наборы |
| Ресурсы карты | resources/js/maps/basemap.json и все 5 файлов public/maps/osm-openmaptiles (1 392 641 байт), включая LICENSE и обе пары JSON/PNG | Обязательно для используемого style; это runtime assets, не кэш |
| Текущая документация | README, docs/README, product/architecture/testing/frontend-structure, контракты данных/функций и runbooks | Включить; убрать зависимость нового checkout от локального PROJECT |
| Полезные инструменты | scripts подготовки/проверок, experiments/local-routing-poc, routing-clicks, grocery-poc | Сохранить исходники/README отдельно от результатов; некоторые нужны для восстановления runtime |
| Исторические документы | Датированные Goals, R1–R4, transfer/audits/research | Сохранить как историю с датой/статусом; не превращать успешный старый прогон в сегодняшний |
| Локальные отчёты/страховка | data/reports: 31 100 файлов, 1 158 648 347 байт; обнаружены 1 tar, 28 tar.gz, 21 patch, 2 diff | Вне продуктового Git; сохранить защищённо. Некоторые файлы — обязательные входы подготовки и исторический код |
| Исходные геоданные | data/raw: 65 файлов, 731 681 134 байта; boundaries, osm_addresses/buildings/linear/areas/pbf/stops, transport_stops | Внешнее версионируемое хранилище + manifests/инструкции |
| Графы и runtime | data/prepared: 5844 файла, 226 292 796 байт; выпуск osrm-car-20261021-v1, graph/guards/manifest/checksums | Не включать большие графы в Git; сохранять точный выпуск вне Git |
| Локальные инструменты данных | data/tools/osmium: 276 файлов, 10 345 080 байт | Внешние binaries/dependencies; закрепить способ получения/версию |
| Опубликованная сборка | public/build: 218 файлов, 46 829 902 байта | Не включать; существующую публикацию не чистить. Это живые assets, не разрешённый к удалению мусор |
| Зависимости/кэши | vendor (8819 файлов), node_modules; bootstrap/cache packages/services, storage/framework compiled views/cache/sessions, PHPUnit cache, __pycache__/*.pyc | Не включать generated; сохранить tracked .gitignore каркасы. Node deps могут быть volume/symlink, не копировать как исходники |
| Производные PoC/browser | grocery .runtime (27 207 600 байт); test-results, playwright-report | Вне Git; отчёты могут содержать чувствительные входы |
| Локальная среда | .idea, .codex и другие IDE dirs, database/database.sqlite | Не включать; SQLite может хранить пользовательские данные |
| Секреты и личные материалы | .env*, auth.json, ключи, журналы, личные координаты/ссылки/тела запросов | Не включать и не печатать. Исключение — уже tracked безопасный шаблон .env.example после отдельной проверки на фиктивные значения |

Реальные ignore-правила: корневой .gitignore скрывает PROJECT/data/vendor/node_modules/public/build/browser outputs/IDE/часть секретов; `database/.gitignore` — SQLite; вложенные storage/bootstrap правила — runtime; `experiments/grocery-poc/.gitignore` — .runtime. Зафиксированы и существующие игнорируемые файлы/каталоги, и назначение правил для временно отсутствующих outputs (например public/hot). Правила сейчас не менялись. Текущий tracked diff .gitignore добавляет Python/browser ignores — только эти существующие шесть строк являются кандидатом будущего включения.

`docker-compose.override.yml` — **относительный симлинк → docker-compose.routing.yml**, а не самостоятельная копия YAML. Сохранить тип 120000 при выбранной стратегии. Автоподключение runtime ломает первый запуск обычным compose на новом checkout без графа; README уже требует базовый `-f docker-compose.yml`. Решение о сохранении автосимлинка в версии — отдельное до исполнения. Его нельзя незаметно заменить другим файлом или ослабить проверки runtime ради запуска.

## 5. Предлагаемые коммиты

Ниже A — шесть коммитов. Заголовки описывают сегодняшний конечный результат. Даты/авторы — реальные даты/авторы будущей фиксации, без задних чисел и имитации Goals. Числа Goals не входят в структуру веток.

Обозначения проверок (все **будущие**, сейчас не выполнялись):
- **P**: обычные PHP unit/feature, Composer test; учитывать config:clear.
- **G**: защищённые PostGISWrite/ReadOnly только web_gis_test; запрет DB_URL/read-write overrides, синтетические fixtures и изолированные migration schemas.
- **E**: ETL fixture suite из docker/etl, без рабочего импорта/PBF.
- **F**: frontend unit/SFC, typecheck, Vite build в изолированном checkout с установленными lock-зависимостями.
- **B**: полный Playwright, 4 viewport, 1 worker, retries 0, synthetic API; собственные outputs и весь root, так как некоторые specs пишут historical preview в data/reports.
- **N**: Nginx synthetic privacy в отдельном экземпляре/окружении; не читать живые журналы и не перезагружать текущий nginx.
- **D**: пути/локальные ссылки, точность контрактов и явное отделение истории от планов.

| № | Заголовок | Назначение и достаточно конкретный состав | Зависимость | Проверки | Сложность выделения |
|---|---|---|---|---|---|
| 1 | feat: add local address and environment analysis | Вся цепочка local snapshots → search/coverage/union/profile: app/Services/Gis, Osm, Addresses/AddressProfileService; OSM/coverage CLI; search/profile controllers+requests; 8 новых migrations; изменения transport importer/API/service; PostgisTestCase/Support и связанные Integration/Unit; ETL scripts/image/fixtures. docs/osm-*, address-search/profile, coverage, area-analysis, data-schema/transport-import | HEAD | P, G для локальных наборов, E; сборка старого frontend из базы; D | Общая coverage миграция нужна одновременно importers и transport. Удаление прежнего GeoJsonBoundary и новый namespace переносить вместе. Схема поиска/backfill и итоговый importer неотделимы; не создавать старую медленную версию HTTP ради истории |
| 2 | feat: add guarded local car routing and point labels | app/Services/Routing целиком с 3 SQL; config/routing; TripAnalysis и PointAddress controller/request/middleware/services; bootstrap исключения, nginx privacy, API routes, /trips shell и Blade no-referrer; routing Compose/startup и симлинк по решению; scripts prepare/export/check/verify runtime; experiments/local-routing-poc как инструменты исходной подготовки; PHP feature/guard/snap/snapshot/point tests и security test; trips/point-address/diagnostics и routing runbooks/решения | 1 | P, G включая read-only guard/snap, N; сборка прежнего UI; synthetic unavailable/changed manifest; отдельная проверка точного внешнего выпуска только после предоставления inputs | Защита тела/логов, геометрия, доступ, pins и API идут вместе. routes/web+Blade готовят серверную оболочку: новый UI поездок появляется только в №3. Не копировать абсолютные data reports в Git и не обходить pin при отсутствующем выпуске |
| 3 | feat: deliver integrated place comparison and personal trips UI | **Весь итоговый resources/js WIP**, resources/css, Blade если остались связанные hunks, все 5 public/maps, package.json/lock, Playwright config; все tests/frontend со support R1 и tests/browser; ComparePageTest; окончательные web routes; весь текущий .github/workflows/tests.yml после наличия suites/scripts. Документы frontend/testing/browser, comparison/profile/map/point/trips UX, Goals UI, R1–R4 и независимый аудит | 1, 2 | F, B, P; финально полный G/E/N; D. Отдельная limited live acceptance без пользовательских точек, если разрешено будущее окружение | Крупный честный UI-коммит. app.js лениво импортирует все страницы; CityMap уже импортирует tripOverlay; ComparePage — useComparisonLink/useComparisonTrips и overview; R1 loader обслуживает тесты всего UI. Финальные реализации R2/R3/R4 включить сразу, без выдуманного «до». Старые MetricCard/ComparisonMetric и их тесты не чистить попутно |
| 4 | tools: preserve routing click diagnostics | experiments/routing-clicks целиком, README и local-routing-clicks протокол/описание выборки. Точный список ниже; это полезные инструменты Goal5, не новый продуктовый endpoint | 1, 2; в линейной серии после 3 | D и статические зависимости. При отдельном повторе — contract/synthetic checks, без обращения к рабочим БД/HTTP и без перезаписи outputs; live replay не является обычным unit suite | Скрипты historical.php и др. требуют ignored original-routing и runtime, у части фиксированные outputs. Сохранять ограничения README; отсутствие архивного кода не «исправлять» текущим алгоритмом |
| 5 | experiment: preserve isolated grocery proof of concept | 11 файлов experiments/grocery-poc, собственный .gitignore, docs/grocery-poc-2026-10-20.md. Снимок .runtime и данные не включать | 1 для общей ETL toolchain; в серии после 4 | Изолированные test_poc/контракты после чтения эффектов; D; prepare/verify snapshot только отдельным разрешением с сохранённым PBF | Эксперимент независим от Laravel/Vue; не смешивать с product API. Сохранить свой README и не выдавать магазины за реализованную категорию сравнения |
| 6 | docs: establish current project contracts and history guide | AGENTS, README целиком, docs/README, product/architecture/roadmap/hypotheses/user-check/research/structure audit; этот план; существующие Python/browser hunks .gitignore. Текущие функциональные документы уже идут с №1–3; здесь их окончательная навигация/границы и исторические статусы | 1–5 | D, полный allowlist/secret-size review, сверка конечного дерева и чистого checkout | PROJECT остаётся локальным до решения. Навигация не должна указывать на отсутствие локального файла как обязательную спецификацию. Это фиксация текущей систематизации, не разрешение следующего roadmap Goal |

### Общие файлы и проверка целостности последовательности

Перенос «всех файлов каталога» не равен разрешению staging каталога. Приложение ниже — инвентарный пофайловый список кандидатов; перед реальным staging утвердить отдельный список с hunk-границами. Не использовать `git add .`, `git add -A` или автоматический glob по всему дереву.

- `routes/api.php`: №1 — search/profile и imports этих контроллеров, №2 — trips/resolve-point. Не включать import отсутствующего класса раньше файла.
- `phpunit.postgis.xml`: №1 — pin/guard и два suite с существующим PostgisConnectionTest; ссылки на RoutingGeometryGuardTest/RoutingSnapTest добавить только в №2 с самими файлами. Целый финальный XML в №1 сослался бы на отсутствующие тесты. Это перенос существующих конфигурационных hunks, не ослабление guard.
- `routes/web.php`: /trips и middleware exclusions с TripPrivacyTest в №2; /address и /compare с frontend/ComparePageTest в №3. `resources/views/welcome.blade.php` no-referrer — №2 для существующего privacy test. До №3 новые web routes — серверная оболочка, не законченный пользовательский сценарий.
- `.github/workflows/tests.yml`: целиком в №3, когда npm test/test:smoke, browser files и ETL Dockerfile уже существуют. В №1–2 сохраняется базовый CI, проверки добавленных suites выполняются явными командами; не добавлять CI-вызов отсутствующего npm script.
- `docs/testing.md`: профиль G/ETL с guards — №1; routing/privacy — №2; frontend/loader/browser — №3. `docs/data-schema.md` — локальная схема №1; актуальные frontend/trips части документов переносить с владельцем. `README.md` содержит новые команды и ссылки; при необходимости соответствующие существующие разделы перенести с №1–3, в №6 зафиксировать окончательную редакцию.
- `docs/local-routing-clicks-2026-10-23.md` описывает и серверные исправления (TripDiagnostics/SQL в №2), и инструментальный replay (№4). Предпочтительно дать его как свидетельство в №2 вместе с диагностикой, а README/код инструментов — №4; в таблице №4 не подразумевается повторное добавление того же файла.
- `.gitignore`: существующие шесть строк Python/browser — допустимо фиксировать с E/B в №1/3 вместо №6, если без них артефакты затрудняют проверку. Это не основание менять сами правила в этом исследовании.

По исходным импортам №1 замыкает общий GIS/Osm/Transport/profile backend; прежний frontend получает прежние поля и дополнительные coverage/bounds. №2 использует его DatasetCoverage/OsmAddressImporter и схему, включает все Routing SQL и классы исключений. №3 содержит целиком цепочки app.js → pages → composables/components/utils/types и общий loader → все dependency tables. Browser entry импортирует настоящее app.js, поэтому тестовый стенд нельзя добавлять раньше страниц частично.

**Статическая оценка:** отсутствующих продуктовых импортов/типов при этих границах не требуется; manifests/locks наследуются из базы и обновляются вместе с scripts; окончательный CI добавляется после целей. **Не доказано исполнением:** PHP boot, миграции на чистой тестовой БД, typecheck/build и suites на каждом дереве. В будущем это обязательный gate, а не обещание результата. Если отбор общих docs/config hunks перерастает в переписывание поведения или тестов, укрупнить №1–3. Код не менять ради красивого графа.

## 6. Хронология: что известно и что предлагается

| Период / свидетельство | Что можно утверждать | Чего оно не доказывает |
|---|---|---|
| Git 06–10.10 | Порядок основной линии из 12 коммитов подтверждён родителями Git | Состояние сервера сейчас |
| PROJECT и runbooks 18–20.10 | Журнал описывает адреса/поиск → здания/линии/площади → подготовленный поиск/coverage → union → профиль/сравнение | Точные исходники каждого промежуточного состояния и новый успешный прогон |
| Routing материалы 21.10 | Протокол выбора ограниченного car pilot, runtime и privacy/access fixes | Реальные современные условия дорог/входов или готовую walking функцию |
| compare-layout, 22.10 | `e82c145 → 81b1ca6`, семь файлов feature и последующий git apply описаны и частично побайтно подтверждаются нынешним деревом | Merge feature в текущую ветку или точное равенство нынешнего UI tip |
| Goals 22–24.10 | Accessibility, profile workspace/sidebar, two maps, point label, Goal5 diagnostics → Goal6 trips UI, Goal8 map context, Goal9 interests, Goal10 personal comparison и 10.1 layout описаны отдельными датированными протоколами | Единую линейную разработку: некоторые работы шли параллельно; одинаковые номера Goals в разных сериях обозначают разное |
| R1–R4, 25.10 | Итоговые loader/useTripsState/useComparisonLink/tripOverlay и тесты существуют; независимый аудит описывает принятие и ограничения | Наличие полного pre-R1 дерева или сегодняшнее повторение его проверок |

Host-каталоги `/tmp/placelens-r1-original`, `placelens-r2-before`, `placelens-r3-before`, `placelens-r4-before` сейчас отсутствуют (проверено существование путей, не читались журналы). По независимому аудиту внутри остановленного/существовавшего node могли оставаться копии и outputs; в этом задании контейнеры не запускались и их содержимое не исследовалось. Служебные Git tree refs также дают реальные дополнительные кандидаты для будущего сопоставления, но сами по себе не маркируют точное состояние до конкретного R и полноту всех untracked.

Следовательно, нельзя обещать воспроизвести каждый Goal/R отдельным buildable коммитом. Для R1 нынешние тесты уже используют единый loader; для R2 страница требует useTripsState; для R3 ComparePage требует useComparisonLink; для R4 CityMap требует tripOverlay и adapter страницы. Включить их финальную форму в №3. Отчёты сохранены как свидетельства, без фальшивых дат/авторов или сообщений «так и разрабатывалось».

В действующем diagnostics-contract остаётся историческая фраза, что /trips ещё использует прежние сообщения; описание фактического UI находится в trips-scenario и нынешнем коде. При отборе docs отличать это введение контракта v1 от текущего поведения. Исправление/статус согласовать в будущем docs-коммите, сейчас документ не редактировался.

## 7. Ветки и выбор стратегии

Минимум: исходный worktree/ветка с WIP остаются нетронутыми; одна новая ветка и отдельный worktree от `7e8a39a` для подготовки. Рабочее имя можно выбрать `feature/history-organization` по прежней локальной convention; создание и окончательное имя — отдельное задание. Не создавать по ветке на Goal/R. main, compare-layout, pedestrian и служебные refs сохраняются до отдельного решения.

| Вариант | Польза | Риск / условия |
|---|---|---|
| A: шесть связных коммитов от HEAD | Различимы предметные изменения, полезны review/bisect, отделены эксперименты; сохранена существующая транспортная история | Нужны hunk-отборы общих routes/XML/docs и проверки промежуточных деревьев. Frontend останется большим. Нельзя объявлять гипотетические состояния историческими |
| B: один фиксационный коммит | Минимальный риск искусственных промежуточных состояний, точная основа будущей регулярной истории | Большой review и слабый bisect внутри накопленного WIP. Всё равно нужны фильтрация, manifests, страховка и clean checkout; B не означает добавить data/secrets/deps |

Рекомендация — A с указанными крупными границами и правом честного объединения первых трёх; B — предпочтительнее любой реконструкции продукта ради истории. В B один фиксационный коммит может включить проверенные исходники инструментов/экспериментов и docs по тому же allowlist, без больших outputs. Опубликованные коммиты не переписывать. Force push, удаление веток, rebase main и перенос snapshot-пешехода в продукт не являются шагами плана. Наличие полезной работы compare-layout учитывать переносом проверенного нынешнего результата, не повторным merge/cherry-pick.

## 8. План будущего безопасного исполнения

Все следующие действия — **только план**.

1. **Закрыть состав и заморозить исходник.** Выделить окно без параллельного редактирования; повторно снять branch/HEAD/refs/index/status, список tracked/untracked/ignored, executable bits и symlink targets. Зафиксировать ожидаемые hash/mode/size по явному списку исходников. Нынешний отчёт тоже включить в ведомость. Не переключать исходную ветку.
2. **Постоянная защищённая страховка вне /tmp.** Выбрать с владельцем место вне checkout и worktrees, с доступом только владельцу и достаточным объёмом. Отдельно сохранить Git objects/все нужные refs (включая codex snapshots/tree refs), точный index, binary staged/unstaged patches и архив всех untracked с типами/правами. Patch без untracked недостаточен; bundle без WIP тоже. Отдельно сохранить ignored PROJECT, необходимые raw/prepared/reports inputs, исторический код и живой public/build. Не читать/выводить секреты; если нужна страховка окружения/ключей, делать отдельную зашифрованную приватную копию без включения в source archive/Git. Проверить архивы контрольными суммами и извлечением в отдельное место; хранить не единственную копию на том же временном диске. БД/volumes — отдельный согласованный consistent backup, если требуется сохранить пользовательские данные; рабочую БД в этом плане не мигрировать.
3. **Изоляция.** Создать новую ветку/worktree от проверенного HEAD после готовой страховки. Не копировать рабочий .env/ключи туда; сделать новое тестовое окружение с фиктивными значениями и отдельными volume/ports/project name. Не использовать существующие именованные volumes по совпадению Compose-имени и не применять override к отсутствующему графу. Исходные data/production assets не монтировать writable.
4. **Allowlist и отбор.** Превратить приложение в проверенный список каждого пути/удаления/hunk с владельцем коммита, размером, hash, режимом и решением secret/privacy/license review. Текстовые controls принять только после подтверждения публичных/синтетических значений; в исследовании их координаты не открывались. Переносить только эти файлы/patches из защищённого снимка, без `git add .`. Каждый staged diff проверять целиком, включая binary/symlink и случайные generated.
5. **Поэтапные gates.** После каждого кодового блока установить зависимости по locks в изолированной среде, собрать приложение и выполнить связанные P/G/E/F/B/N из таблицы. Node только в node от node; не менять TS6. GIS только с guard web_gis_test, отдельным тестовым окружением и migrations; рабочие snapshots/БД не использовать. Сначала прочитать scripts: Composer очищает config; Vite пишет assets; browser specs могут писать screenshots в data/reports; runtime tools пишут фиксированные outputs. Все эффекты остаются в копии. Фиксировать реальную команду/выход/окружение/пропуски. При неуспехе не ослаблять guards или тесты: пересмотреть границу/объединить коммиты.
6. **Внешние данные.** Подготовить безопасный release manifest вне больших outputs: dataset/source, разрешённый URL без credentials, license, версия/PBF header, observed_at отдельно от source_updated_at/imported_at; SHA-256/размер каждого входа, boundary hash и buffer, snapshot relations; версии importer/ETL/образов/profile/algorithm, параметры/лимиты, точные команды и checksums результата. Ничего не выводить из личных запросов. Локальные ID импортов не считать переносимым идентификатором набора.
7. **Финальная сверка.** Полученное дерево сравнить с замороженным нынешним WIP по каждому разрешённому product/test/config/public-map пути: bytes, удаления, executable bit, symlink target. Исключения — только заранее согласованные редакционные docs/allowlist, не исчезнувшие продуктовые файлы. Для untracked добиться нулевого списка неразобранных путей: включён, сохранён вне Git, оставлен локальным или требует решения. Сравнить также исходный HEAD/ветку/index/исходники с исходной ведомостью: они должны остаться прежними.
8. **Чистый checkout.** Проверить финальный tip в ещё одном новом checkout с установленными из lock зависимостями, без PROJECT, vendor/node_modules/public/build/data рабочего дерева. Базовый Compose запускать явно `-f docker-compose.yml`; проверить install/build/P/G/E/F/B. Нужные manifests/runbooks должны быть доступны в Git. Пустые local datasets дают честную недоступность; полный acceptance с реальными наборами и точным car runtime — отдельная процедура после восстановления внешних inputs, без обещания её по одним исходникам.
9. **Возврат.** При любом сомнении остановить только изолированное исполнение, вернуться к исходному checkout, который не изменялся. Не делать reset/stash/pop поверх исходного WIP. Если понадобится восстановление после внешнего повреждения, сначала извлечь защищённый архив в третье место, проверить hashes/modes/index/refs, затем отдельно согласовать замену; не перезаписывать исходник автоматически. Удаление/архивация экспериментального worktree и публикация — отдельные действия после приёмки.

### Особая зависимость runtime

`scripts/prepare-routing-runtime.py` читает не просто PBF: `summary.json` и `osrm-driving/pilot.osrm*` из data/reports/local-routing-2026-10-21, `prepared/context.json`, `prepared/extract-manifest.json`, а также экспорт `guard-sources.json` + `obstacles.jsonl`. `scripts/export-routing-guards.php` требует соответствующие наборы препятствий/coverage в БД. `experiments/routing-clicks/historical.php` зависит от отдельного original-routing архива из отчёта. Эти inputs нельзя исключать из внешней страховки только из-за слова reports.

Сейчас присутствуют каталоги raw/prepared/reports и верхние файлы runtime graph.sha256/manifest.json/manifest.sha256, но **содержимое, hashes, полнота inputs и возможность replay не проверены**. config/routing.php и docker/routing/start.sh закрепляют конкретный manifest/graph и OSRM 5.27.1 MLD image digest. Нельзя обещать побайтное восстановление выпуска без тех же входов, параметров/UTC prepared-at и toolchain. При отсутствии входов базовый проект воспроизводим по коду и синтетическим тестам; прежний runtime или исторический acceptance — только с сохранённым внешним выпуском/входами. Git будущей версии должен хранить безопасные manifests/versions/runbooks, а большие graphs/guards и частные материалы — защищённое внешнее хранилище. Решение о включении маленького безопасного manifest после его проверки ещё требуется.

## 9. Исключаемые категории и отдельные решения

Из будущего staging исключаются: секреты/ключи/.env с реальными значениями; личные координаты/fragment-ссылки/тела запросов/журналы; пользовательские БД/dumps/volumes; raw PBF/JSON/границы как большие внешние datasets; подготовленные graphs/guards; data/reports archives/patches/screenshots/сырые ответы и historical code bundles; vendor/node_modules/data-tools binaries; public/build/public/hot/fonts caches; storage/bootstrap/PHP/Python caches; browser results; IDE/local agent state; grocery .runtime. **Исключение из Git не означает удаление.** Исходники полезных инструментов, маленькие проверенные fixtures, public/maps и лицензии остаются кандидатами.

До исполнения отдельно решить:
- Место постоянной защищённой страховки, охват ignored/runtime/БД и окно без параллельных изменений.
- A с шестью блоками либо B; допустимость объединения №1–3 при фактических проверках.
- Публиковать ли текущий AGENTS; PROJECT оставить локальным или отдельно выбрать неперсональное содержание для переноса в основные документы, сохранив оригинал.
- Сохранять ли автосимлинк routing override или выбрать явный запуск; это поведение запуска, а не уборка истории.
- Какие безопасные manifests и фиксированные внешние версии можно включить; где хранятся точный car release, raw и historical inputs.
- Лицензионная/приватная проверка controls и исторических docs; их названия и назначение ещё не доказывают допустимость публикации всего содержимого.
- Сохранение и отдельная дальнейшая судьба pedestrian snapshot; публикация любых веток/refs проверяется отдельным сетевым этапом. Сейчас её статус неизвестен.

**Следующий конкретный шаг:** отдельным заданием утвердить allowlist/hunk-границы и сделать проверенную постоянную страховку WIP/refs/untracked/нужных ignored, не меняя исходный checkout. После этого — пробная сборка первых трёх блоков в изоляции. Ни фиксация, ни публикация этим отчётом не разрешаются автоматически.

## 10. Полный инвентарный список кандидатов на начало

Перечень ниже фиксирует все 352 исходных изменённых/untracked пути: 34 tracked-изменения (включая удаление) и 318 untracked. Это **кандидаты для проверки**, не готовая команда staging. Неизменённые 72 tracked-пути наследуются из базы; deleted GeoJsonBoundary учитывается отдельно. Общие пути имеют нескольких владельцев — требуется hunk-разделение, описанное выше. PROJECT и ignored в этот список Git status не входят; они классифицированы отдельно.


### Кандидаты №1: 82 путей

```text
M app/Console/Commands/ImportTransportStops.php
M app/Http/Controllers/Api/V1/TransportAnalysisController.php
M app/Http/Requests/TransportAnalysisRequest.php
D app/Services/Transport/Import/GeoJsonBoundary.php
M app/Services/Transport/Import/OfficialStopsImporter.php
M app/Services/Transport/TransportAnalysisService.php
M docs/data-schema.md
M docs/transport-import.md
M tests/Integration/OfficialStopsImportTest.php
M tests/Integration/PostgisConnectionTest.php
M tests/Integration/TransportAnalysisTest.php
M tests/Integration/TransportSchemaTest.php
U app/Console/Commands/ImportOsmAddresses.php
U app/Console/Commands/ImportOsmAreas.php
U app/Console/Commands/ImportOsmBuildings.php
U app/Console/Commands/ImportOsmLinear.php
U app/Console/Commands/PrepareCoverageBoundary.php
U app/Http/Controllers/Api/V1/AddressProfileController.php
U app/Http/Controllers/Api/V1/AddressSearchController.php
U app/Http/Requests/AddressProfileRequest.php
U app/Http/Requests/AddressSearchRequest.php
U app/Services/Addresses/AddressProfileService.php
U app/Services/Gis/AnalysisArea.php
U app/Services/Gis/DatasetCoverage.php
U app/Services/Gis/GeoJsonBoundary.php
U app/Services/Osm/Analysis/OsmAreaAnalysisService.php
U app/Services/Osm/Analysis/OsmAreaKind.php
U app/Services/Osm/Analysis/OsmAreaMapService.php
U app/Services/Osm/Analysis/OsmLinearAnalysisService.php
U app/Services/Osm/Analysis/OsmLinearMapService.php
U app/Services/Osm/Import/OsmAddressGeometry.php
U app/Services/Osm/Import/OsmAddressImporter.php
U app/Services/Osm/Import/OsmAddressReader.php
U app/Services/Osm/Import/OsmAreaDataset.php
U app/Services/Osm/Import/OsmAreaImporter.php
U app/Services/Osm/Import/OsmAreaReader.php
U app/Services/Osm/Import/OsmBuildingImporter.php
U app/Services/Osm/Import/OsmBuildingReader.php
U app/Services/Osm/Import/OsmLinearDataset.php
U app/Services/Osm/Import/OsmLinearImporter.php
U app/Services/Osm/Import/OsmLinearReader.php
U app/Services/Osm/Import/OsmSnapshotReader.php
U app/Services/Osm/Import/RejectedAddress.php
U app/Services/Osm/Search/AddressSearchService.php
U database/migrations/2026_10_18_000001_create_osm_addresses_table.php
U database/migrations/2026_10_18_000002_add_osm_address_search.php
U database/migrations/2026_10_19_000001_create_osm_buildings_table.php
U database/migrations/2026_10_19_000002_create_osm_linear_tables.php
U database/migrations/2026_10_19_000003_create_osm_area_tables.php
U database/migrations/2026_10_20_000001_prepare_osm_address_search.php
U database/migrations/2026_10_20_000002_create_dataset_coverages.php
U database/migrations/2026_10_20_000003_add_independent_green_area_flags.php
U docker/etl/Dockerfile
U docker/etl/requirements.txt
U docs/address-profile.md
U docs/address-search.md
U docs/area-analysis.md
U docs/coverage.md
U docs/osm-addresses.md
U docs/osm-areas.md
U docs/osm-buildings.md
U docs/osm-linear.md
U scripts/benchmark-address-search.php
U scripts/prepare-osm-areas.py
U scripts/prepare-osm-linear.py
U tests/Integration/AddressProfileTest.php
U tests/Integration/AddressSearchTest.php
U tests/Integration/DatasetCoverageTest.php
U tests/Integration/OsmAddressImportTest.php
U tests/Integration/OsmAreaAnalysisTest.php
U tests/Integration/OsmAreaImportTest.php
U tests/Integration/OsmAreaMapTest.php
U tests/Integration/OsmBuildingImportTest.php
U tests/Integration/OsmLinearImportTest.php
U tests/Integration/OsmLinearMapTest.php
U tests/PostgisTestCase.php
U tests/Support/PostgisDatabase.php
U tests/Unit/AddressSearchContextTest.php
U tests/Unit/AreaSharePrecisionTest.php
U tests/Unit/PostgisDatabaseSafetyTest.php
U tests/etl/test_prepare_osm_areas.py
U tests/etl/test_prepare_osm_linear.py
```

### Кандидаты №2: 63 путей

```text
M bootstrap/app.php
M docker/nginx/nginx.conf
M resources/views/welcome.blade.php
U app/Http/Controllers/Api/V1/PointAddressController.php
U app/Http/Controllers/Api/V1/TripAnalysisController.php
U app/Http/Middleware/LimitPointAddressRequest.php
U app/Http/Middleware/LimitTripRequest.php
U app/Http/Requests/PointAddressRequest.php
U app/Http/Requests/TripAnalysisRequest.php
U app/Services/Addresses/PointAddressService.php
U app/Services/Routing/LocalCarRouterProvider.php
U app/Services/Routing/RoutingDataException.php
U app/Services/Routing/RoutingGeometryGuard.php
U app/Services/Routing/RoutingSnapshot.php
U app/Services/Routing/TripDiagnostics.php
U app/Services/Routing/connector-issues.sql
U app/Services/Routing/geometry.sql
U app/Services/Routing/snap-candidates.sql
U config/routing.php
U docker-compose.override.yml
U docker-compose.routing.yml
U docker/routing/start.sh
U docs/local-routing-action-notice-2026-10-21.md
U docs/local-routing-audit-2026-10-21.md
U docs/local-routing-candidate-choice-2026-10-21.md
U docs/local-routing-decision-2026-10-21.md
U docs/local-routing-diagnostics-contract.md
U docs/local-routing-failure-messages-2026-10-21.md
U docs/local-routing-integration-2026-10-21.md
U docs/local-routing-privacy-access-fixes-2026-10-21.md
U docs/local-routing-snap-2026-10-21.md
U docs/point-address-2026-10-23.md
U docs/trips.md
U experiments/local-routing-poc/README.md
U experiments/local-routing-poc/audit.py
U experiments/local-routing-poc/capability_probe.py
U experiments/local-routing-poc/check_geometry.php
U experiments/local-routing-poc/check_unavailable.py
U experiments/local-routing-poc/controls.json
U experiments/local-routing-poc/diagnostic-controls.json
U experiments/local-routing-poc/diagnostic_probe.py
U experiments/local-routing-poc/diagnostic_run.py
U experiments/local-routing-poc/directions.py
U experiments/local-routing-poc/extract.py
U experiments/local-routing-poc/finalize.py
U experiments/local-routing-poc/probe.py
U experiments/local-routing-poc/review.php
U experiments/local-routing-poc/run.py
U experiments/local-routing-poc/smoke.py
U experiments/local-routing-poc/snapshot.php
U experiments/local-routing-poc/test_contract.py
U scripts/check-routing-provider.php
U scripts/export-routing-guards.php
U scripts/prepare-routing-runtime.py
U scripts/verify-trips-runtime.py
U tests/Feature/PointAddressPrivacyTest.php
U tests/Feature/TripAnalysisTest.php
U tests/Feature/TripPrivacyTest.php
U tests/Integration/PointAddressTest.php
U tests/Integration/RoutingGeometryGuardTest.php
U tests/Integration/RoutingSnapTest.php
U tests/Unit/RoutingSnapshotTest.php
U tests/security/test_trip_nginx.py
```

### Кандидаты №3: 163 путей

```text
M .github/workflows/tests.yml
M docs/frontend-structure.md
M package-lock.json
M package.json
M resources/css/app.css
M resources/js/api/transport.ts
M resources/js/app.js
M resources/js/components/AddressSearch.vue
M resources/js/components/TransportResults.vue
M resources/js/components/map/CityMap.vue
M resources/js/composables/useTransportAnalysis.ts
M resources/js/maps/basemap.json
M resources/js/pages/HomePage.vue
M resources/js/types/transport.ts
U docs/address-comparison.md
U docs/browser-smoke.md
U docs/comparison-layout-2026-10-22.md
U docs/comparison-layout-2026-10-24.md
U docs/comparison-link-r3-2026-10-25.md
U docs/comparison-map-accessibility-2026-10-22.md
U docs/comparison-personal-trips-2026-10-24.md
U docs/comparison-transfer-2026-10-22.md
U docs/comparison-workspace-2026-10-23.md
U docs/frontend-loader-r1-2026-10-25.md
U docs/local-routing-mobile-summary-2026-10-22.md
U docs/map-area-layers.md
U docs/map-controls-ui-2026-10-20.md
U docs/map-layers-final-check-2026-10-20.md
U docs/map-linear-layers.md
U docs/map-object-context-2026-10-24.md
U docs/map-stops-layer.md
U docs/map-visual-interaction-2026-10-23.md
U docs/overview-interests-2026-10-24.md
U docs/point-analysis.md
U docs/profile-map-workspace-2026-10-23.md
U docs/profile-sidebar-2026-10-23.md
U docs/refactoring-r1-r4-independent-audit-2026-10-25.md
U docs/trip-overlay-r4-2026-10-25.md
U docs/trips-scenario-2026-10-24.md
U docs/trips-state-r2-2026-10-25.md
U docs/ui-ux-review-2026-10-20.md
U playwright.config.mjs
U public/maps/osm-openmaptiles/LICENSE.md
U public/maps/osm-openmaptiles/sprite-ac72cc9b20c5.json
U public/maps/osm-openmaptiles/sprite-ac72cc9b20c5.png
U public/maps/osm-openmaptiles/sprite-ac72cc9b20c5@2x.json
U public/maps/osm-openmaptiles/sprite-ac72cc9b20c5@2x.png
U resources/js/api/addresses.ts
U resources/js/api/pointAddress.ts
U resources/js/api/profiles.ts
U resources/js/api/trips.ts
U resources/js/components/AddressPicker.vue
U resources/js/components/ComparisonData.vue
U resources/js/components/ComparisonFacts.vue
U resources/js/components/ComparisonMapSplit.vue
U resources/js/components/ComparisonMetric.vue
U resources/js/components/ComparisonMetricRow.vue
U resources/js/components/ComparisonShare.vue
U resources/js/components/ComparisonTripData.vue
U resources/js/components/ComparisonTrips.vue
U resources/js/components/MetricCard.vue
U resources/js/components/OverviewTopics.vue
U resources/js/components/PointAddressLabel.vue
U resources/js/components/ProfileMetric.vue
U resources/js/components/ProfileSummary.vue
U resources/js/components/SidebarResizeHandle.vue
U resources/js/components/TripPointPicker.vue
U resources/js/components/map/AddressMapLabels.vue
U resources/js/components/map/AreaLayerControls.vue
U resources/js/components/map/AreaLayerInfo.vue
U resources/js/components/map/LinearLayerControls.vue
U resources/js/components/map/LinearLayerInfo.vue
U resources/js/components/map/MapLayerDetails.vue
U resources/js/components/map/MapLayersPanel.vue
U resources/js/components/map/MapThemeControl.vue
U resources/js/components/map/StopLayerInfo.vue
U resources/js/components/map/TripMap.vue
U resources/js/composables/useAddressChoice.ts
U resources/js/composables/useAddressComparison.ts
U resources/js/composables/useAddressProfile.ts
U resources/js/composables/useAddressSearch.ts
U resources/js/composables/useComparisonLink.ts
U resources/js/composables/useComparisonTrips.ts
U resources/js/composables/useComparisonView.ts
U resources/js/composables/useMapTheme.ts
U resources/js/composables/useOverviewTopics.ts
U resources/js/composables/usePointAddress.ts
U resources/js/composables/useSidebarWidth.ts
U resources/js/composables/useTripAnalysis.ts
U resources/js/composables/useTripsState.ts
U resources/js/layouts/PlaceLayout.vue
U resources/js/pages/AddressProfilePage.vue
U resources/js/pages/ComparePage.vue
U resources/js/pages/TripsPage.vue
U resources/js/types/address.ts
U resources/js/types/mapLayers.ts
U resources/js/types/pointAddress.ts
U resources/js/types/profile.ts
U resources/js/types/trips.ts
U resources/js/utils/addressMap.ts
U resources/js/utils/comparison.ts
U resources/js/utils/comparisonFacts.ts
U resources/js/utils/comparisonPresentation.ts
U resources/js/utils/comparisonTrips.ts
U resources/js/utils/mapAnalysis.ts
U resources/js/utils/mapLabels.ts
U resources/js/utils/mapLayerPresentation.ts
U resources/js/utils/mapSidebarScroll.ts
U resources/js/utils/mapTheme.ts
U resources/js/utils/metricDisplay.ts
U resources/js/utils/pointSelection.ts
U resources/js/utils/profilePresentation.ts
U resources/js/utils/stopGroups.ts
U resources/js/utils/tripCandidates.ts
U resources/js/utils/tripFailure.ts
U resources/js/utils/tripMap.ts
U resources/js/utils/tripOverlay.ts
U resources/js/utils/trips.ts
U tests/Feature/ComparePageTest.php
U tests/browser/compare.spec.mjs
U tests/browser/comparison-trips.spec.mjs
U tests/browser/entry.mjs
U tests/browser/fixtures.mjs
U tests/browser/map-context.spec.mjs
U tests/browser/map-observer.mjs
U tests/browser/map-visual.spec.mjs
U tests/browser/overview-topics.spec.mjs
U tests/browser/point-address.spec.mjs
U tests/browser/profile-controls.spec.mjs
U tests/browser/profile-sidebar.spec.mjs
U tests/browser/server.mjs
U tests/browser/support.mjs
U tests/browser/trips.spec.mjs
U tests/frontend/address-choice.test.mjs
U tests/frontend/address-comparison.test.mjs
U tests/frontend/address-profile.test.mjs
U tests/frontend/address-search-presentation.test.mjs
U tests/frontend/address-search.test.mjs
U tests/frontend/area-layers.test.mjs
U tests/frontend/comparison-link.test.mjs
U tests/frontend/comparison-presentation.test.mjs
U tests/frontend/comparison-trips.test.mjs
U tests/frontend/comparison-view.test.mjs
U tests/frontend/linear-layers.test.mjs
U tests/frontend/map-layer-panel.test.mjs
U tests/frontend/map-mode.test.mjs
U tests/frontend/map-visual.test.mjs
U tests/frontend/overview-topics.test.mjs
U tests/frontend/point-address.test.mjs
U tests/frontend/point-selection.test.mjs
U tests/frontend/profile-summary.test.mjs
U tests/frontend/sidebar-width.test.mjs
U tests/frontend/stop-groups.test.mjs
U tests/frontend/stop-layer.test.mjs
U tests/frontend/support/comparison-trips-dependencies.mjs
U tests/frontend/support/map-dependencies.mjs
U tests/frontend/support/overview-dependencies.mjs
U tests/frontend/support/vue-component.mjs
U tests/frontend/transport-analysis.test.mjs
U tests/frontend/transport-coverage.test.mjs
U tests/frontend/trip-overlay.test.mjs
U tests/frontend/trips.test.mjs
U tests/frontend/vue-component-loader.test.mjs
```

### Кандидаты №4: 13 путей

```text
U experiments/routing-clicks/README.md
U experiments/routing-clicks/audit-admissions.php
U experiments/routing-clicks/boundary-probe.php
U experiments/routing-clicks/browser-controls.json
U experiments/routing-clicks/controls.json
U experiments/routing-clicks/explain.php
U experiments/routing-clicks/freeze.php
U experiments/routing-clicks/historical.php
U experiments/routing-clicks/http-check.php
U experiments/routing-clicks/inspect-snaps.php
U experiments/routing-clicks/inspect.php
U experiments/routing-clicks/measure.php
U experiments/routing-clicks/summarize.py
```

### Кандидаты №5: 12 путей

```text
U docs/grocery-poc-2026-10-20.md
U experiments/grocery-poc/.gitignore
U experiments/grocery-poc/README.md
U experiments/grocery-poc/app.js
U experiments/grocery-poc/check-browser.mjs
U experiments/grocery-poc/geo.py
U experiments/grocery-poc/index.html
U experiments/grocery-poc/prepare.py
U experiments/grocery-poc/server.py
U experiments/grocery-poc/style.css
U experiments/grocery-poc/test_poc.py
U experiments/grocery-poc/verify_snapshot.py
```

### Кандидаты №6: 12 путей

```text
U AGENTS.md
U docs/README.md
U docs/architecture.md
U docs/criteria-research-audit-2026-10-20.md
U docs/poi-coverage-audit-2026-10-20.md
U docs/product-criteria-review-2026-10-22.md
U docs/product-hypotheses.md
U docs/product-opportunities-2026-10-22.md
U docs/product.md
U docs/roadmap.md
U docs/structure-quality-audit-2026-10-25.md
U docs/user-check-plan.md
```

### Общие пути: отбор существующих hunks

| Статус | Путь | Коммиты |
|---|---|---|
| M | `.gitignore` | 1/3/6 |
| M | `README.md` | 1/2/3/6 |
| M | `phpunit.postgis.xml` | 1/2 |
| M | `routes/api.php` | 1/2 |
| M | `routes/web.php` | 2/3 |
| U | `docs/local-routing-clicks-2026-10-23.md` | 2/4 |
| U | `docs/testing.md` | 1/2/3 |

M — unstaged modified, D — unstaged deleted, U — исходно untracked (симлинк override включён как путь). Этот новый отчёт — дополнительный кандидат №6, не включён в исходные 352 записи.

## 11. Основания и ограничения результата

Основные локальные свидетельства: [карта документации](README.md), [архитектура](architecture.md), [проверки и побочные эффекты](testing.md), [перенос compare-layout](comparison-transfer-2026-10-22.md), [Goal5 routing](local-routing-clicks-2026-10-23.md), [Goal6 trips](trips-scenario-2026-10-24.md), [Goal8](map-object-context-2026-10-24.md), [Goal9](overview-interests-2026-10-24.md), [Goal10](comparison-personal-trips-2026-10-24.md), [Goal10.1](comparison-layout-2026-10-24.md), [R1](frontend-loader-r1-2026-10-25.md), [R2](trips-state-r2-2026-10-25.md), [R3](comparison-link-r3-2026-10-25.md), [R4](trip-overlay-r4-2026-10-25.md), [независимый аудит R1–R4](refactoring-r1-r4-independent-audit-2026-10-25.md).

Сегодня выполнены только локальные read-only операции: status/diff/log/show/ls-tree/ref/worktree/branch/tag, редактированное представление remote, чтение исходников/документов, сравнение blob/hash/метаданных и существования baseline-путей. Не выполнялись fetch, тесты, typecheck, сборки, запуск приложения/контейнеров, импорты/миграции, публикация, Git add/commit/reset/clean/stash/checkout/cherry-pick/rebase/merge/push, изменение ignore. Содержимое .env, ключей, журналов и личных ссылок/входов не читалось.

Итоговая повторная сверка подтвердила:

- HEAD, ветка, все refs/upstream и SHA-256 raw index совпадают с исходными; staged diff пуст.
- Все 422 проверенных существовавших исходных файла/симлинка побайтно либо по цели ссылки прежние, удалённый tracked GeoJsonBoundary не восстановлен. Дополнительных source-путей вне нового отчёта нет.
- Git status отличается ровно одной untracked-строкой этого отчёта: 33 modified, 1 deleted, теперь 319 untracked. Локальные ссылки отчёта существуют; завершающих пробелов нет.
- Сводный digest метаданных 46 883 прежних файлов не совпал. Обнаружены свежие mtime ignored .idea/phpunit.xml и .idea/workspace.xml во время исследования; содержимое этих файлов не читалось, причина/процесс записи не устанавливались. Команд записи в них не было. Поэтому побайтовую неизменность абсолютно всех ignored-файлов заявлять нельзя; автоматически восстанавливать IDE-файлы или скрывать расхождение нельзя.

В рамках этого задания записывался только новый отчёт; исходники, Git и рабочие данные нами не изменялись. Это не проверка работоспособности приложения и не новая проверка старых протоколов.

