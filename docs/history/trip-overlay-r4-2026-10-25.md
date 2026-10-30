---
status: history
updated: 2026-10-27
verified: not verified
---

> Исторический материал: утверждения и результаты ниже относятся к исходному этапу. Это не текущая инструкция и не новый успешный запуск. Читать только по прямому указанию. Действующие документы выбираются через [индекс](../README.md).

# R4 — маршрутный overlay отдельно от CityMap

Дата: 25.10.2026. Статус: реализация, обязательные проверки и публикация localhost завершены. Протокол реализации, не независимый финальный аудит.

## Исходное состояние

Ветка `feature/transport-stops-import`, HEAD `7e8a39a5d340efc6ffecfb291c020d2d23b856f5`. Индекс пуст по diff; многочисленные tracked/untracked изменения предшествовали R4. Исходные версии ресурсов, frontend/browser tests и документации, HEAD/status/branch/index, binary staged/unstaged patches и прежняя public/build сохранены в `/tmp/placelens-r4-before/`. Прежние browser outputs и исторические preview PNG также сохранены. Это временные локальные архивы. Git reset/clean/stash/add/commit не применялись.

Прочитаны README/PROJECT, аудит структуры, архитектура, R1–R3 и актуальные контракты карты, сравнения, личных поездок, /trips и проверок. До правок полный npm test: **173/173**, fail/skips/cancelled/todo 0; typecheck: **exit 0**. Логи — baseline-test.log и baseline-typecheck.log; имена сценариев сохранены отдельно.

## Ответственность до и после

| Область | До R4 | После R4 |
|---|---|---|
| Экземпляр MapLibre, initialize/remove, retry и тема | CityMap для общей карты; отдельный TripMap для /trips | Те же владельцы; второй instance для overlay не создаётся |
| Геометрия сравнения | CityMap вызывает tripMapData на points/analysis/groups | Существующий computed-adapter ComparePage вызывает тот же tripMapData и передаёт `{ data, sequence }` |
| Индексы/сторона/цель и подписи | Adapter перенумеровывает row; CityMap дописывает «Старт А/Б», «Цель» | Всё подготавливает adapter; CityMap не получает TripAnalysis, цели, groups или request-local indices |
| Маршрутные sources/layers | CityMap вызывает installTripLayers и добавляет candidate layers | tripOverlay вызывает единственный общий installTripLayers и добавляет только свои два candidate layers |
| Обновление/очистка overlay | updateTrip в CityMap | tripOverlay.update через getter текущего GeoJSON; null очищает source, результат в useComparisonTrips остаётся |
| Маркеры | GeoJSON-слои сравнения; DOM Marker-кандидаты самостоятельного TripMap | Так же; DOM-маркеры /trips не переносились |
| Клик по кандидату/ручной выбор | В общем click-обработчике CityMap | tripOverlay.click возвращает признак обработки; общий dispatch CityMap сохраняет приоритет перед остановкой/адресом/окружением |
| Серверная проверка дорожного выбора | ComparePage → setRoad/calculate нужной ячейки | Там же, без изменения транспорта/state |
| Камера | focusTrip/focusSelected/resetView и selectionSequence CityMap, sharedView страницы | Те же единственные владельцы; overlay возвращает только чистые bounds, не вызывает camera API |
| Cleanup | Общий map.remove | Сначала dispose собственных overlay layers/source, затем map.remove; устаревшие вызовы overlay ничего не делают |

Актуальная основная карта ownership — [frontend-structure](../frontend-structure.md). `tripMapData` сохранён побайтно; параметры/paint/filter прежних семи общих слоёв не менялись. installTripLayers стал идемпотентным и возвращает ID слоёв для cleanup. Самостоятельный TripMap и /trips не перерабатывались.

## Камера, актуальность и ресурсы

Явный показ по-прежнему вызывает focusTrip CityMap с двумя animation frames, прежними padding/maxZoom и ограничением масштаба соседней карты. Общие zoom/bearing/pitch не передают center. Overlay не подписывается на map events: CityMap передаёт style readiness и клики, поэтому нет второго механизма событий/камеры. До load обновления безопасны; первое install берёт текущие данные. На первом style.load установка ещё не выполняется, сохраняя прежний порядок слоёв над окружением. Повтор style.load после загрузки идемпотентно восстанавливает актуальный overlay без fitBounds.

Смена/скрытие данных отменяет ожидающую подгонку через существующий selectionSequence; initialize/unmount также инвалидируют её. Смена темы, меню, hover/focus и resize не создают команду. Возврат к окружению очищает display, не ячейку поездки; смена цели закрывает несовместимый соседний overlay прежним selectTripContext. R2/R3, useComparisonTrips/useTripsState/useComparisonLink, сетевые guards/epochs и форматы ссылок не менялись.

