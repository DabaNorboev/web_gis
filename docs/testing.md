---
status: current
updated: 2026-11-04
verified: not verified
---

# Проверки PlaceLens

Команды и эффекты; описание не означает выполненный прогон.

## Выбор по изменению

| Изменение | Основные проверки |
|---|---|
| Только документация | Локальные ссылки/якоря, существование путей и scripts, противоречия со схемой/кодом; сборка и БД обычно не нужны |
| Чистая TS-утилита/форматирование | Целевой frontend test, typecheck; связанные случаи null/zero/unknown/stale |
| Composable/состояние | Frontend tests с управляемыми поздними ответами, отменой, сбросом; browser smoke для подключения к странице/истории |
| UI/карта/CSS | Typecheck и frontend tests, соответствующие Playwright-сценарии, desktop/mobile/короткий экран, клавиатура и фокус; build при изменении сборки/публикации |
| HTTP/валидация/ошибки | PHP unit/feature; приватность, лимиты, 404/422/503 и независимые отказы |
| SQL/GIS/импорт | Изолированный PostGIS suite с малыми fixtures, атомарность/повтор/coverage/метры/геометрия |
| ETL | Python/PBF fixture suite, без рабочего импорта |
| Routing/privacy | PHP feature + guard/snap integration, frontend/browser regressions; Nginx privacy при изменении соответствующего слоя |

Для пешего backend без изменений UI: PHP unit/feature для source-chain,
подготовленного snapshot и API; `python3 -B tests/routing-runtime/test_walking_prepare.py -v`
для offline-подготовки на синтетических fixtures. Это не запускает ORS/БД.
Реальная готовность дополнительно требует проверки закреплённого ORS и отказов
API в изолированном окружении; выполненный протокол — [walking-backend](features/walking-backend.md).

Пеший UI дополнительно проверяется `walking-contract.test.mjs`, регрессиями
состояния в `trips.test.mjs`/`comparison-trips.test.mjs`/`comparison-link.test.mjs`
и `tests/browser/walking-trips.spec.mjs` на четырёх viewport. Эти проверки
исполняют настоящий frontend с синтетическими ответами API; работа ORS и
реальный доступ к объекту ими не подтверждаются. Production build можно
направить в новый каталог через `npm run build -- --outDir <новый-каталог>`,
сохраняя опубликованный `public/build`.

Количество тестов не является основанием удаления. Разные уровни ловят разные ошибки. Повторы loader-инфраструктуры можно сокращать, сохраняя поведение; стоимость viewport-матрицы менять после проверки покрытия сценариев и времени выполнения.

