# Проверки PlaceLens

Статус: текущая карта команд и их эффектов по конфигурации на 25.10.2026. Приведённые команды не означают, что они выполнены при обновлении документации.

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

В результате задания указывать: команду/область, фактический результат, окружение/фикстуры, пропуски и ограничения. Успех mocked browser не доказывает GIS/OSRM, исторический протокол — текущую публикацию, localhost — физический телефон или screen reader. Не сообщать «всё прошло», если выполнены только lint/ссылки.
