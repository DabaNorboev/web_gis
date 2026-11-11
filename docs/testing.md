---
status: current
updated: 2026-11-11
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
| Grocery А8 | `docker compose exec php composer test:postgis -- --filter=GroceryPoiTest`; `tests/etl/test_prepare_osm_grocery.py` в существующем ETL-образе; browser `place-analysis-grocery.spec.mjs` | Только защищённая `web_gis_test`; fixtures и транзакционный импорт; v2 rules/categories/scope через PostGIS, учёт/исключения relations, отказ старого формата и поздний отказ после деактивации. ETL: node-only/nested-only запрещают публикацию; внешнее исключение только по полным координатам. `A8_LEGACY_GROCERY_FILE` включает проверку сохранённого v1, `A8_GROCERY_FILE` явно включает тест подготовленного реального файла, `A8_GROCERY_QA_DIR` — запись новых QA-ответов в отдельный каталог и opt-in Node `grocery-real-response.test.mjs`; рабочие данные не меняются. ETL без сети/БД, временный output; browser — синтетические API/временная сборка |
| Анализ места `/analysis` и демо `/analysis?demo=1` | `docker compose exec --user node node node --test tests/frontend/place-analysis-demo.test.mjs`; `docker compose exec --user node node npm run test:smoke -- tests/browser/place-analysis.spec.mjs`; `docker compose exec php php artisan test --filter=PlaceAnalysisPageTest` | Демо и API fixtures без рабочей БД/HTTP; `place-analysis-api.test.mjs` и `place-analysis-state.test.mjs` проверяют эхо, независимость, epochs/abort/timeout; browser `place-analysis-api.spec.mjs` — независимую доставку/ошибки/unavailable/контур и выбор объекта/станций; `place-analysis-point-address.test.mjs` и browser `place-analysis-point-address.spec.mjs` — независимый ориентир, точные координаты, явный переход/ошибка resolver, отсутствие результата и поздние ответы; `place-analysis-address.spec.mjs` — группы/единственный адрес, этажность, отсутствие начальной метки, автозапуск, камеру, hover/focus и позднюю выдачу; typecheck и сборка в отдельный каталог. Browser требует Chromium и проверяет экран, компоновку шапки и поиска, единые кнопки карточек/точки, сохранение настроек и порядка слоёв, связанный выбор POI списком/маркером, keyboard-only точку, тему подложки, сворачивание слоёв, радиус/неизвестный набор, станции, атрибуцию и адрес на четырёх viewport, не заменяя A6-приёмку |
| Состояние самостоятельных поездок | `docker compose exec --user node node node --test tests/frontend/trips.test.mjs tests/frontend/walking-contract.test.mjs` | Без backend/БД; добавить typecheck и browser для URL/history, фокуса или подключения к странице; при общей логике — регрессии сравнения/ссылки |
| Пеший UI | `docker compose exec --user node node npm run test:smoke -- tests/browser/walking-trips.spec.mjs` | Временная сборка и browser-отчёты, все четыре viewport; API синтетический. Дополнить frontend/typecheck по таблице выше; ORS/доступ этим не проверяются |
| Пеший API | `docker compose exec php composer test -- --filter=WalkingTripAnalysisTest` | Очищает config cache, синтетические snapshot/HTTP и временные файлы; добавить затронутые unit/privacy и GIS-проверки при изменении соответствующих границ |
| Автомобильный geometry guard | `docker compose exec php composer test:postgis -- --testsuite=PostGISReadOnly --filter=RoutingGeometryGuardTest` | Очищает config cache, только защищённая `web_gis_test`; не проверяет импорты/запись или пеший guard. При их изменении выбрать соответствующие наборы |

Файлы и фильтры — примеры выбора, не постоянный минимум для любой задачи. Полный прогон нужен при изменении общих зависимостей/стенда или риске за пределами выбранного набора. Для правки только документации достаточно проверок первой строки основной таблицы.

