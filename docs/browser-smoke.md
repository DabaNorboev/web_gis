---
status: current
updated: 2026-11-22
verified: not verified
---

# Браузерный smoke PlaceLens

Браузерные проверки экрана анализа места на `/` с синтетическими ответами API.

Одна команда: `npm run test:smoke`. Она запускает Playwright Test, собирает настоящий frontend во временный каталог, поднимает тестовый HTTP-сервер на `127.0.0.1:4173`, выполняет проверки и останавливает сервер. Занятый порт считается ошибкой: подключение к случайному уже работающему серверу запрещено.

## Подготовка чистого checkout

Нужны Docker/Compose и сеть для установки npm/Chromium/системных пакетов. Никакие данные, `.env`, Composer, PHP, PostGIS или OSRM для этого набора не нужны. Из корня проекта:

```bash
# Только Node, без routing override и без запуска БД.
docker compose -f docker-compose.yml up -d --build node
docker compose exec --user node node npm ci
# Библиотеки Chromium внутри node:22-bookworm-slim; повторить после пересоздания контейнера.
docker compose exec --user root node npx playwright install-deps chromium
# Сам браузер устанавливается от пользователя node в его cache.
docker compose exec --user node node npx playwright install chromium
docker compose exec --user node node npm run test:smoke
```

Подготовка меняет node-контейнер, зависимости в node_modules volume и cache/системные библиотеки Chromium; это не read-only проверка. Она не должна заменять `.env`, ключи, геоданные и опубликованный `public/build`. Если Compose предупреждает о незаданных переменных БД в новом checkout, они не используются выбранным сервисом `node`. На Linux без Docker, с Node 22, эквивалентная подготовка: `npm ci`, `npx playwright install --with-deps chromium`, затем та же `npm run test:smoke`. Установка системных библиотек требует штатных прав администратора среды.

Повторение для проверки устойчивости:

```bash
docker compose exec --user node node npm run test:smoke -- --repeat-each=2
```

Для целевой диагностики можно добавить `--project=phone-320`, `--grep="late station response"` или `--headed` (последнее требует доступного графического окружения). Обычные `npm test`, `npm run typecheck` и `npm run build` остаются отдельными проверками.

## Что проверяется

Сценарии `tests/browser/place-analysis*.spec.mjs` покрывают поиск и выбор места, анализ адреса или точки, карту и слои, POI, спутниковые даты и историю станции. Проверяются поздние ответы и независимость результатов. Прежние URL проверяются как перенаправления на главную.

`playwright.config.mjs` задаёт четыре viewport: **320×740**, **390×844**, **1280×720**, **1280×560**. Сценарии могут задавать собственный размер. Автоматические retries отключены. Подробные критерии и отдельные проверки сервера и данных описаны в [testing](testing.md#frontend-и-browser).

## Границы и изоляция

- `tests/browser/entry.mjs` импортирует существующие `resources/js/app.js` и `resources/css/app.css`; Vue монтирует `PlaceAnalysisPage.vue`. Сервер читает существующий Blade shell и заменяет только Laravel asset/font directives. Копии страницы или компонентов нет. Отсутствие ожидаемых директив останавливает подготовку.
- Vue/Tailwind/Vite и MapLibre настоящие. Сборка изолирована от обычного Vite config с Laravel/font-provider, от `public/build` и `public/hot`. Вместо сетевого стиля используется пустой локальный стиль с исходной атрибуцией, локальным пустым sprite и пустым GeoJSON-источником `/smoke-background.json`; последний позволяет проверить отказ реального запроса и повтор. Системный шрифт исключает зависимость от поставщика шрифтов. Сам test bundle не загружает внешние тайлы или glyphs.
- Тесты перехватывают запросы API и возвращают синтетические ответы. Неожиданные API и внешние запросы приводят к падению. Тестовый сервер не проксирует запросы к приложению или БД.
- `map-observer.mjs` только регистрирует настоящие экземпляры MapLibre через вызовы `on`; события/источники/камера работают без подмены. Тесты читают `getZoom`, `getSource().getData`, `getLayoutProperty` через публичный API, а пользовательские действия выполняют в браузере.
- Набор проверяет frontend на контролируемых контрактах. Он не доказывает правильность API/GIS, реальной подложки, качество геоданных, поведение физического сенсорного телефона или озвучивание screen reader. Backend/PostGIS проверяются существующими отдельными командами; их конфигурация не изменена.

## Падения и CI

При падении сохраняются screenshot, trace с сетью/DOM и steps, HTML DOM, список API/неожиданных запросов и console/page errors:

- `test-results/compare-smoke/` — диагностические файлы;
- `playwright-report/index.html` — HTML-отчёт.

Оба каталога игнорируются Git. Открыть отчёт: `npx playwright show-report`; trace: `npx playwright show-trace <путь-к-trace.zip>` в среде с браузером/UI. Прямые пути к источникам и сообщения assertion остаются в терминальном логе. Успешные состояния карты с раскрытыми слоями также сохраняются в HTML-отчёте для просмотра.

Frontend job в `.github/workflows/tests.yml` выполняется в официальном `mcr.microsoft.com/playwright:v1.64.1-noble` (версия совпадает с `package-lock.json`), с Node 22 через setup-node, `npm ci`, проверкой типов, frontend-тестами и сборкой. Затем запускается **тот же полный `npm run test:smoke`** на четырёх viewport. Браузеры берутся из `/ms-playwright`; повторной установки браузеров или системных библиотек через APT нет. Контейнер использует штатного root для совместимости checkout/setup-node и записи в workspace, init и отдельный `/dev/shm` размером 1 GiB. Сервер и браузер работают в одном контейнере: loopback и временный каталог сборки сохраняются, диагностические пути остаются относительными к workspace. Workflow обрабатывает недоверенные PR через `pull_request` на одноразовом GitHub-hosted runner, с `contents: read`, без сохранения checkout credentials, передачи секретов или privileged-режима. Стандартные mounts job-контейнера (включая Docker socket) задаёт GitHub Actions runner; контейнер не служит границей изоляции от одноразового хоста. При неудаче оба каталога загружаются как `compare-smoke-diagnostics` на 7 дней. Job не использует БД или OSRM. Удалённый зелёный CI подтверждается только фактическим запуском Actions, не локальной проверкой workflow.

Используются штатные механизмы Playwright: [webServer](https://playwright.dev/docs/test-webserver), [mock API](https://playwright.dev/docs/mock), [CI и trace](https://playwright.dev/docs/ci-intro).
