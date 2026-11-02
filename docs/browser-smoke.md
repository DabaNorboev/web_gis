---
status: current
updated: 2026-11-01
verified: not verified
---

# Браузерный smoke PlaceLens

Одна команда: `npm run test:smoke`. Она запускает Playwright Test, собирает настоящий frontend во временный каталог, поднимает тестовый HTTP-сервер на `127.0.0.1:4173`, выполняет проверки и останавливает сервер. Занятый порт считается ошибкой: подключение к случайному уже работающему серверу запрещено.

## Подготовка чистого checkout

Нужны Docker/Compose и сеть для установки npm/Chromium/системных пакетов. Никакие данные, `.env`, Composer, PHP, PostGIS или OSRM для этого набора не нужны. Из корня проекта:

```bash
# Только Node, без routing override и без запуска БД.
docker compose -f docker-compose.yml up -d --build node
docker compose exec node npm ci
# Библиотеки Chromium внутри node:22-bookworm-slim; повторить после пересоздания контейнера.
docker compose exec --user root node npx playwright install-deps chromium
# Сам браузер устанавливается от пользователя node в его cache.
docker compose exec node npx playwright install chromium
docker compose exec node npm run test:smoke
```

Подготовка меняет node-контейнер, зависимости в node_modules volume и cache/системные библиотеки Chromium; это не read-only проверка. Она не должна заменять `.env`, ключи, геоданные и опубликованный `public/build`. Если Compose предупреждает о незаданных переменных БД в новом checkout, они не используются выбранным сервисом `node`. На Linux без Docker / в CI, с Node 22, эквивалентная подготовка: `npm ci`, `npx playwright install --with-deps chromium`, затем та же `npm run test:smoke`. Установка системных библиотек требует штатных прав администратора среды.

Повторение для проверки устойчивости:

```bash
docker compose exec node npm run test:smoke -- --repeat-each=2
```

Для целевой диагностики можно добавить `--project=phone-320`, `--grep="late profile"` или `--headed` (последнее требует доступного графического окружения). Обычные `npm test`, `npm run typecheck` и `npm run build` остаются отдельными проверками.

## Что проверяется