### Спутниковая офлайн-подготовка А9.1

CI-job `osm-preparation` запускает **весь** `tests/etl`: OSM/PBF и спутниковые fixtures в одном `docker/etl`-образе. Базовый Python закреплён digest; `docker/etl/requirements.txt` фиксирует все Python-зависимости и hashes колёс CPython 3.12/Linux x86_64, включая numpy/rasterio/affine/shapely/Pillow и их зависимости. Существующие OSM pins не изменяются; ignored `data/reports/.../python-libs` не нужны. Сборка получает пакеты по сети; тестовый контейнер сети не имеет:

```bash
docker build -t web-gis-osm-etl:ci docker/etl
docker run --rm --network=none --memory=1g --cpus=2 \
  --user "$(id -u):$(id -g)" -v "$PWD:/work:ro" \
  web-gis-osm-etl:ci python -m unittest discover -s tests/etl -v
```

CI-job `documentation-and-environment` выполняет `python3 -B scripts/check-docs`, регрессии `python3 -B -m unittest discover -s tests/docs -v` и `python3 -B -m unittest discover -s tests/environment -v`. Последние требуют Docker Compose CLI и POSIX shell, но не Docker daemon/БД/volumes: чистые временные конфигурации проверяют базовый режим без satellite-данных, persisted dev/build, read-only mounts и `create_host_path: false`; настоящий PHP startup-script со stub финального server exec проверяет полноту четырёх параметров и формат pins. Compose config не проверяет существование каталогов: реальный отказ bind отдельно проверяется с daemon. Никакая из этих команд не запускает рабочий стек. Выбор Laravel manifest при существующем hot и устаревшем config проверяет `docker compose exec -T php php vendor/bin/phpunit tests/Feature/FrontendAssetsModeTest.php` (synthetic manifest/hot во временном каталоге, без БД).

