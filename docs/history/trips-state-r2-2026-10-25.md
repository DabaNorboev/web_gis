---
status: history
updated: 2026-10-27
verified: not verified
---

> Исторический материал: утверждения и результаты ниже относятся к исходному этапу. Это не текущая инструкция и не новый успешный запуск. Читать только по прямому указанию. Действующие документы выбираются через [индекс](../README.md).

# R2 — состояние самостоятельных поездок

Дата: 25.10.2026. Статус: перенос выполнен; перенос и все предусмотренные проверки завершены, localhost assets обновлены и проверены. Протокол реализации, не независимый финальный аудит. Следующий Goal не начат.

## Исходное состояние и сохранность

Ветка `feature/transport-stops-import`, HEAD `7e8a39a5d340efc6ffecfb291c020d2d23b856f5`. Индекс исходно пуст; многочисленные tracked/untracked изменения предшествуют R2. До редактирования сохранены точные копии TripsPage, useTripAnalysis, trips.test и затрагиваемых текущих документов, полная прежняя public/build, предыдущие browser reports, status с полным перечнем untracked, HEAD, staged/unstaged binary patches и перечни сценариев: `/tmp/placelens-r2-before/`. Это временный локальный архив, не постоянное хранилище.

Прочитаны README, PROJECT, архитектура, аудит структуры, протокол R1, текущий /trips, диагностика v1, privacy fixes и инструкции проверок/browser smoke. Данные, backend, Compose, зависимости и форматы API/fragment не менялись. Git reset/clean/stash/add/commit, импорты, миграции и остановка router не выполнялись.

## Ответственность до и после

| Область | До R2 | После R2 |
|---|---|---|
| Черновик/координаты/подтверждённые дорожные hints | TripsPage | useTripsState, единственный draft |
| Сохранение независимых строк, dirty/pending/failed, перенумерация diagnostics | Синхронный watcher и request continuation страницы | Тот же алгоритм внутри useTripsState; страница не пишет analysis и не имеет watcher инвалидации |
| Кандидаты, явный выбор, зависимые результаты | Страница | useTripsState; указатель/фокус меняют только выделение кандидата |
| HTTP, timeout, abort, защита записи response | useTripAnalysis | Без изменения; его refs возвращаются через useTripsState, копии analysis нет |
| Принятие кандидатов/hints после await | runSequence страницы | Тот же runSequence в useTripsState, дополнительно инвалидируется при unmount |
| URL/legacy parsing, popstate/hashchange, push/replace | Страница | Страница; composable получает parsed selection и эффекты сохранения |
| Режим выбора точки, фокус, DOM, прокрутка, пользовательское взаимодействие | Страница | Страница; заголовки/предупреждения вычисляются из refs composable |

Текущая основная карта ownership — [frontend-structure](../frontend-structure.md). Новых типов модели, общей системы URL, state manager и отдельных модулей helpers нет. Template и стили TripsPage побайтно сохранены.

`saveSelection(value, 'push' | 'replace')` оставляет сравнение текущего URL и restoredLocation странице. `restore(selection, invalid)` заменяет черновик, отменяет предыдущий запрос и перепроверяет восстановленные hints сервером. `beginRun(reveal)` позволяет странице захватить interactionEpoch/время и вернуть DOM-действие завершения. Переданный ему `isCurrent` повторно проверяется после nextTick перед прокруткой; медленный ответ или действия пользователя по-прежнему подавляют раскрытие.

Два прежних уровня защиты сохранены с разными обязанностями: sequence useTripAnalysis не даёт устаревшему fetch изменить analysis/status/error, даже если abort не остановил доставку; epoch useTripsState запрещает продолжение предметной операции после await (кандидаты, hints, failure bookkeeping, history и DOM callback). Они не имеют независимых копий результата и не принимают конкурирующих решений о его сохранении. watcher и road choice централизованы в одном composable. Таймаут транспорта не менялся.

## Проверки и эквивалентность

Общий loader R1 сохранён. useTripsState загружается как настоящий TS-модуль и в прямых тестах, и в page/SSR harness; заглушки нового composable нет. Пять прежних тестов переведены с bindings страницы на доступные state/actions composable:

| Прежнее имя теста | Проверяемое поведение / где теперь | Почему защита не слабее |
|---|---|---|
| hover and focus share a candidate identity without selecting it or making an extra request | candidateFocus/highlightedCandidate/selection, tripsHarness | Все прежние assertions, дополнительно настоящий useTripAnalysis с fake fetch |
| a saved road hint outside the current candidates does not appear selected in an ambiguous response | restore и candidateGroups composable | Сохранены selected=null и один запрос; настоящий транспорт |
| removing a middle target reindexes only retained results and candidates; adding leaves them visible | removePlace/addPlace, analysis/candidateGroups/dirtyIndices | Те же ссылки независимых строк, индексы, статус, ключ кандидатов и dirty assertions |
| the actual request state aborts after a coordinate edit and late answers cannot overwrite retained siblings | chooseRoad, правка draft, signal, analysis/hints/candidates | Настоящие оба composables; управляемая доставка вопреки abort, все assertions сохранены |
| Goal 6 removing earlier target reindexes retained structured diagnostics with its result | removePlace и исходная tripFailureMessage | Сохранены row.index, issues.target_index и правильная подпись действия |

Остальные исходные тесты не меняют behavioral assertions. Проверки URL/reload/history, SSR, сообщений, summary, отказов/повторов, keyboard/focus и шагов остаются на уровне страницы; dependency adapter теперь подключает настоящий модуль. Page harness получил effectScope и штатные unmount callbacks транспорта, вместо ручной маскировки cleanup вызовом clear перед hooks. Тесты pure state используют реальные Vue refs/watch, useTripsState и useTripAnalysis; подмена ограничена fetch, lifecycle hooks и записью history-effect. DOM/page tests явно подменяют DOM, карту/picker и в части случаев транспорт для старых синхронных fixtures. Browser smoke использует настоящий app и MapLibre с синтетическим API.

Добавлены только обнаруженные пробелы: семь управляемых поздних доставок после изменения цели/старта, удаления, reset, restore, нового road-запроса и unmount; плюс page unmount, удаляющий resize/popstate/hashchange и отменяющий подключённый настоящий транспорт. Проверяются не только analysis, но и статус/ошибка, hints, candidates, dirty/pending и отсутствие устаревшей записи ссылки. Новый запрос затем завершается своим ответом. При unmount возвращение старого результата проверяется после доставки уже отменённого ответа.

Сверка `/tmp/placelens-r2-before/scenario-audit.json`: ни одного исходного имени сценария не потеряно; все исходные строки `assert.*` сохранены после нормализации `h.page` → `h.trips`. Имена browser-сценариев и specs не менялись. Это дополнительная статическая сверка, не замена фактическим прогонам.

## Команды и результаты

Все Node-команды — существующий контейнер, `docker compose exec -T -u node node …`. Первый доступ к Docker был запрещён sandbox; повтор через штатное повышение доступа разрешён. Зависимости не устанавливались.

| Этап | Команда внутри node | Результат |
|---|---|---|
| До изменений | npm test | 155/155; skipped/cancelled/todo 0; 5385,45 мс |
| До изменений | npm run typecheck | exit 0 |
| Перенос/исправление template import | node --test tests/frontend/trips.test.mjs | Первый прогон 46/49: потерян sameRoadPoint import, используемый template; восстановлен, assertions не менялись |
| После переноса пяти проверок и late-response matrix | тот же целевой suite; npm run typecheck | 56/56; typecheck exit 0 |
| После lifecycle-стенда | тот же целевой suite | 57/57; пропусков нет |
| Итоговые исходники | npm test | 163/163; skipped/cancelled/todo 0; 5809,34 мс |
| Итоговые исходники | npm run typecheck | exit 0 |
| Production | vite build --configLoader native --outDir /tmp/placelens-r2-production/public/build | exit 0; 2006 modules; отдельная копия ресурсов/config/package.json и font cache, без .env |
| Полный browser smoke | npm run test:smoke | 164/164; 5,2 мин; exit 0; четыре viewport, один worker, retries 0, сценарии не сокращались |