Текущий набор задают `tests/browser/*.spec.mjs` и `playwright.config.mjs`. Основная поведенческая матрица — четыре viewport: **320×740**, **390×844**, **1280×720**, **1280×560**, без автоматических retries. Сценарии точных размеров могут переопределять viewport. Три последовательных visual cases в home-map-overview, home-mobile-navigation и home-orientations запускаются только в short-desktop и каждый проверяет шесть размеров, включая 1440×900 и 390×480; их повторы в остальных трёх проектах пропускаются. Эти skips не считаются passed. Подробное покрытие новых матрицы, ориентиров и навигации — [testing](testing.md#frontend-и-browser). Число прогонов меняется вместе со specs; число из старого отчёта не является результатом сегодняшней проверки.

| Spec | Ответственность |
|---|---|
| `compare.spec.mjs` | Пара/радиус/замена, URL/history, две карты, явный выбор, zero/null и поздний профиль |
| `comparison-trips.spec.mjs` | Общие цели, ячейки А/Б, overlays, отказы/кандидаты, fragment/privacy, вкладки/фокус и поздние ответы |
| `trips.spec.mjs` | Самостоятельный сценарий, поиск/точки, диагностика, кандидаты, история, предупреждения и независимость результатов |
| `profile-controls.spec.mjs` | Размер карты, desktop-прокрутка/слои, колесо, клавиатура и сохранение состояния |
| `profile-sidebar.spec.mjs` | Обзор/данные, радиус/history, источники, пропуски/дальние объекты и мобильный переход |
| `point-address.spec.mjs` | Независимые транспорт/подпись, исходная точка, неоднозначность, POST/privacy и поздний ответ |
| `home-trips.spec.mjs` | Единая главная: адрес → А/Б → общие поездки обоих режимов → улица/повтор → замена; произвольный старт, кандидаты реального canvas, поздние ответы, раздельные fragment, обычная/личная ссылка, history/restore без лишних запросов, ранний focus/отмена и сохранение интерфейсов |
| `home-workspace.spec.mjs` | Главная нового интерфейса: адрес → профиль → А/Б, общий радиус, независимые стороны/ошибки, источники, pending/черновик при переключении, точка отдельно, поздний профиль и геометрия |
| `interface-switch.spec.mjs` | Два интерфейса, предпочтение/storage, поиск и анализ в процессе, единственные карта/подпись/форма, история, навигация шапки и новый HomePage |
| `map-visual.spec.mjs` | Темы, подписи адресов, геометрия, выбор и отказ подложки |
| `map-context.spec.mjs` | Связь карты/показателей, кадр адреса с объектом, возврат/фокус |
| `overview-topics.spec.mjs` | Общие темы обзора, storage, факты и явная неизвестность |

Настоящие геоданные/OSRM и опубликованный build этим стендом не проверяются. Общая карта тестовых уровней и побочных эффектов — [testing](testing.md).

Исторические перечни покрытия и дополнения Goal 2/R4 сохранены в [истории](history/ui-contract-notes-2026-11-01.md#browser-первоначальное-покрытие). Актуальный набор определяется файлами `tests/browser` и Playwright-конфигурацией, а не старым числом сценариев.

## Границы и изоляция

- `tests/browser/entry.mjs` импортирует существующие `resources/js/app.js` и `resources/css/app.css`; приложение само открывает `ComparePage.vue` по pathname. Сервер читает существующий Blade shell и заменяет только Laravel asset/font directives. Копии страницы или компонентов нет. Отсутствие ожидаемых директив останавливает подготовку.
- Vue/Tailwind/Vite и MapLibre настоящие. Сборка изолирована от обычного Vite config с Laravel/font-provider, от `public/build` и `public/hot`. Вместо сетевого стиля используется пустой локальный стиль с исходной атрибуцией, локальным пустым sprite и пустым GeoJSON-источником `/smoke-background.json`; последний позволяет проверить отказ реального запроса и повтор. Системный шрифт исключает зависимость от поставщика шрифтов. Сам test bundle не загружает внешние тайлы или glyphs.
- API поиска/профиля перехватываются fixtures из `tests/browser/fixtures.mjs`; сценарии подписи используют синтетические ответы адресного/транспортного API в `point-address.spec.mjs`. Адреса и метрики синтетические; прямоугольная геометрия — готовый тестовый ответ, не альтернативная реализация GIS. Все внешние запросы и неожиданные API/ошибки ресурсов приводят к падению. Тестовый сервер не проксирует запросы к приложению или БД.
- `map-observer.mjs` только регистрирует настоящие экземпляры MapLibre через вызовы `on`; события/источники/камера работают без подмены. Тесты читают `getZoom`, `getSource().getData`, `getLayoutProperty` через публичный API, а пользовательские действия выполняют в браузере.
- Набор проверяет frontend на контролируемых контрактах. Он не доказывает правильность API/GIS, реальной подложки, качество геоданных, поведение физического сенсорного телефона или озвучивание screen reader. Backend/PostGIS проверяются существующими отдельными командами; их конфигурация не изменена.

## Падения и CI

При падении сохраняются screenshot, trace с сетью/DOM и steps, HTML DOM, список API/неожиданных запросов и console/page errors:

- `test-results/compare-smoke/` — диагностические файлы;
- `playwright-report/index.html` — HTML-отчёт.

Оба каталога игнорируются Git. Открыть отчёт: `npx playwright show-report`; trace: `npx playwright show-trace <путь-к-trace.zip>` в среде с браузером/UI. Прямые пути к источникам и сообщения assertion остаются в терминальном логе. Успешные состояния карты с раскрытыми слоями также сохраняются в HTML-отчёте для просмотра.

Frontend job в `.github/workflows/tests.yml` после существующих тестов/типов/сборки устанавливает Chromium и запускает **тот же `npm run test:smoke`**. При неудаче оба каталога загружаются как `compare-smoke-diagnostics` на 7 дней. Job не использует БД или OSRM. Удалённый зелёный CI подтверждается только фактическим запуском Actions, не локальной проверкой workflow.

Используются штатные механизмы Playwright: [webServer](https://playwright.dev/docs/test-webserver), [mock API](https://playwright.dev/docs/mock), [CI и trace](https://playwright.dev/docs/ci-intro).
