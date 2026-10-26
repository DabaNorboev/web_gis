# Проверки PlaceLens

Статус: текущая карта команд и их эффектов; точечные команды сверены с конфигурацией 27.10.2026. Приведённые команды не означают, что они выполнены при обновлении документации.

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
API в изолированном окружении; выполненный протокол — [walking-backend](walking-backend.md).

Пеший UI дополнительно проверяется `walking-contract.test.mjs`, регрессиями
состояния в `trips.test.mjs`/`comparison-trips.test.mjs`/`comparison-link.test.mjs`
и `tests/browser/walking-trips.spec.mjs` на четырёх viewport. Эти проверки
исполняют настоящий frontend с синтетическими ответами API; работа ORS и
реальный доступ к объекту ими не подтверждаются. Production build можно
направить в новый каталог через `npm run build -- --outDir <новый-каталог>`,
сохраняя опубликованный `public/build`.

Количество тестов не является основанием удаления. Разные уровни ловят разные ошибки. Повторы loader-инфраструктуры можно сокращать, сохраняя поведение; стоимость viewport-матрицы менять после проверки покрытия сценариев и времени выполнения.

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
| `PYTHONDONTWRITEBYTECODE=1 python3 tests/security/test_trip_nginx.py` | Nginx synthetic privacy | Использует уже работающий nginx-контейнер, запускает отдельный процесс/порт и временные файлы; живой Nginx не перезагружает |

`composer setup`, install/update, миграции, импорты и acceptance-скрипты не входят в безопасный универсальный «запустить всё». Изучать их отдельные эффекты перед использованием.

### Точечный старт проверки

Примеры для уже подготовленного окружения; выбирать по изменённому поведению и дополнять уровнями из таблицы выше. Это не замена обязательным CI-наборам. Node-команды явно задают пользователя `node`.

| Изменение | Начальная команда | Эффекты и когда расширять |
|---|---|---|
| Представление адресного поиска | `docker compose exec --user node node node --test tests/frontend/address-search-presentation.test.mjs` | Без backend/БД; добавить typecheck для TS, browser-сценарий при изменении подключения/взаимодействия |
| Состояние самостоятельных поездок | `docker compose exec --user node node node --test tests/frontend/trips.test.mjs tests/frontend/walking-contract.test.mjs` | Без backend/БД; добавить typecheck и browser для URL/history, фокуса или подключения к странице; при общей логике — регрессии сравнения/ссылки |
| Пеший UI | `docker compose exec --user node node npm run test:smoke -- tests/browser/walking-trips.spec.mjs` | Временная сборка и browser-отчёты, все четыре viewport; API синтетический. Дополнить frontend/typecheck по таблице выше; ORS/доступ этим не проверяются |
| Пеший API | `docker compose exec php composer test -- --filter=WalkingTripAnalysisTest` | Очищает config cache, синтетические snapshot/HTTP и временные файлы; добавить затронутые unit/privacy и GIS-проверки при изменении соответствующих границ |
| Автомобильный geometry guard | `docker compose exec php composer test:postgis -- --testsuite=PostGISReadOnly --filter=RoutingGeometryGuardTest` | Очищает config cache, только защищённая `web_gis_test`; не проверяет импорты/запись или пеший guard. При их изменении выбрать соответствующие наборы |

Файлы и фильтры — примеры выбора, не постоянный минимум для любой задачи. Полный прогон нужен при изменении общих зависимостей/стенда или риске за пределами выбранного набора. Для правки только документации достаточно проверок первой строки основной таблицы.

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

`npm test` исполняет настоящие исходные TS-модули/composables и SFC через тестовые loaders, подменяя явно выбранные зависимости. `tests/frontend/support/vue-component.mjs` — единственное место преобразования модулей: TypeScript CommonJS transform и Vue SFC compiler. `loadModule` читает TS, `loadComponent` компилирует SSR или client render/setup, `loadSetup` открывает явно перечисленные bindings двух страниц для существующих state-тестов. Импорты передаются по точным спецификаторам; неизвестный модуль и отсутствующий именованный экспорт приводят к ошибке. Тесты самостоятельных поездок исполняют настоящий `useTripsState` через `loadModule`: доменные сценарии обращаются к его API, а проверки страницы/SSR сохраняют настоящую связь с composable; транспорт/API и DOM подменяются явно. Browser globals передаются отдельно и не записываются в `globalThis`; общего кэша вычисленных модулей нет. Карты используют явную таблицу зависимостей CityMap, CSS обозначен отдельной зависимостью без Node runtime. `trip-overlay.test.mjs` исполняет настоящий tripOverlay и настоящий CityMap через тот же loader; управляются только MapLibre/DOM/очередь кадров. Проверяются повторная установка/очистка собственных слоёв, актуальный ID кандидата и исходные координаты, независимость сторон и отмена отложенной камеры. Регрессии loader — `vue-component-loader.test.mjs`; [протокол переноса R1](frontend-loader-r1-2026-10-25.md). Отдельные SSR-проверки всё ещё используют старую MetricCard; [аудит](structure-quality-audit-2026-10-25.md) предлагает перенос регрессий, а не простое удаление теста.

`playwright.config.mjs` задаёт четыре viewport и один worker. `tests/browser/server.mjs` собирает настоящий app во временный каталог, не читает `.env`, не пишет опубликованные assets и не проксирует к backend. API fixtures синтетические, MapLibre/DOM настоящие. Итоги Playwright в рабочем дереве — отдельный побочный эффект.

Сценарии охватывают главную, профиль, сравнение, личные поездки, тему/слои, выбор объекта, поздние ответы, историю, фокус и отказ подложки. Нельзя считать количество тестов из старого отчёта актуальным результатом. Подготовка Chromium, изоляция, наборы и ограничения — [browser-smoke](browser-smoke.md).

## ETL и Nginx

Для уже подготовленного локального ETL image:

```bash
docker run --rm --network=none --memory=1g --cpus=2 \
  --user "$(id -u):$(id -g)" -v "$PWD:/work:ro" \
  web-gis-osm-etl:local python -m unittest discover -s tests/etl -v
```

Это маленькие PBF-fixtures; создание/сборка image — отдельная операция. CI собирает image с тегом `web-gis-osm-etl:ci` и запускает ту же fixture suite. Постоянный ETL Compose-сервис не нужен.

Nginx privacy проверяет production config отдельным synthetic canary: безопасный access format, no-referrer, ошибки upstream/размер тела, отсутствие записи тела на диск. Не читает живые журналы. Сейчас этот тест запускается отдельно и **не включён в CI**; расширение CI предложено в аудите, но этой документационной правкой не реализовано.

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

В результате задания указывать: команду/область, фактический результат, окружение/фикстуры, пропуски и ограничения. Успех mocked browser не доказывает GIS/OSRM, исторический протокол — текущую публикацию, localhost — физический телефон или screen reader. Не сообщать «всё прошло», если выполнены только lint/ссылки.
