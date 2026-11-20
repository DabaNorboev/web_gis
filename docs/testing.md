---
status: current
updated: 2026-11-20
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
| Анализ места `/analysis` и демо `/analysis?demo=1` | `docker compose exec --user node node node --test tests/frontend/place-analysis-demo.test.mjs`; `docker compose exec --user node node npm run test:smoke -- tests/browser/place-analysis.spec.mjs`; `docker compose exec php php artisan test --filter=PlaceAnalysisPageTest` | Демо и API fixtures без рабочей БД/HTTP; `place-analysis-api.test.mjs` и `place-analysis-state.test.mjs` проверяют эхо, независимость, epochs/abort/timeout; browser `place-analysis-api.spec.mjs` — независимую доставку/ошибки/unavailable/контур и выбор объекта/станций; `place-analysis-point-address.test.mjs` — legacy resolver, browser `place-analysis-point-address.spec.mjs` — явный внешний reverse; `place-analysis-search-modes.spec.mjs` — локальный старт, переключение, общая карточка точки/локальный resolver и сохранность результатов; `place-analysis-address.spec.mjs` и `place-analysis-geocoding.spec.mjs` — preview/confirm/reconfirm, точность, сроки, клавиатура и отсутствие начальной метки; typecheck и сборка в отдельный каталог. Browser требует Chromium и проверяет экран, компоновку шапки и поиска, единые кнопки карточек/точки, сохранение настроек и порядка слоёв, связанный выбор POI списком/маркером, keyboard-only точку, тему подложки, сворачивание слоёв, радиус/неизвестный набор, станции, атрибуцию и адрес на четырёх viewport, не заменяя A6-приёмку |
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

### Изоляция спутникового ETL и загрузчик