Adapter задаёт candidate.properties.id из стороны, стабильного ID цели, ключа конца и исходной геометрии. MapLibre может ещё возвращать rendered feature предыдущей цели, пока обрабатывается setData. Overlay принимает только ID, присутствующий в текущих подготовленных данных, и отдаёт исходные координаты этого кандидата: округление tile geometry не становится новым дорожным выбором. ID — внутренние display data, в API/ссылки/журналы не попадает. Нового хранилища актуальности или копии состояния поездок нет.

null, нулевые метрики и отсутствие принятой геометрии сохраняют смысл. Соединители остаются отдельными пунктирными features, без включения в метрики. Cleanup идемпотентен, удаляет свои девять layers и source trips; не затрагивает адреса/остановки/окружение/общую карту. Новая инициализация использует новый controller; disposed блокирует install/update/click после cleanup.

## Проверки и сохранение смысла

Общий loader R1 не менялся. Новый модуль загружается настоящим TS-кодом и напрямую, и через настоящий CityMap; подмена ограничена MapLibre/DOM и управляемой очередью кадров. Browser smoke продолжает исполнять настоящий app/Vue/MapLibre.

| Проверки | Изменение / сохранённая защита |
|---|---|
| address-comparison.test | Только точная runtime dependency tripMap в таблице; прежние имена и assertions сохранены |
| support/map-dependencies | Настоящий tripOverlay вместо прежнего tripMap на импортной границе CityMap; не имитация результата |
| trip-overlay.test, 7 новых сценариев | Установка до/после readiness, обновление/очистка/возврат, отсутствие дублей/подписок, cleanup/повторная инициализация, независимость карт и style reload; исходные точки/соединители/null/zero; кандидаты/ручной выбор/устаревший rendered ID/округление tile; настоящий CityMap и отмена fit при hide/reset/unmount |
| comparison-trips browser, прежние 9 сценариев | Сохранены без изменения: шесть результатов/индексы/подписи, А/Б и цели, инвалидация, скрытие вкладкой, ручной выбор, late responses, history, независимость результатов |
| Два новых browser-сценария × четыре viewport | Реальный canvas candidate click с одним запросом своей ячейки; настоящий отказ/повтор подложки при показанном маршруте, темы/resize сохраняют точные data/camera |
| Остальные frontend/browser | Главная, профиль, поиск/явный выбор, остановки/площади/линии и совместный кадр Goal 8, самостоятельный /trips сохранены |

Ни один прежний сценарий/assertion не удалён, viewport matrix и retries не менялись. В первом новом frontend harness исправлены сериализация Vue Proxy и порядок управляемых nextTick/RAF. В первом целевом browser-прогоне обнаружены неверные названия кнопок новых тестов («Контрастная» и «Показать маршрут» для неоднозначности); исправлены на существующие «Улицы» и «Варианты на карте». Assertions не ослаблялись. После этого целевой browser suite: **44/44**, все четыре viewport. Его лог target-smoke-2.log; промежуточные outputs сохранены отдельно. Начатый полный smoke остановлен при добавлении защиты актуального candidate ID; его неполный результат не считается финальным.

## Окончательные команды

Все Node-команды выполняются в существующем контейнере от пользователя node. Зависимости/Compose не менялись, router не останавливался.

| Команда | Результат |
|---|---|
| `docker compose exec -T --user node node node --test tests/frontend/trip-overlay.test.mjs tests/frontend/*layer*.test.mjs tests/frontend/map-*.test.mjs tests/frontend/address-comparison.test.mjs tests/frontend/trips.test.mjs tests/frontend/comparison-trips.test.mjs` | 111/111 (target-final.log) |
| `docker compose exec -T --user node node npm test` | 180/180, fail/skips/cancelled/todo 0 |
| `docker compose exec -T --user node node npm run typecheck` | exit 0 |
| Production build через `/tmp/placelens-r4-build.mjs` | exit 0, `/tmp/placelens-r4-final-production/public/build` |
| `docker compose exec -T --user node node npm run test:smoke` | 172/172, 5,5 мин, exit 0; четыре viewport, один worker, retries 0 |

Build копирует resources/config/package/public maps во временный каталог, использует установленные зависимости и отдельный font cache; не читает рабочий .env и не пишет public/build до публикации. Сохранены предупреждения о large chunk/optional fontaine; зависимости/bundle splitting вне задания. Логи и hashes окончательных исходников — `/tmp/placelens-r4-before/`.

## Публикация и ограничения