П3: целевые проверки кодека и настоящий IndexedDB в отдельном browser-стенде — [команды, требования и эффекты](frontend-structure.md#хранение-нового-поиска-п3).

## Команды и побочные эффекты

Команды из корня проекта, в уже подходящем окружении. Node запускается штатным пользователем `node`. Никакая команда в этой таблице не является разрешением менять рабочую БД или опубликованные assets в задании только на чтение.

| Команда | Назначение | Что меняется/требуется |
|---|---|---|
| `docker compose exec node npm run typecheck` | `vue-tsc --noEmit` | Установленные зависимости; исходники/build не переписывает при текущем tsconfig |
| `docker compose exec node npm test` | Node behavior/SFC tests | Выполняет тестовый код; не требует PHP/БД/router. Общий loader TS/SFC с явными зависимостями |
| `docker compose exec node npm run test:smoke` | Playwright | Временная сборка и свой HTTP-server; пишет `test-results`/`playwright-report`, требует Chromium/системные библиотеки |
| `docker compose exec node npm run build` | Vite production build | Меняет `public/build` и manifest, может обращаться к font provider; это не read-only проверка |
| `docker compose exec php composer test` | PHP unit/feature | Script предварительно делает `artisan config:clear`; конфигурация тестов использует SQLite in-memory |
| `docker compose exec php composer test:postgis` | Оба GIS-набора | Script делает `config:clear`; работает с `web_gis_test`, пишет fixtures/тестовые схемы в write-наборе |
| `sh scripts/init-test-db.sh` | Создание тестовой БД/PostGIS | DDL через контейнер db: создаёт `web_gis_test` и extension при отсутствии. Не запускать как проверку документации |
| `PYTHONDONTWRITEBYTECODE=1 python3 tests/security/test_trip_nginx.py` | Nginx synthetic privacy | Python 3 + Docker CLI/daemon; одноразовый контейнер без сети, временные файлы в tmpfs; при отсутствии получает образ проекта |

`composer setup`, install/update, миграции, импорты и acceptance-скрипты не входят в безопасный универсальный «запустить всё». Изучать их отдельные эффекты перед использованием.

### Точечный старт проверки

Примеры для уже подготовленного окружения; выбирать по изменённому поведению и дополнять уровнями из таблицы выше. Это не замена обязательным CI-наборам. Node-команды явно задают пользователя `node`.

| Изменение | Начальная команда | Эффекты и когда расширять |
|---|---|---|
| Представление адресного поиска | `docker compose exec --user node node node --test tests/frontend/address-search-presentation.test.mjs` | Без backend/БД; добавить typecheck для TS, browser-сценарий при изменении подключения/взаимодействия |
| Демонстрационная страница анализа `/analysis` | `docker compose exec php php artisan test --filter=PlaceAnalysisPageTest`; `docker compose exec --user node node npm run test:smoke -- --project=short-desktop tests/browser/place-analysis.spec.mjs` | Синтетические данные, без API/БД; typecheck/build; browser требует установленный Chromium и проверяет один desktop-сценарий, не заменяя A6-приёмку |
| Состояние самостоятельных поездок | `docker compose exec --user node node node --test tests/frontend/trips.test.mjs tests/frontend/walking-contract.test.mjs` | Без backend/БД; добавить typecheck и browser для URL/history, фокуса или подключения к странице; при общей логике — регрессии сравнения/ссылки |
| Пеший UI | `docker compose exec --user node node npm run test:smoke -- tests/browser/walking-trips.spec.mjs` | Временная сборка и browser-отчёты, все четыре viewport; API синтетический. Дополнить frontend/typecheck по таблице выше; ORS/доступ этим не проверяются |
| Пеший API | `docker compose exec php composer test -- --filter=WalkingTripAnalysisTest` | Очищает config cache, синтетические snapshot/HTTP и временные файлы; добавить затронутые unit/privacy и GIS-проверки при изменении соответствующих границ |
| Автомобильный geometry guard | `docker compose exec php composer test:postgis -- --testsuite=PostGISReadOnly --filter=RoutingGeometryGuardTest` | Очищает config cache, только защищённая `web_gis_test`; не проверяет импорты/запись или пеший guard. При их изменении выбрать соответствующие наборы |

Файлы и фильтры — примеры выбора, не постоянный минимум для любой задачи. Полный прогон нужен при изменении общих зависимостей/стенда или риске за пределами выбранного набора. Для правки только документации достаточно проверок первой строки основной таблицы.

## Проверка документации

После любых правок docs запускать `scripts/check-docs` (эквивалент: `python3 -B scripts/check-docs`). Он проверяет шапки, значения статуса/дат, относительные ссылки и якоря, достижимость документов из индекса и входящие ссылки из tracked Markdown, включая README/AGENTS. Сеть, приложение, БД и runtime не запускаются; файлы не изменяются.

Предел размера — 40 KiB (40 960 байт UTF-8), вычисляется как `len(text.encode('utf-8'))`: превышение в `features/` и `plans/` даёт ошибку и ненулевой exit code; в остальных текущих документах — предупреждение. Для исторических материалов в `history/`, `archive/` и `research/` размер не диагностируется; шапки, индекс и переносимые ссылки по-прежнему проверяются. Ссылки на ignored `data/reports` в исторических документах выводятся как `INFO`, а в `features/`, `plans/` и `data/` — как `WARN`: локальное свидетельство нельзя считать доступным в checkout. Это граница проверки, а не подтверждение сохранности входов. Ошибки обычных ссылок и якорей не понижаются до INFO.

Проверяются все Markdown в docs, включая untracked-планы, без исключений. Ошибки защищённых от изменений документов указывать в отчёте, не обходить checker. Исторический статус не означает успешную новую проверку приложения.

Регрессии checker: `python3 -B tests/docs/test_check_docs.py -v` — только временные Markdown-fixtures. Проверка документации не подтверждает поведение приложения или свежесть исторических прогонов. При переносе документов дополнительно проверяются точные ссылки на них из tracked Markdown вне docs.

## PHP и PostGIS

Конфигурации — `phpunit.xml`, `phpunit.postgis.xml`; CI запускает обычный `composer test` и полный `composer test:postgis`. `tests/Support/PostgisDatabase.php` и `tests/PostgisTestCase.php` проверяют конфигурацию до подключения, затем фактическую БД и режим.

- `PostGISWrite`: только `web_gis_test`, READ ONLY off; миграции и записывающие fixtures. Миграционные проверки используют изолированные тестовые схемы.
- `PostGISReadOnly`: connection, RoutingGeometryGuard и RoutingSnap; только `web_gis_test`, отдельное read-only соединение на тест, SELECT/CTE на синтетической геометрии.
- DB_URL принудительно пустой; read/write host overrides запрещены guard. Тесты не меняют defaults БД/роли и не отключают внешнюю read-only защиту.
- При несовместимой конфигурации suite должен отказать. Обход guards ради зелёного результата запрещён.

После отдельной подготовки тестовой БД для диагностики можно выбрать suite:

```bash
docker compose exec php composer test:postgis -- --testsuite=PostGISReadOnly
docker compose exec php composer test:postgis -- --testsuite=PostGISWrite
```

Обёртки Composer очищают config и при выбранном suite. Для целевого PHP-запуска без этой обёртки возможен прямой `vendor/bin/phpunit` с `--do-not-cache-result --no-logging --no-coverage`; это всё равно исполняет приложение/тесты и требует проверки test configuration, не является статическим анализом.

## Frontend и browser

`npm test` исполняет настоящие исходные TS-модули/composables и SFC через тестовые loaders, подменяя явно выбранные зависимости. `tests/frontend/support/vue-component.mjs` — единственное место преобразования модулей: TypeScript CommonJS transform и Vue SFC compiler. `loadModule` читает TS, `loadComponent` компилирует SSR или client render/setup, `loadSetup` открывает явно перечисленные bindings двух страниц для существующих state-тестов. Импорты передаются по точным спецификаторам; неизвестный модуль и отсутствующий именованный экспорт приводят к ошибке. Тесты самостоятельных поездок исполняют настоящий `useTripsState` через `loadModule`: доменные сценарии обращаются к его API, а проверки страницы/SSR сохраняют настоящую связь с composable; транспорт/API и DOM подменяются явно. Browser globals передаются отдельно и не записываются в `globalThis`; общего кэша вычисленных модулей нет. Карты используют явную таблицу зависимостей CityMap, CSS обозначен отдельной зависимостью без Node runtime. `trip-overlay.test.mjs` исполняет настоящий tripOverlay и настоящий CityMap через тот же loader; управляются только MapLibre/DOM/очередь кадров. Проверяются повторная установка/очистка собственных слоёв, актуальный ID кандидата и исходные координаты, независимость сторон и отмена отложенной камеры. Регрессии loader — `vue-component-loader.test.mjs`; [протокол переноса R1](history/frontend-loader-r1-2026-10-25.md). Отдельные SSR-проверки всё ещё используют старую MetricCard; [аудит](research/structure-quality-audit.md) предлагает перенос регрессий, а не простое удаление теста.

`playwright.config.mjs` задаёт четыре viewport и один worker. `tests/browser/server.mjs` собирает настоящий app во временный каталог, не читает `.env`, не пишет опубликованные assets и не проксирует к backend. HTML стенда подключает CSS entry и всех статических imports из manifest, включая общие SFC/MapLibre styles. API fixtures синтетические, MapLibre/DOM настоящие. Итоги Playwright в рабочем дереве — отдельный побочный эффект.

Сценарии охватывают главную, профиль, сравнение, личные поездки, тему/слои, выбор объекта, поздние ответы, историю, фокус и отказ подложки. Нельзя считать количество тестов из старого отчёта актуальным результатом. Подготовка Chromium, изоляция, наборы и ограничения — [browser-smoke](browser-smoke.md).

`interface-preference.test.mjs` проверяет безусловный workspace без чтения/записи прежнего предпочтения, включая отсутствие browser globals. `tests/browser/interface-switch.spec.mjs` проверяет чистый/classic/workspace/отказавший storage, отсутствие переключателя и навигации, прямые прежние страницы, pending search, явный объект, единственный MapLibre, URL/history и форму самостоятельной поездки. API синтетический; рабочая БД не требуется.

`home-workspace.test.mjs` проверяет настоящие `useHomeWorkspace`/загрузчики и root URL: независимые стороны, отсутствие повторного профиля А, общий радиус, точку без запроса остановок, abort/late response, восстановление без history. `tests/browser/home-workspace.spec.mjs` проходит адрес → профиль → А/Б, источники/ошибки, замены/удаление, переключение с pending/черновиком, точку и позднюю геометрию на четырёх viewport. Для изменений главной также запускать `interface-switch`, `point-address`, `compare` и `profile-sidebar` smoke как регрессии прежних страниц; стенд и его эффекты прежние.

`home-trips.test.mjs` исполняет настоящий useHomeTrips, оба владельца поездок, API-контракт и обработчики панели: одна/две стороны, независимые сценарии, смена режима/геометрии, поздние ответы, стабильные ID и восстановление пустого черновика без сброса пешего результата другого сценария. `home-workspace-map.test.mjs` проверяет настоящий адаптер с CityMap и управляемым MapLibre: фильтрацию контекста/sequence, endpoint, исходные геометрии и отсутствие неявной камеры.

`tests/browser/home-trips.spec.mjs` использует реальные HomePage/панель/MapLibre с синтетическими API из `fixtures/home-trips.mjs`. Проверяет полный проход с клавиатуры от одного адреса к паре, оба режима, произвольный старт и улицу через общую карту, кандидата через canvas, независимые ошибки/повторы, поздние ответы после замены/удаления, ordinary/personal ссылки и их копии в отдельных browser contexts с тем же API-стендом, Back/Forward/reload, ожидание профилей и дедупликацию restore, сохранение между интерфейсами, ранний focus/отмену по цели и sequence. При изменении общих границ главной запускать typecheck, полный npm test и browser-регрессии главной, point-address, interface-switch, сравнения, профиля, самостоятельных и пеших поездок; полный smoke также включает карту/темы/слои. Все Node-команды — `docker compose exec --user node node …`; browser-сборка временная, backend/данные/guards не меняются.

`home-metric-presentation.test.mjs` проверяет реальные helpers: null/zero, даты наблюдения отдельно от публикации, покрытие и объяснения методов. `home-result-matrix.spec.mjs` проверяет общие колонки, один профиль до поездок, две/три цели, длинные подписи и неизвестные причины, ожидание/ошибку Б, одиночный повтор, доступные вкладки, полные подробности и возврат фокуса. Сценарий снимков явно устанавливает и проверяет viewport 1440×900, 1280×720, 1280×560, 390×844 и 320×740, включая доступность первой строки окружения прокруткой при регулируемой высоте карты. Регрессии компоновки проверяют pointer/keyboard resize соседних колонок, сброс, минимумы, переход viewport и пары в одиночный профиль, длинные названия, сохранность сторон/источников/подробностей и заполненные карточки на 1440×900/1280×720/390×844/320×740. Для изменений матрицы результатов дополнять наборами home-workspace, home-trips, interface-switch и desktop-editor; предыдущие результаты прогонов не являются текущей проверкой. Все Node-команды выполняются в Compose `node` пользователем `node`; production assets не изменяются.

`home-orientation.test.mjs` проверяет парсер и исходные значения (null/zero, равенство, малое превышение, большие шкалы). `home-trips.test.mjs` сохраняет проверки владельцев, ID/режимов/сценариев, remove/restore, запроса, эпох/sequence/геометрии и первого ложного акцента. `home-orientations.spec.mjs` проверяет карандаш → точную боковую карточку без модалки, свёрнутую панель/мобильные настройки, фокус, валидацию и сохранение, поздний ответ, режимы/сценарии, radius/URL/reload, тихие ячейки с полными причинами и источниками в ⓘ. Интеграционный сценарий сверяет GeoJSON при правках ориентира, радиуса, названия/точки, режима, замене/удалении сторон. Viewport 1440×900/390×844/320×740 не заменяют физический телефон. Node — в Compose от node; browser-сборки последовательны, API синтетический, production assets не меняются.

`home-interface-controls.spec.mjs`: поиск, режим, старт. `home-goal-preview.spec.mjs`: V2, контуры/выбор/поздние ответы, 1440×900/390×844; `home-workspace-map.test.mjs`: приоритет preview и stale callbacks. [Контракт](features/home-workspace-map.md#предпросмотр-адреса-цели--v2).

`home-map-signal.test.mjs` проверяет перевод всех состояний подготовленного ориентира без новой формулы. Дополнение `home-trips.test.mjs` проверяет несколько целей/сторон, собственные токены и геометрию, фильтр показа, удаление/режим и неизменность sequence при правке ориентира. `home-map-overview.spec.mjs` проверяет настоящий MapLibre с синтетическим API: строка → карта → подробности А/Б → точный возврат, одинаковые длинные подписи, состояния Б, фильтр без POST/history/движения камеры, раскрытие/resize и шесть фактических размеров; на короткой мобильной карте — все три метки целей и достижимость zoom/масштаба/атрибуции прокруткой без движения камеры. При правках общих CityMap/overlay сохраняются прежние map/layers/trips/profile/compare smoke. Сборки выполнять последовательно, Node — в Compose пользователем node; проверки не подтверждают рабочие GIS/OSRM/ORS и физический телефон.

## ETL и Nginx

Для уже подготовленного локального ETL image:

```bash
docker run --rm --network=none --memory=1g --cpus=2 \
  --user "$(id -u):$(id -g)" -v "$PWD:/work:ro" \
  web-gis-osm-etl:local python -m unittest discover -s tests/etl -v
```

Это маленькие PBF-fixtures; создание/сборка image — отдельная операция. CI собирает image с тегом `web-gis-osm-etl:ci` и запускает ту же fixture suite. Постоянный ETL Compose-сервис не нужен.

Nginx privacy запускается локально и в самостоятельном job `nginx-privacy` в
`.github/workflows/tests.yml` одной командой:

```bash
python3 -B tests/security/test_trip_nginx.py -v
```

Нужны Python 3 (только стандартная библиотека), Docker CLI и доступ к Docker daemon.
Тест читает literal image из nginx-секции `docker-compose.yml` (сейчас
`nginx:1.27-alpine`), но не запускает Compose и не читает `.env`. Если образа нет,
Docker получает его из registry; для этого нужен интернет. Приложение, PHP, БД,
OSRM и ORS не нужны.

Runner создаёт уникально названный контейнер с `--network=none`, read-only root и
`/tmp` в tmpfs. Порты не публикуются, запросы идут по loopback внутри контейнера.
Монтируются только production `docker/nginx/nginx.conf` и общий shell-probe,
оба read-only; рабочих volumes, socket и журналов приложения внутри нет.
Технические подстановки меняют только временные пути, loopback-порт, include
fastcgi_params и закрытый upstream. Проверяются config/startup, фиксированные
классы access log, отсутствие query/Referer/координат/тела/canary в тестовых
серверных журналах, no-referrer, 502, оба лимита 413, no-store для resolve-point
включая ошибки, пустой body temp directory и штатное завершение Nginx.

Общий бюджет создания/получения образа и выполнения — 120 секунд;
`--timeout <секунды>` задаёт бюджет до 240 секунд. Удаление только собственного
контейнера выполняется в finally при успехе, ошибке, timeout, SIGINT и SIGTERM
с отдельным пределом 15 секунд. При недоступном daemon ошибка удаления явно
сообщается; SIGKILL/потеря хоста не позволяют гарантировать cleanup. Образ остаётся
в Docker cache, tmpfs удаляется вместе с контейнером. Диагностика сообщает только
фиксированные этапы/категории ошибок, без сырых Docker/Nginx/client logs.

Для отрицательного контроля можно передать `--config /tmp/<копия>.conf` с
намеренно небезопасным форматом логирования; production-файл менять не нужно.
Набор assertions остаётся тем же. CI job имеет `contents: read`, timeout 5 минут
и запускает ту же команду без services/зависимостей других jobs. Наличие job и
локальные прогоны не означают, что workflow уже исполнился на GitHub.

## Acceptance и отчётность

`scripts/check-routing-provider.php`, `verify-trips-runtime.py`, routing PoC и browser live-check из прошлых отчётов могут обращаться к настоящему приложению/БД/router и писать результаты. Они не часть обычного изолированного smoke. У некоторых датированных скриптов фиксированные выходные пути; перед повторением проверить защиту от перезаписи и сохранить исторические свидетельства.

`scripts/verify-trips-runtime.py` требует `--output-dir`: конечный каталог должен
ещё не существовать (в том числе как пустой каталог, файл или симлинк), его
родитель должен существовать. Все JSON создаются исключительно новыми; каталог
не удаляется даже при ошибке, для повторного запуска нужен другой путь.
`--no-path-candidates` задаёт вход только для чтения; по умолчанию это
`data/reports/local-routing-integration-2026-10-21/no-path-candidates.json`.
В обычном режиме отсутствие входа даёт ошибку до HTTP; `--unavailable` его не читает.
Пример для отдельно разрешённого acceptance в подготовленном окружении
(путь результатов заранее не создавать):

```bash
python3 -B scripts/verify-trips-runtime.py \
  --output-dir data/reports/trips-runtime-2026-10-27-run-01 \
  --no-path-candidates data/reports/local-routing-integration-2026-10-21/no-path-candidates.json
```

Изолированная проверка защиты: `python3 -B tests/routing-runtime/test_verify_trips_runtime.py -v`.
Она использует временные каталоги и синтетические входы, полностью подменяет HTTP;
не подтверждает реальную маршрутизацию и не закрывает весь C2.

F03: `python3 -B tests/routing-runtime/test_audit_admissions.py -v` — PHP CLI + Tokenizer, tmp без Laravel/БД/сети. [CLI](../experiments/routing-clicks/README.md).

Отчёт: команда, область/окружение, результат, пропуски/ограничения. Mocked browser не подтверждает GIS/OSRM, старый протокол — текущую публикацию, localhost — физический телефон/screen reader. Lint/ссылки не проверяют поведение.

`home-mobile-navigation.spec.mjs` проверяет пустые настройки/восстановление, профиль до поездок, явную загрузку и частичный отказ, поздний ответ при редактировании, независимые позиции экранов, приоритет и потребление возврата, удаление цели, один MapLibre/отсутствие неявного fit/POST, breakpoint в обе стороны и интерфейсы. Последовательный visual case утверждает фактические 1440×900, 1280×720, 1280×560, 390×844, 320×740, 390×480; снимает три экрана и диалог, проверяет Tab/Escape, CSS zoom 200% в Chromium и reflow 640×360 для desktop 1280×720 при увеличении. Это не физические touch/экранная клавиатура или screen reader. Запускать вместе с home-workspace/trips/orientations/result-matrix/map-overview и interface-switch; снимки через outputPath не перезаписывают прежние свидетельства.