Production build выполнен из `/tmp/placelens-r2-production` внутри node, зависимости доступны через symlinks, font cache скопирован в собственный каталог. Исходный public/build этим запуском не изменён. Сохранены предупреждения об optional fontaine и chunks >500 kB; зависимости и разбиение bundle в R2 не меняются. Скрипт подготовки и команда — `/tmp/placelens-r2-build.mjs`, лог `final-build.log` в исходном архиве. Полные логи baseline, целевых и финальных проверок — там же. Время npm test не является контролируемым benchmark.

## Публикация и ограничения

После успешных проверок опубликованы 8 новых assets. Старые файлы сохранены; manifest заменён атомарно после проверки неизменности исходного manifest и отсутствия коллизий. Исходный build дополнительно скопирован внутри node в `/tmp/placelens-r2-publication/build-before`, первоначальная host-копия — `/tmp/placelens-r2-before/public/build`. Сверка 196 прежних файлов: изменился только manifest, удалений/перезаписи старых assets нет.

Текущий manifest SHA-256: `4404acf67033332d274f2ad37d17813bd6dcefc3beb04162735bd46d59c8dbdd`; entry `assets/app-CC5InpEa.js`, страница `assets/TripsPage-DD5U3u3Z.js`. Скрипты публикации/проверки находятся в `/tmp/placelens-r2-publish.mjs` и `/tmp/placelens-r2-live.mjs` на host. Логи — `publication.log` и `published-check.log` в исходном архиве.

Опубликованный entry проверен настоящим Chromium через тот же Nginx (`http://nginx` внутри node): desktop 1280×720 и mobile 390×844. На публичных замороженных контролях выполнены успешный расчёт, переименование без дополнительного запроса, reload/back/forward, изменение одной цели с сохранением соседнего успеха, удаление и правка общего старта, явный дорожный выбор с повторным POST и сохранением исходных координат. На мобильном проверены настоящий успешный расчёт, изменение точки, добавление следующего места, фокус canvas/формы, reset и отсутствие горизонтального переполнения. API/карта в этой проверке не подменялись; page errors desktop отсутствуют. Это небольшая проверка существующих публичных контролей, не массовый acceptance-пересчёт. Скриншоты внутри node: `/tmp/placelens-r2-live/desktop.png`, `phone.png`; результаты — `published-check.log` на host.

Не проверяются физический телефон, screen reader, фактический доступ/обычное городское время, новые снимки GIS и произвольные маршруты. Backend/GIS suites не запускались: изменения ограничены frontend ownership. Технические отказы моделируются в изолированных тестах, рабочий router не останавливается.

## Изменённые файлы и независимый аудит

- resources/js/pages/TripsPage.vue — подключение владельца состояния, сохранение history/DOM интерфейса.
- resources/js/composables/useTripsState.ts — новый специализированный composable.
- tests/frontend/trips.test.mjs — настоящий module boundary, прямые проверки и дополнительные late/unmount regressions.
- docs/frontend-structure.md, docs/testing.md — актуальный ownership и граница проверок.
- Этот протокол; после публикации — manifest и новые assets public/build.

useTripAnalysis, ComparePage, useComparisonTrips, CityMap, browser specs/config, API/backend и модели не изменены. Независимому аудиту остаётся оценить достаточность интерфейса effects и оправданность сохранённых двух epochs. Широкий возвращаемый API соответствует нынешнему template; readonly-фасад, изменение модели целей и упрощение прежних алгоритмов намеренно не включены. DOM-логика и presentation ещё занимают заметную часть страницы; размер файла сам по себе не служит критерием успеха. Главная граница достигнута: код страницы больше не координирует инвалидацию результатов.

Завершающая сверка: HEAD, staged patch и весь посторонний tracked diff совпадают с исходными; useTripAnalysis не изменён. Из исходных статусных путей не исчез ни один, добавлены только новый composable и этот протокол. `git diff --check` и проверка trailing whitespace новых файлов прошли. Точный перечень изменённых R2-путей относительно исходного архива, сверка сценариев/assertions и данные публикации сохранены в `/tmp/placelens-r2-before/`.