После полного успешного smoke опубликованы семь новых hashed assets; из 211 прежних файлов изменён только manifest, остальные 210 сохранены побайтно. Проверены коллизии имён и исходный manifest, новый manifest заменён атомарно. Резервная копия на host — `/tmp/placelens-r4-before/public-build.tar`, внутри node — `/tmp/placelens-r4-publication/build-before`. Скрипт — `/tmp/placelens-r4-publish.mjs`, логи/сверка — publication.log и publication-preservation.json.

Manifest SHA-256: `419ca7b4ede09e6d7ecd29e90978425273ec1399dc4c2cdbfc272edc78d80bf5`; entry `assets/app-CN_NDDYY.js`, ComparePage `assets/ComparePage-DO1HVdYr.js`. Все 91 ресурсных исходников production snapshot совпадают с окончательными source hashes. Прежние исторические preview PNG, которые smoke пишет в старые пути, восстановлены из точной копии; новые screenshots остаются attachments текущего browser report.

Опубликованный frontend проверен настоящим Chromium через тот же localhost Nginx (`http://nginx`) с настоящими API/GIS/OSRM и внешней подложкой на **1440×900, 1280×560, 390×844 и 320×740**. `/tmp/placelens-r4-live.mjs` использует одну замороженную публичную контрольную цель из experiments/routing-clicks/controls.json и два существующих публичных адресных объекта. Для каждого размера пройдены:

- Принятые маршруты А/Б к одной цели, точные подписи/исходные точки/два соединителя, общий zoom и независимые центры.
- Все три темы сохраняют данные и камеру без запросов; переходы между картой/результатами и мобильными сторонами сохраняют контекст.
- Ручной дорожный выбор А из фактического принятого snap не меняет исходную точку и Б; явный повтор отправляет только А и заново получает принятую поездку.
- Изменение цели на вторую публичную точку очищает обе линии/метрики без автоматического расчёта; возврат к окружению показывает настоящую ближайшую остановку Б.
- Тема, меню слоёв и выделенная остановка сохраняются; горизонтального переполнения нет.

Всего **12/12 HTTP 200**, page errors 0. Запросы выдерживают 2,2 с между отправками, без изменения тела/ответа. Отказы/задержки проверялись только изолированными fixtures; рабочий router не останавливался. Наблюдение MapLibre оборачивает публичный getLayer без изменения его результата, rendering, событий или данных; опубликованные JS не подменяются. Проверялся entry из текущего manifest. Логи, компактный JSON и восемь просмотренных PNG сохранены на host в `/tmp/placelens-r4-before/published/`, исходные screenshots также внутри node `/tmp/placelens-r4-live/`.

Финальная сверка: HEAD, raw index, staged patch и посторонний tracked diff совпадают с исходными. Все исходные файлы архивируемых каталогов сохранены; изменён только заявленный список. Template/style CityMap и ComparePage побайтно прежние; прежние browser-сценарии идентичны, address-comparison.test вне dependency table идентичен. Имена всех 173 исходных frontend-сценариев сохранены; добавлены семь. Source hashes совпадают с окончательным проверенным кодом. `git diff --check`, whitespace новых файлов и локальные ссылки документов проверены. Артефакты: preservation.json, frontend-scenario-preservation.json, source-hashes.json, r4.diff и publication-preservation.json в исходном архивном каталоге.

Backend/API/GIS suites, импорты/миграции/массовая маршрутизация, физический телефон и screen reader вне этой проверки. Изолированный smoke не доказывает доступность реальной дороги; настоящий localhost проверяется отдельно на ограниченной публичной выборке. Доступ/время/покрытие не получают новых обещаний.

## Файлы и вопросы независимому аудиту

Изменены CityMap.vue, ComparePage.vue, utils/tripMap.ts, frontend/address-comparison.test.mjs и support/map-dependencies.mjs, browser/comparison-trips.spec.mjs; добавлены utils/tripOverlay.ts и frontend/trip-overlay.test.mjs. Документация: frontend-structure, testing, browser-smoke, индекс и этот протокол. После публикации — manifest/новые hashed assets. Template/style страниц и компонента сохранены.

Проверить на независимом аудите: достаточность подготовленного candidate ID при смене цели/стороны до завершения обработки GeoJSON worker; отмену отложенного показа при обновлении display data; правильный порядок readiness на первом load и retry; допустимость небольшого изменения общего installTripLayers для идемпотентности. Overlay намеренно использует общий click-dispatch владельца, а не самостоятельные подписки; это сохраняет приоритет ручного выбора и исключает дублирование. Общая CityMap всё ещё содержит окружающую аналитику/камеру/адресные labels — R4 не разрешает последующие этапы их переработки.