При изменении запуска дополнительно проверить изолированный стек без ignored-конфигурации/спутников и рабочих volumes: HTTP `UNAVAILABLE / SATELLITE_NOT_CONFIGURED`, dev/build и restart Node, отказ несуществующего явного bind без создания каталога. Затем в разрешённом локальном экземпляре — HTML и каждый опубликованный asset, спутниковый POST и PNG, сохранность POI и прежней сборки; режимы/команды — в [runbook](runbook-local.md#выбор-frontend-assets). Config-тесты не заменяют эти HTTP-проверки. Не запускать миграции/импорты ради smoke; одноразовая БД стенда изолируется от рабочей.

Синтетические GeoTIFF/XML/proof только во временном каталоге: offset/формула, DN1/nodata/SCL/приоритеты, нечётное смещение nearest 20→10 м, сетки, прозрачность, полигональное покрытие, hashes и отказ перезаписи/изменённых входов. Для native-вырезок проверяются оконный proof/scope/origin, полная JP2-сетка, DN-кодировка и точность XML-времени. Для индекса — чтение записанного рецепта независимо от форматирования входа, обязательные файлы, hashes, версии, общий extent, дубликаты и запрет перезаписи. Дополнительно проверяются все float32-границы легенды и соседние значения, scope оконного покрытия, полные знаменатели кругов внутри/на краю/снаружи, различие scene/prepared/usable, null без пригодных данных и допустимый нулевой NDVI. Это не реальные Sentinel-данные. Реальная проверка — отдельный запуск команды выпуска в **новый** каталог по закреплённым входам: hashes и identity, полное окно JP2/COG и независимая формула NDVI, повторное открытие outputs, время и размер. Нужны ignored-входы; отсутствие — блокер, не замена fixtures. Приложение, сеть, рабочая БД и public/build не используются.

### Городской спутниковый выпуск А9.5

В изолированном runtime [городского контракта](data/satellite.md#первый-городской-выпуск-а95-schema-3): `python3 -B tests/etl/test_satellite_city.py -v` (synthetic GeoTIFF/XML, временные каталоги) и после изменения dispatch индекса `python3 -B tests/etl/test_satellite_index.py -v` для прежнего формата. Проверяются инвариантность к размеру блока, нечётная привязка SCL, геометрический overlap без выбора по качеству, единое происхождение каналов, target вместо bbox, неизвестная кодировка/смешанный проход/изменённый вход, неполный manifest и круги. Работа с fixtures не подтверждает реальную радиометрию.

Реальный прогон — новый каталог, собственные JP2/XML каждого продукта и потоковая проверка записанного выпуска через `--stage review`. `/usr/bin/time -f 'elapsed_seconds=%e max_RSS_KiB=%M'` измеряет внешний wall/RSS, внутренние metrics — обработку и Linux `getrusage` после импорта. Круги, стык, облачные исключения и изображения проверяются отдельно. Никакая команда не запускает API/БД и не активирует набор. Успешные неизменённые старые выпуски повторно не готовятся.

А9.6 дополнительно: `python3 -B tests/etl/test_select_satellite_city.py -v` проверяет год/сезонные окна, tileInfo identity старых STAC и отказ частичных HTTP-входов; городской набор проверяет шесть явных manifest и pinned reuse source/size/hash. Сохранённые выпуски 2026 повторно не готовятся; для нового индекса проверяются их assets/hashes и совместимость.

## Проверка документации

После любых правок docs запускать `scripts/check-docs` (эквивалент: `python3 -B scripts/check-docs`). Он проверяет шапки, значения статуса/дат, относительные ссылки и якоря, достижимость документов из индекса и входящие ссылки из tracked Markdown, включая README/AGENTS. Сеть, приложение, БД и runtime не запускаются; файлы не изменяются.

Предел размера — 40 KiB (40 960 байт UTF-8), вычисляется как `len(text.encode('utf-8'))`: превышение в `features/` и `plans/` даёт ошибку и ненулевой exit code; в остальных текущих документах — предупреждение. Для исторических материалов в `history/`, `archive/` и `research/` размер не диагностируется; шапки, индекс и переносимые ссылки по-прежнему проверяются. Ссылки на ignored `data/reports` в исторических документах выводятся как `INFO`, а в `features/`, `plans/` и `data/` — как `WARN`: локальное свидетельство нельзя считать доступным в checkout. Только для документов со статусом `history`/`superseded` в `history/`, `archive/` или `research/` ссылки на `experiments/<имя>/.runtime/<файл>` также считаются локальными генерируемыми свидетельствами (`INFO`). Активные документы и отсутствующие исходники экспериментов по-прежнему дают ошибку. Это граница проверки, а не подтверждение сохранности входов. Ошибки обычных ссылок и якорей не понижаются до INFO.

Проверяются все Markdown в docs, включая untracked-планы, без исключений. Ошибки защищённых от изменений документов указывать в отчёте, не обходить checker. Исторический статус не означает успешную новую проверку приложения.

Регрессии checker: `python3 -B tests/docs/test_check_docs.py -v` — только временные Markdown-fixtures. Проверка документации не подтверждает поведение приложения или свежесть исторических прогонов. При переносе документов дополнительно проверяются точные ссылки на них из tracked Markdown вне docs.

## PHP и PostGIS

Конфигурации — `phpunit.xml`, `phpunit.postgis.xml`; CI запускает обычный `composer test` и полный `composer test:postgis`. `tests/Support/PostgisDatabase.php` и `tests/PostgisTestCase.php` проверяют конфигурацию до подключения, затем фактическую БД и режим.

- `PostGISWrite`: только `web_gis_test`, READ ONLY off; миграции и записывающие fixtures. Миграционные проверки используют изолированные тестовые схемы.
- `PostGISReadOnly`: connection, RoutingGeometryGuard, RoutingSnap и PlaceAnalysis (круг 200/1000 и SQL timeout); только `web_gis_test`, отдельное read-only соединение на тест, SELECT/CTE на синтетической геометрии.
- DB_URL принудительно пустой; read/write host overrides запрещены guard. Тесты не меняют defaults БД/роли и не отключают внешнюю read-only защиту.
- При несовместимой конфигурации suite должен отказать. Обход guards ради зелёного результата запрещён.

После отдельной подготовки тестовой БД для диагностики можно выбрать suite:

```bash
docker compose exec php composer test:postgis -- --testsuite=PostGISReadOnly
docker compose exec php composer test:postgis -- --testsuite=PostGISWrite
```

Обёртки Composer очищают config и при выбранном suite. Для целевого PHP-запуска без этой обёртки возможен прямой `vendor/bin/phpunit` с `--do-not-cache-result --no-logging --no-coverage`; это всё равно исполняет приложение/тесты и требует проверки test configuration, не является статическим анализом.

## Frontend и browser

`npm test` проверяет настоящие TS-модули/composables/API/storage через `tests/frontend/support/vue-component.mjs`. После удаления прежних UI сохранены headless-части смешанных тестов; SSR/browser-сценарии удалённых страниц сняты. Loader по-прежнему отклоняет неизвестные модули/экспорты.

`PlaceAnalysisPageTest` проверяет `/` и redirects старых страниц без query/session. `place-analysis.spec.mjs` проверяет единственный экран, отсутствие демо и сохранность browser records. Остальные `place-analysis-*.spec.mjs` проверяют независимость блоков, ошибки/поздние ответы, адресные группы и ориентир, круг, категории POI, счётчики, связанный выбор, слои, клавиатуру и desktop/mobile.

`playwright.config.mjs` задаёт четыре viewport. `tests/browser/server.mjs` собирает настоящий entry во временный каталог, не читает `.env`, не меняет `public/build`, не проксирует к backend; API синтетические, MapLibre/DOM настоящие. Browser-артефакты пишутся в test-results/playwright-report. Это не рабочий HTTP smoke. Node-команды выполняются в node-контейнере пользователем node. [Общие ограничения](browser-smoke.md).

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
включая ошибки; для place-analysis — граничные 8192/8193 байт с Content-Length и chunked, безопасные JSON 413/502/504, однократные no-store/no-referrer; пустой body temp directory и штатное завершение Nginx. Для синтетического 504 только во временной конфигурации read timeout сокращается с 15s до 1s, upstream заменяется локальным TCP listener без ответа.

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

### Аптеки А8

[Аптечный контракт](data/osm-pharmacy.md): `test_prepare_osm_pharmacy.py` вместе с grocery проверяет полный geometry/scope и блокирующую диагностику relations. `PharmacyPoiTest` — только защищённая web_gis_test: независимые снимки/отказы/поздний rollback, ноль/partial, геометрия 200/1000, aliases и выбор категории для одного OSM ID. Опциональный `A8_PHARMACY_FILE` включает реальный локальный набор; `A8_PHARMACY_QA_DIR` пишет JSON только в новый каталог с fopen x, повторно туда не писать. Транзакции откатываются. `pharmacy-real-response.test.mjs` с этим QA-каталогом проверяет реальный TS runtime; `place-analysis-pharmacy.spec.mjs` — изолированные browser fixtures карты/списка и READY/UNAVAILABLE/ERROR. Рабочую БД, активный grocery и public/build эти проверки не меняют; рабочую активацию не подтверждают.

### Официальные остановки А8

[Контракт](data/transport-import.md#остановки-в-анализе-места-а8). `OfficialStopPoiTest` использует защищённую web_gis_test и откатывает транзакции, включает config-флаг только в тестах. Покрывает 200/1000, одноимённые разные ID, snapshot/source/coverage, честную неполноту негеокодированных записей и независимые отказы. Реальный CSV выбирается явно через `A8_OFFICIAL_STOPS_FILE`; `A8_OFFICIAL_STOPS_QA_DIR` пишет ответы/сверку только в новый каталог (fopen x; повторно не перезаписывать). `official-stops-real-response.test.mjs` с этим QA-каталогом проверяет настоящий TS runtime. `place-analysis-official-stops.spec.mjs` — browser fixtures карты/списка, источника/версии, нуля/PARTIAL/ошибки и других категорий. Существующие `OfficialStopsImportTest`/`TransportAnalysisTest` сохраняются; рабочая активация/API этими тестами не подтверждаются.

### Парки А8

[Проверки и эффекты](data/osm-parks.md#проверки-и-допуск): `ParkPoiTest` — web_gis_test, `A8_PARK_FILE` — реальный вход, `A8_PARK_QA_DIR` — только новый QA. ETL: `test_prepare_osm_parks.py`; runtime: `parks-real-response.test.mjs`; browser: `place-analysis-parks.spec.mjs`. Рабочая активация/public/build не меняются.


### Спутниковый HTTP и доставка А10.2

Fixtures (SQLite, временные каталоги; без рабочего импорта):

```bash
docker compose exec -T php php vendor/bin/phpunit tests/Feature/SatelliteProviderApiTest.php tests/Feature/SatelliteTileTest.php tests/Feature/PlaceAnalysisApiTest.php
# Python-зависимости/PYTHONPATH — как у подготовки satellite.
python3 -B tests/etl/test_prepare_satellite_delivery.py -v
```

Реальные PNG отдельно: `python3 -B tests/Satellite/check_delivery.py --delivery <delivery> --sha256 <delivery-pin> --index data/satellite/krasnoyarsk-2024-2026-city-v1.json --output <новый-файл.json>`. Проверяются все hashes/типы/alpha/палитра, независимые inverse-projected центры z13 и соответствие manifest даты; ETL/радиометрия заново не проверяются.

Реальный HTTP: `php tests/Satellite/check_http_satellite.php` в одноразовом `docker compose run --rm --no-deps -T ... php` с mounts `-v <runtime>:/satellite/runtime:ro -v <delivery>:/satellite/delivery:ro`; явно передать `APP_ENV=testing`, `APP_DEBUG=false`, `DB_CONNECTION=pgsql`, `DB_DATABASE=web_gis_test`, `DB_URL=`, `CACHE_STORE=array`, `SESSION_DRIVER=array`, четыре SATELLITE-переменные из [активации](data/satellite.md#доставка-и-активация-а102). Задать новые `SATELLITE_HTTP_REPORT` и `SATELLITE_HTTP_METRICS` в writable каталоге свидетельств. Harness проверяет существующие PostGIS guards/read-only mounts и запускает PHP HTTP server только на loopback:18765, затем останавливает его. Круги 200/1000 м, облака июня, край и отсутствие данных сверяются с reader, PNG запрашиваются по выданным URL. Отчёты содержат synthetic case labels, ресурсы и coverage, без личных координат/тел запросов. Метрики PHP/RSS/rchar тестовые; Nginx/FPM/UI не проверяются.

Reader А10.1 проверяется отдельно при изменении чтения; HTTP-задача не требует повторения всего набора:

```bash
php vendor/bin/phpunit tests/Unit/SatelliteCatalogReaderTest.php
python3 -B tests/etl/test_prepare_satellite_runtime.py RuntimeTest -v
# В php-контейнере, только существующие guards web_gis_test:
SATELLITE_RUNTIME_SHA256=<pin> php vendor/bin/phpunit -c phpunit.postgis.xml tests/Satellite/SatelliteCircleProjectionTest.php
# Python-зависимости А9, новый output; читает releases и пишет свидетельства:
python3 -B tests/Satellite/check_real_satellite.py --runtime <runtime> --sha256 <pin> --output <новый-каталог>
```