Окружение и обёртка — в [основных инструкциях подготовки](data/satellite.md#окружение-и-запуск-подготовки). Целевой прогон **только fixtures**, без mounts experiments и data/reports, без исследовательского PYTHONPATH и внешней сети (локальный HTTP-сервер работает на loopback внутри контейнера):

```bash
docker run --rm --network=none --memory=1g --cpus=2 \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/scripts:/work/scripts:ro" \
  -v "$PWD/tests/etl:/work/tests/etl:ro" \
  -v "$PWD/config/satellite:/work/config/satellite:ro" \
  -e PYTHONPATH= -e PYTHONNOUSERSITE=1 -e OPENBLAS_NUM_THREADS=1 \
  web-gis-osm-etl:ci python -B -m unittest discover -s tests/etl -p '*satellite*.py' -v
```

`test_satellite_fetch.py` проверяет локальные GET/HEAD/Range, отказ полного fallback, budgets, неполный HTTP-ответ, запрет перезаписи, size/hash и источник повторно используемого raw, повтор acquisition без новых запросов. `test_satellite_city.py` отдельно проверяет pinned `reuse_inputs` source/size/hash. Журнал ошибок не содержит текста сетевого исключения. Остальные спутниковые fixtures проверяют численные значения, маски, подбор, review, индексы, runtime и доставку на синтетических данных. Отсутствие рабочих импортов из experiments проверяется адресно в `scripts/satellite_city.py`, `scripts/satellite_fetch.py` и `scripts/*satellite*.py`; исключение исторических `python-libs` из списка артефактов подбора остаётся допустимым.

Этот прогон не является реальным воспроизведением Sentinel-выпусков и не подтверждает радиометрию шести дат в новом окружении. Реальное воспроизведение требует сохранённых pinned входов и отдельного разрешённого запуска в новые outputs; существующие выпуски и индексы ради fixtures не пересоздаются.

### Городской спутниковый выпуск А9.5

В изолированном runtime [городского контракта](data/satellite.md#первый-городской-выпуск-а95-schema-3): `scripts/satellite-python tests/etl/test_satellite_city.py -v` (synthetic GeoTIFF/XML, временные каталоги) и после изменения dispatch индекса `scripts/satellite-python tests/etl/test_satellite_index.py -v` для прежнего формата. Проверяются инвариантность к размеру блока, нечётная привязка SCL, геометрический overlap без выбора по качеству, единое происхождение каналов, target вместо bbox, неизвестная кодировка/смешанный проход/изменённый вход, неполный manifest и круги. Работа с fixtures не подтверждает реальную радиометрию.

Реальный прогон — новый каталог, собственные JP2/XML каждого продукта и потоковая проверка записанного выпуска через `--stage review`. `/usr/bin/time -f 'elapsed_seconds=%e max_RSS_KiB=%M'` измеряет внешний wall/RSS, внутренние metrics — обработку и Linux `getrusage` после импорта. Круги, стык, облачные исключения и изображения проверяются отдельно. Никакая команда не запускает API/БД и не активирует набор. Успешные неизменённые старые выпуски повторно не готовятся.

А9.6 дополнительно: `scripts/satellite-python tests/etl/test_select_satellite_city.py -v` проверяет год/сезонные окна, tileInfo identity старых STAC и отказ частичных HTTP-входов; городской набор проверяет шесть явных manifest и pinned reuse source/size/hash. Сохранённые выпуски 2026 повторно не готовятся; для нового индекса проверяются их assets/hashes и совместимость.

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

`PlaceAnalysisPageTest` проверяет `/` и redirects старых страниц без query/session. `place-analysis.spec.mjs` проверяет единственный экран, отсутствие демо и сохранность browser records. Остальные `place-analysis-*.spec.mjs` проверяют независимость блоков, ошибки/поздние ответы, подтверждение адреса и явный reverse, круг, категории POI, счётчики, связанный выбор, слои, клавиатуру и desktop/mobile.

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
# Закреплённый ETL-образ — как у подготовки satellite.
scripts/satellite-python tests/etl/test_prepare_satellite_delivery.py -v
```

Для проверки контракта PHP и TS задать `SATELLITE_API_FIXTURES_FILE` с путём к новому файлу в доступном обоим тестовым контейнерам временном каталоге. `SatelliteProviderApiTest` сохраняет тела четырёх синтетических HTTP-ответов. `node --test tests/frontend/place-analysis-api.test.mjs` с тем же путём прогоняет их через клиентский валидатор и проверяет отказ при повреждённом URL тайла. `tests/browser/place-analysis-satellite.spec.mjs` проверяет состояния блока, доступность слоя и сохранение выбранного POI на offline-стенде.

Реальные PNG отдельно: `scripts/satellite-python tests/Satellite/check_delivery.py --delivery <delivery> --sha256 <delivery-pin> --index data/satellite/krasnoyarsk-2024-2026-city-v1.json --output <новый-файл.json>`. Проверяются все hashes/типы/alpha/палитра, независимые inverse-projected центры z13 и соответствие manifest даты; ETL/радиометрия заново не проверяются.

Реальный HTTP: `php tests/Satellite/check_http_satellite.php` в одноразовом `docker compose run --rm --no-deps -T ... php` с mounts `-v <runtime>:/satellite/runtime:ro -v <delivery>:/satellite/delivery:ro`; явно передать `APP_ENV=testing`, `APP_DEBUG=false`, `DB_CONNECTION=pgsql`, `DB_DATABASE=web_gis_test`, `DB_URL=`, `CACHE_STORE=array`, `SESSION_DRIVER=array`, четыре SATELLITE-переменные из [активации](data/satellite.md#доставка-и-активация-а102). Задать новые `SATELLITE_HTTP_REPORT` и `SATELLITE_HTTP_METRICS` в writable каталоге свидетельств. Harness проверяет существующие PostGIS guards/read-only mounts и запускает PHP HTTP server только на loopback:18765, затем останавливает его. Круги 200/1000 м, облака июня, край и отсутствие данных сверяются с reader, PNG запрашиваются по выданным URL. Отчёты содержат synthetic case labels, ресурсы и coverage, без личных координат/тел запросов. Метрики PHP/RSS/rchar тестовые; Nginx/FPM/UI не проверяются.

Reader А10.1 проверяется отдельно при изменении чтения; HTTP-задача не требует повторения всего набора:

```bash
php vendor/bin/phpunit tests/Unit/SatelliteCatalogReaderTest.php
scripts/satellite-python tests/etl/test_prepare_satellite_runtime.py RuntimeTest -v
# В php-контейнере, только существующие guards web_gis_test:
SATELLITE_RUNTIME_SHA256=<pin> php vendor/bin/phpunit -c phpunit.postgis.xml tests/Satellite/SatelliteCircleProjectionTest.php
# Python-зависимости А9, новый output; читает releases и пишет свидетельства:
scripts/satellite-python tests/Satellite/check_real_satellite.py --runtime <runtime> --sha256 <pin> --output <новый-каталог>
```

## Внешний поиск Г4

Frontend fixtures без ключей/сети/БД: `docker compose run --rm --no-deps --pull never --user node node npm run typecheck`; тем же способом `node --test tests/frontend/geocoding-api.test.mjs tests/frontend/geocoding-state.test.mjs tests/frontend/place-analysis-state.test.mjs` либо полный `npm test`. Проверяются echo/immutable snapshot, v2 wire без клиентских полей, очередь/ABA/abort/timeout, cooldown, поздний confirm, reconfirm и абсолютный expiry с готовым либо загружающимся блоком. Legacy v1 остаётся отдельной регрессией.

Browser: `npm run test:smoke -- tests/browser/place-analysis-geocoding.spec.mjs tests/browser/place-analysis-address.spec.mjs tests/browser/place-analysis-point-address.spec.mjs tests/browser/place-analysis-review-ui.spec.mjs --output=<новый-каталог>`. Выполнять от `node` с Node 22 и Chromium версии lockfile. `PLAYWRIGHT_HTML_OUTPUT_DIR` также направить в новый каталог, сохраняя прежние артефакты. Стенд собирает frontend во временный каталог, использует offline-подложку и синтетические POST/ответы, не читает рабочий `.env` и не меняет `public/build`. При отсутствии запущенного node-сервиса достаточно одноразового контейнера; браузерные библиотеки должны быть подготовлены заранее, без установки пакетов в этом прогоне.

Проверка 15.11.2026: полный frontend — 236 pass / 4 прежних skip; typecheck — pass. Полный browser smoke — 192 pass на четырёх viewport; после исправления pending-expiry отдельно 8 pass. После окончательных исправлений — typecheck, 15 целевых frontend и 68 browser pass. Подробности компоновки и жизненного цикла — в локальных свидетельствах `data/reports/geocoding-ui-g4-2026-11-15-01/verification.json`. Browser выполнялся в одноразовом network-none Playwright-контейнере с Node 22, без внешнего API/PHP/БД. Это не проверка Geoapify, его координат или рабочей активации Г5.

## Внешний поиск Г3

`GeocodingApiTest`, `GeocodingTokensTest` — SQLite/fixtures, без сети: строгие POST и request_id, приватные ошибки/debug/CORS, номер/уровень/территория, candidate/selection/reconfirm, фиксированные часы и предел 7 суток, ключи/previous_keys, три блока v2 и совместимость v1 (`PlaceAnalysisApiTest`). `GeocodingTransportTest` запускает отдельный PHP TLS-peer только на loopback с временным self-signed CA; PHP запускать с `-d curl.cainfo=/tmp/placelens-g3-ca.pem`. Проверяет сертификат, handshake 2 с, headers/body/чанки 8 с, redirect, gzip >1 MiB и остановку при отказе locks. Файлы сертификата/ключа — только `/tmp`, peer не журналирует запросы. Изолированный DNS-тест включается `G3_ISOLATED_DNS=1` исключительно в network-none контейнере с отдельным `/etc/resolv.conf` (`nameserver 127.0.0.1`, `options timeout:10 attempts:1`); хостовый DNS не менять. В неподдержанном runtime тест проверяет 503 до DNS/HTTP, в c-ares — реальный stall/deadline. Заявленный ASYNCHDNS без c-ares недостаточен: PHP 8.4.26/libcurl 7.88.1 дал около 10 с вместо 2/8 с на stalled DNS и теперь отвергается.

`GeocodingStateTest` — только `phpunit.postgis.xml`/существующие guards `web_gis_test`: новая уникальная схема и миграция up/down, encrypted cache/TTL/eviction, граница/отверстия, квоты/четыре slots/частота, отдельные PDO-сессии и конкурентные процессы PHP, смерть worker и разрыв HTTP-клиента. Все создаваемые схемы и процессы удаляет сам стенд; рабочие данные/volumes не используются. Запуск: `php vendor/bin/phpunit -c phpunit.postgis.xml --do-not-cache-result --no-logging --no-coverage --filter GeocodingStateTest` в подготовленном защищённом окружении. Тест client abort использует локальный PHP HTTP-server и незавершённый TLS-handshake, не Geoapify. TLS/Nginx не подтверждают рабочий FPM/browser. `tests/security/test_trip_nginx.py` дополнен четырьмя geocoding-путями: 8 KiB/8 KiB+1, Content-Length/chunked, безопасные ошибки, no-store/no-referrer и отсутствие ввода в logs/spool.

Для изолированных запусков использовать PHP-образ проекта с read-only checkout, writable `/tmp`, временными config/packages/services caches и пустым файлом поверх `.env`; synthetic APP_KEY/GEOAPIFY key, без файла реальных API-ключей. PostGIS можно запустить отдельно в tmpfs с `POSTGRES_DB=web_gis_test`, без рабочей сети/volumes; PHP присоединяется только к его network namespace. Эти тесты не выполняют реальную активацию, сборку frontend, импорт или запрос Geoapify.

Воспроизводимый opt-in runtime и отдельная рабочая активация — [runbook](runbook-local.md#php-runtime-с-c-ares). Проверка уже собранного образа:

```bash
python3 -B tests/environment/check_geocoding_runtime.py --image placelens-php:cares-g3-20261115-verified
```

Стенд требует локальных `postgis/postgis:16-3.4` и `nginx:1.27-alpine`, создаёт только собственные контейнеры без опубликованных портов в одном network-none namespace и удаляет их при завершении; PostgreSQL — tmpfs. Checkout read-only, `.env` закрыт пустым файлом, caches и сертификаты — `/tmp`. Логи, `curl_version()` PHP, список расширений, APK manifest и JUnit сохраняются в напечатанном новом `/tmp/placelens-g3-runtime-*`. CLI transport включает реальный DNS stall; callback отмены проверяется при чтении тела, поскольку частота progress callbacks во время TLS зависит от libcurl. Backend — Unit, `GeocodingApiTest`, `GeocodingTokensTest`, `PlaceAnalysisApiTest`; SQLite использует `:memory:`, PostGIS suite принудительно выбирает `web_gis_test` с существующими guards.

`GeocodingFpmRuntimeTest` включается только стендом (`G3_FPM_HTTP=1`): настоящий Nginx → FPM, отдельный синтетический endpoint вне routes приложения, DNS/TLS/body stall и разрыв HTTP-клиента. Проверяются время transfer и HTTP, завершение операции, две advisory locks во время stall, отказ повторного допуска того же клиента, отсутствие locks после transfer и повторное получение слота. FPM вызывает текущие `GeoapifyTransport`/`GeocodingState`, runtime guard сохранён. Для целевого повтора после исправления стенда есть `--checks cli backend state fpm` (указать только нужные группы). Это не проверка рабочего FPM, реального Geoapify или браузерного бюджета Г2.

Приёмка кандидата 2026-11-15 (`linux/amd64`, image ID — в [runbook](runbook-local.md#php-runtime-с-c-ares)): CLI — 5 tests / 67 assertions, backend — 106 / 856, state — 9 / 99, FPM — 1 / 59, без пропусков. CLI stalled DNS — 2,002 с, connect/TLS — 2,003 с; headers/body/медленные чанки — 8,001–8,002 с. Redirect/retry, TLS verify, gzip >1 MiB и отмена при потере locks прошли. FPM transfer / HTTP: DNS — 2,005 / 2,148 с, connect/TLS — 2,003 / 2,030 с, body — 8,004 / 8,021 с; после разрыва клиента DNS завершился за 2,002 с (наблюдение завершения — 2,040 с). Во всех FPM-случаях проверены удержание двух locks, отказ конкурентного допуска, освобождение и повторный допуск. Миллисекундные накладные расходы наблюдения не меняют настроенные 2000/8000 мс; это не жёсткая realtime-гарантия и не проверка UI-бюджета Г2.

Свидетельства этого запуска: `/tmp/placelens-g3-runtime-ibwsqpij` (временные локальные logs/JUnit/manifest, не переносимый артефакт репозитория). Набор PHP extensions совпал с исходным образом; `composer check-platform-reqs`, `php-fpm -t` и синтаксис штатного `start.sh` проверены также от `www` (UID/GID 1000). Root-стенд вывел Git dubious ownership при Composer, но platform check и тесты успешны; отдельный запуск от `www` прошёл без этого сообщения. Переход musl меняет дополнительные возможности libcurl (в частности, отсутствуют SSH/SFTP и GSSAPI/NTLM); приложение использует HTTPS, его целевые проверки прошли. Полный GIS suite, рабочие mounts/спутниковые данные и внешние сервисы этим прогоном не проверены. APK-пакеты требуют новой приёмки при пересборке, готовый образ сохраняется по ID.

Конфигурация Г3: `GEOCODING_ENABLED=false` по умолчанию, серверный `GEOAPIFY_API_KEY`, `GEOAPIFY_DAILY_LIMIT` ограничен сверху 2000; таблицы создаёт новая миграция `2026_11_15_000001_create_geocoding_state`. Стенд Г3 не применяет рабочую миграцию/Nginx; локальная активация описана ниже в Г5. Квота upstream распознаётся только по явному machine code `QUOTA_EXCEEDED`/`DAILY_QUOTA_EXCEEDED`, generic 403 отключает сеть; unknown reset даёт защитный cooldown 1 час без обещания восстановления. Эти ветви проверены синтетически. Рабочий прогон Г5 не проверял формат ответа при исчерпании квоты Geoapify.


## Локальная проверка Г5

2026-11-15: [локальная активация](runbook-local.md#локальное-геокодирование-г5) проверена через рабочие Nginx/FPM и Chromium 1.64.1, с manifest/build. Серверный счётчик — 8 внешних попыток Geoapify из разрешённых 20, включая незавершённое браузерное ожидание; cache HIT/confirm/анализ к этому числу не добавляются. Benchmark не повторялся, автоматических upstream-retries нет. Без traces, тел запросов, токенов, координат и URL поставщика в артефактах; внешняя подложка в браузерном стенде блокировалась, её доступность не проверена.

Проверены search → кандидаты → отдельный preview → confirm → v2, полный номер/серверная территория/неизмеренная точность/атрибуция; улица и неизвестный уровень не становятся домом. Точка анализируется по v1 без geocoding, reverse только явный и с точным echo, PostGIS geography ≤100 м, затем явный адресный confirm/v2. Смена адреса/точки/радиуса, быстрый ввод, задержанный реальный ответ после очистки; 1280×720/560, mobile 390×844 и 320×740, доступность подтверждения и отсутствие горизонтального overflow. Cache HIT сохраняет received_at. На рабочем API проверены POST-only, 422, 413, outside-scope без сети и no-store/no-referrer; синтетический marker, bearer-поля и apiKey URL отсутствуют в новых контейнерных logs.

POI и спутник вернули READY независимо от UNAVAILABLE воздуха; доступны шесть дат, смена даты сохраняет POI, реальные PNG — HTTP 200. Количества grocery/pharmacy/park/stops/imports неизменны, оба спутниковых pins совпали, mounts read-only; `.env` и `public/hot` побайтно сохранены. Измерение координатной точности, повтор радиометрии и восстановление полного дампа не выполнялись.

Приёмка обнаружила отсутствие reference_distance_m/100-м фильтра в backend reverse. Исправлены PostGIS-фильтрация до cache/token, версия ключа только reverse-кэша и исключение origin-distance из адресного токена. В изолированном network-none `web_gis_test` с synthetic keys/управляемыми часами: tokens/API — 9 tests, 199 assertions; state quota/cache/error/outside-scope — 4 tests, 52 assertions; после исправления — reverse/filter/cache/confirm 2 tests, 41 assertions и повтор затронутых tokens/API 9 tests, 199 assertions. Рабочие часы/квоты ради отказов не менялись. Прежние Г3/Г4 fixtures остаются отдельными свидетельствами, полный набор не повторялся.

Локальные безопасные свидетельства: `data/reports/geocoding-g5-2026-11-15-01/verification.json` и связанные safe summaries/logs. Сохраняются также неполные прогоны: исправлены допущения стенда о числе options, обязательном Accept, loopback secure context и времени ожидания. Для Карла Маркса, 93 Geoapify дал неизвестный уровень, поэтому подтверждение дома ожидаемо запрещено; Мира, 106 и Ленина, 127 дали подтверждаемые дома. Малый набор не доказывает покрытие города; владельческая приёмка Г5/А13/ядра остаётся открытой.


## План проверок Г6

**План, не результаты запуска.** [Требования](features/address-search.md#план-два-режима-поиска-г6), [точка/адрес](features/point-address.md#план-единая-карточка-точки-г6), последовательность и сетевые границы — [roadmap](plans/roadmap.md#г6-два-режима-поиска-и-выбор-точки).

- Диагностика на малом наборе публичных адресов: различать raw-выдачу, нормализацию/территориальный фильтр и отображение; измерять debounce/очередь, внешний HTTP, серверную обработку и отображение, отдельно подтверждение и анализ. Измерения не пишут ключи, bearer, личные координаты или тела запросов в журналы. Сохранённые ответы и cache HIT не считать новыми внешними измерениями.
- Локальный поиск: нормализация, полный номер/корпус, группы с несколькими OSM-объектами и явный выбор. Компактная подпись не теряет номер, не выдумывает район и не меняет идентичность; ограничения результата по-прежнему влияют на доступные действия.
- Переключение режимов: локальный старт, отсутствие внешнего запроса от самой кнопки, сохранение текста/подтверждённого места/готовой аналитики. Search/reverse/confirm, отмена, А→Б→А и поздний finally не восстанавливают черновик другого режима. Сроки/reconfirm внешнего выбора действуют и при открытом локальном поиске.
- Одна карточка точки в обоих режимах: локальный resolve-point без внешней сети, анализ исходной точки, выбор адресного объекта через resolver/v1. Проверить неоднозначность, пустоту, сбой, отмену и поздний ответ; внешний reverse только явно. Не повторять пространственный стенд, если прежний GIS-контракт не меняется; при изменении GIS — только защищённый web_gis_test.
- Typecheck и затронутые frontend/browser: адресные подписи, keyboard/focus, 320/390 px и короткий экран, компактная справка/атрибуция, независимые блоки. Сборка для проверок — временная; рабочую public/build сохранять до отдельной локальной активации.
- Финальная рабочая проверка обоих режимов через Nginx/FPM/browser и владельческая приёмка отделяются от fixtures и диагностики provider. Успешные проверки того же diff не повторять без нового изменения/сбоя/риска. После правок docs — scripts/check-docs и git diff --check.


### Проверка реализации Г6.2 на fixtures — 20.11.2026

Typecheck успешен. Целевые frontend-наборы поиска, geocoding API/state, point resolver и analysis state: 26 различных тестов успешны (исходный набор 22 и четыре добавленные регрессии режима). Browser-наборы address/geocoding/point-address/review-ui/search-modes: 128 успешных проверок на четырёх viewport; после добавления отмены локального resolver при постановке точки и дополнительных регрессий финальный `place-analysis-search-modes.spec.mjs` — 76 успешных проверок. Проверены локальный старт, сохранение текста/выбора/готовых блоков, ABA search/reverse/confirm и локального search/resolver, expiry/reconfirm в локальном режиме, исходные координаты точки, явные OSM-объекты и неоднозначные группы, пустой/ошибочный ориентир.

Browser использовал имеющийся Playwright v1.64.1 образ с добавленным пользователем node, временные build и отчёты в `/tmp`; первый запуск в обычном node-образе не стартовал из-за отсутствия Chromium. Установка пакетов и внешние запросы не выполнялись. API/GIS/backend не изменены; PostGIS, рабочие Nginx/FPM, доступность Geoapify и владельческая приёмка этим прогоном не проверены. Рабочие assets/config сохранены; компактные подписи и рабочая активация остаются следующим этапом.

### Проверка Г6.3 на fixtures — 20.11.2026

Прошли typecheck, 30 разных frontend-тестов, 34 целевых backend-теста и 160 разных browser-проверок. Первый browser-прогон выявил два устаревших ожидания в тестах: число объектов в группе и текст ошибки подтверждения. После исправлений прошли целевые повторы на четырёх viewport. Клавиатурные сценарии обоих режимов дополнительно проверены при 320×568 и 390×640. Проверены полный номер с дробью, литерой, корпусом и строением, отсутствующие поля, раздельный выбор одинаковых подписей, справка о точности и недоступное подтверждение улицы.

Backend-проверки покрыли поля поиска, resolver и ориентира OSM, новый и старый кэш Geoapify, подтверждение, неизменность при переподтверждении и запас размера токена. Использовались отдельная `web_gis_test` на tmpfs, синтетические ответы поставщика и временная сборка браузерного стенда.

После исправления Enter прошли typecheck на Node 22 и 160 браузерных проверок на четырёх размерах экрана. Обе новые регрессии выявляли оставшийся `aria-activedescendant` до исправления. После исправления проверены один явный поиск по сохранённому тексту после смены режима или отмены предпросмотра, а также открытие предпросмотра актуальной подсказки.

### Рабочая проверка Г6.4 — 20.11.2026

Проверены новый manifest/build, запуск обычным Compose, Nginx/FPM с c-ares и оба спутниковых pin. В Chromium локальный поиск был стартовым. OSM-выбор, анализ точки и явный выбор локального адреса из карточки в обоих режимах дали готовые POI через v1. Для 06.06 и 09.09.2026 получены реальные PNG и готовые спутниковые наблюдения. Смена даты сохранила готовые POI. Внешняя подложка в контрольном браузере была заблокирована.

На одном публичном адресе проверены отсутствие запроса от переключения, повторный поиск Enter после возврата в Geoapify и отмены предпросмотра, отдельное подтверждение и готовый анализ v2. Из 7 lookup POST четыре получили cache HIT. Сервер учёл 3 из 8 разрешённых внешних попыток, включая первый `504 PROVIDER_TIMEOUT`. Повторный автокомплит прошёл.

Время от действия до подсказки в этом прогоне составило 427 мс для локального ввода, 3,52 с для Geoapify-автокомплита при MISS, 2,69 с для явного поиска при MISS и 99–111 мс при HIT. От подтверждения до готового POI прошло 196–211 мс. Первичный тайм-аут вернулся за 2,08 с от начала HTTP-запроса. Это наблюдения браузера и рабочего HTTP для одного адреса. Отдельные фазы DNS/внешнего HTTP/нормализации и полнота покрытия не измерялись.

Сведения о запуске, возврате сборки и сценарий ручной приёмки — в [runbook](runbook-local.md#локальная-активация-г64). Владельческая приёмка остаётся открытой.

### Проверка спутникового контракта — 20.11.2026

До исправления клиент отклонял `ERROR / SATELLITE_READ_FAILED` и выбранную дату `NO_USABLE_NDVI` с готовыми тайлами. После исправления проверены четыре ответа PHP через TS-валидатор, отказ на повреждённом URL тайла и сохранение выбранного POI при смене состояния спутника. Прошли SatelliteProviderApiTest (5 тестов, 66 assertions), frontend place-analysis-api (11 тестов), спутниковые browser-проверки (32 на четырёх размерах экрана) и typecheck.

Отдельная локальная активация проверена через Nginx/FPM и Chromium: локальный поиск, анализ точки, реальные PNG TCI и NDVI для обеих дат 2026 года и сохранение POI при смене даты. Ошибочные состояния проверены на fixtures. Внешняя подложка на стенде была заблокирована. Владелец принял спутниковую правку 20.11.2026. Приёмка Г6 и А13 отслеживается отдельно в [roadmap](plans/roadmap.md#ближайшая-очередь).
