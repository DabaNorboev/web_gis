# R3 — личная ссылка сравнения и восстановление

Дата: 25.10.2026. Статус: реализация, проверки и публикация localhost завершены. Это протокол реализации, не независимый финальный аудит.

## Исходное состояние и сохранность

Ветка `feature/transport-stops-import`, HEAD `7e8a39a5d340efc6ffecfb291c020d2d23b856f5`; staged patch пустой. Многочисленные tracked/untracked изменения предшествуют R3. До правок сохранены точные исходники затрагиваемых каталогов и документов, полная прежняя public/build, HEAD, status с untracked, staged/unstaged binary patches в `/tmp/placelens-r3-before/`. Browser outputs и прежние preview PNG дополнительно сохранены в `browser-artifacts.tar` перед запуском smoke. Это временные локальные архивы. Git reset/clean/stash/add/commit не выполнялись.

Прочитаны README, PROJECT, архитектура, аудит структуры, R1/R2, текущие контракты сравнения/личных поездок/компоновки/приватности и инструкции проверок. Фактический алгоритм установлен по ComparePage, useAddressComparison, useComparisonTrips, comparisonTrips, ComparisonShare и существующим frontend/browser tests; исторические числа не используются как результаты R3.

## Ответственность до и после

| Область | До | После |
|---|---|---|
| Чтение query и адресные запросы | ComparePage → parseComparison/useAddressComparison | Прямое открытие по-прежнему parseComparison/useAddressComparison; browser history координирует useComparisonLink через restore |
| Fragment, нормализация и лимиты | ComparePage → parseComparisonTrips/comparisonTripsFragment | useComparisonLink → те же чистые функции без изменения формата |
| Запись query | Callback useAddressComparison на странице добавляет личный fragment | Тот же callback делегирует saveAddresses в useComparisonLink |
| Запись fragment, push/replace, browser events | ComparePage | useComparisonLink, единственный владелец синхронизации общей ссылки |
| Цели/стабильные ID/ячейки/hints/epochs/late response | useComparisonTrips | Без изменений, тот же модуль и публичный интерфейс |
| Ожидание текущих профилей и перепроверка восстановленных сторон | Watcher/Set страницы | Watcher/Set useComparisonLink, вызовы setStart/restore/calculate/reset |
| Обычная и личная ссылки | Computed страницы, ComparisonShare | Computed useComparisonLink, прежний ComparisonShare с предупреждением/clipboard fallback |
| Карта, вкладки, фокус/чтение, редакторы | ComparePage/useComparisonView | Там же; эффекты changed/restored/addressesRestored оставляют DOM на странице |

Composable не пишет внутренние ячейки trips, не копирует их и не меняет HTTP/API. useComparisonTrips и его интерфейс сохранены побайтно. Нет общего router/URL framework для /trips и /compare. Template и style ComparePage сохранены побайтно.

## История и актуальность

Адресный механизм query и его независимые fetch/abort guards сохранены. saveAddresses объединяет новый query с текущим сериализованным личным выбором; fragment watcher объединяет новый личный выбор с текущими адресами/радиусом. Переименование использует replaceState, изменение геометрии/дорожного выбора — pushState. Для сравнения геометрии используется существующая каноническая сериализация с пустыми подписями: эквивалентные пустые hints не создают историю. Сброс явно создаёт одну запись и запоминает пустое состояние, включая сброс до выполнения watcher.

Три значения имеют разные обязанности: locationKey объединяет search/hash для связанных событий; lastFragment хранит нормализованный прочитанный URL для отказа от повторного восстановления; lastSelection хранит сериализованное состояние после восстановления для подавления его очередного watcher. Последние два иногда различаются: замена адреса в истории очищает устаревший hint только своей стороны. Это остаётся восстановлением и не создаёт history. Более позднее пользовательское редактирование отличается от lastSelection и сохраняется обычным способом.

pendingSides содержит только стороны, которым после восстановления нужен расчёт. Сторона удаляется из очереди перед calculate; требуется совпадение текущих ID профиля/выбора/старта и готовая точка. Изменение только А оставляет Б; радиус сам не рассчитывает поездки. Смена геометрии очищает очередь. disposed закрывает последующие callbacks и history после unmount; оба обработчика устанавливаются один раз и удаляются. Отложенного nextTick, освобождающего флаг восстановления, больше нет. Epoch/abort guards поездок и профилей остаются в прежних владельцах.

Повреждённый fragment сохраняет адреса/радиус, предупреждение и отсутствие маршрутизации. Входные fragment не журналируются. Личные координаты/подписи остаются в hash; обычная ссылка их не содержит. Storage, серверное сохранение, внешние источники и зависимости не добавлены.

## Проверки и эквивалентность

Общий loader R1 не менялся. Новый useComparisonLink загружается настоящим TS-модулем и в прямых тестах, и в существующем page/SSR harness. В address-comparison.test изменена только таблица module dependencies; прежние assertions и имена сценариев сохранены. Новый отдельный стенд использует настоящие useAddressComparison/useComparisonTrips/useComparisonLink с управляемыми HTTP promises, Vue effectScope и browser history/events.

Десять новых прямых сценариев покрывают прямое открытие/reload и hints, push/replace, fragment/query и связанные events, radius/замену А и независимость Б, эквивалентные представления/пустые hints, невалидные координаты/подписи/дубликаты/размер/версию, delete/reset/восстановление road choice и поздние ответы, новое редактирование до flush/unmount, немедленный reset после восстановления, valid→invalid navigation и query history с очисткой только устаревших hints А без записи. Старые state-тесты продолжают проверять содержательные поздние успешные ответы/неполную форму/кандидатов. Page/SSR и browser сохраняют пользовательские действия, две ссылки/clipboard fallback, skip-link и регрессии главной, профиля и самостоятельного /trips.

Исходный запуск: `docker compose exec -T --user node node npm test` — 163/163, skips/cancelled/todo 0; `npm run typecheck` — exit 0. Перечень исходных сценариев извлечён из TAP в frontend-scenarios-before.txt. Первый доступ к Docker отказал sandbox; штатные команды затем выполнены с разрешённым доступом к Docker API, окружение не переустанавливалось.

Целевой перенос: address-comparison + comparison-trips — 23/23, typecheck exit 0. Прямые проверки нового composable — 10/10. Промежуточный smoke обнаружил valid→invalid регрессию watcher; исправлена в коде и сохранена отдельным прямым тестом, без ослабления browser assertion. В новом тестовом fixture невалидная долгота уточнена до 181: прежняя проверка координат допускает 0, её контракт не менялся.

## Завершающие проверки

Все Node-команды выполнялись штатным пользователем node в существующем node-контейнере, без установки зависимостей.

| Проверка окончательных исходников | Результат |
|---|---|
| `docker compose exec -T --user node node npm test` | **173/173**, fail/skips/cancelled/todo 0; 163 исходных + 10 новых сценариев |
| `docker compose exec -T --user node node npm run typecheck` | **exit 0** |
| Production Vite в `/tmp/placelens-r3-verified-production/public/build` | **exit 0**; конфигурация проекта, собственный font cache и временный outDir |
| `docker compose exec -T --user node node npm run test:smoke` | **164/164, 5,2 мин, exit 0**; четыре viewport, один worker, retries 0 |
| Сверка HEAD/индекса/постороннего tracked diff, assertions/сценариев и template/style | **Совпадают**; из исходного status не исчез ни один путь |
| `git diff --check`, локальные ссылки изменённых документов | **Успешно** |

Production-сборка использовала `/tmp/placelens-r3-verified-build.mjs` через stdin контейнерного Node: отдельная копия resources/vite config/package/public maps, symlinks установленных dependencies и собственная копия font cache, затем `vite build --configLoader native --outDir ...`. Исходный public/build до успешных проверок не менялся. Предупреждения об optional fontaine и chunk >500 kB сохранены; зависимости и разбиение bundle в R3 не меняются.

Логи baseline/target/final находятся в `/tmp/placelens-r3-before/`; полные browser artifacts — штатные playwright-report/test-results. Промежуточный красный smoke (160 passed / 4 одинаковых падения valid→invalid на разных viewport) отдельно сохранён как intermediate-smoke.log и intermediate-smoke-artifacts.tar. После исправления весь suite выполнен заново, без исключений. Исторические preview-results PNG, которые штатный smoke пишет по старым путям, возвращены из точных копий; новые attachments остаются в текущем browser report.

## Публикация

После полного успешного smoke добавлены 7 новых assets. Из 204 прежних файлов public/build изменён только manifest; 203 остальных сохранены побайтно. Manifest заменён атомарно после сверки исходного хеша и проверки коллизий имён. Резервные копии — `/tmp/placelens-r3-before/build` на host и `/tmp/placelens-r3-publication/build-before` внутри node.

Новый manifest SHA-256: `0be53b4f9f9680358b1c2cca637ffb001061307ee2e09ca03b5ccefd35932955`; entry `assets/app--qzakRYY.js`, ComparePage `assets/ComparePage-Cs6uBQaK.js`. Скрипт `/tmp/placelens-r3-publish.mjs`, лог publication.log и publication-preservation.json фиксируют публикацию/сохранность. verified-source-hashes.json связывает окончательные source-файлы с проверками; после build и проверок их хеши повторно сверены.

Опубликованный frontend проверен настоящим Chromium через тот же Nginx (`http://nginx`) на **1280×720 и 390×844**, с настоящими API/OSRM/GIS и подложкой. `/tmp/placelens-r3-live.mjs` использует только существующие замороженные публичные controls и явный поиск «Красноярск, Мира, 10». Пройдены цель/успешный расчёт двух сторон → переименование без запроса → изменение цели через поиск с очисткой двух результатов без автоматического расчёта → замена только А → назад/вперёд → reload → обе ссылки. Обычная ссылка открыта без целей; личная — с перепроверкой. Всего **16/16 HTTP 200**, page errors 0; горизонтального overflow нет. После изменения цели возможное реальное NEEDS_REFINEMENT не подменяется успехом.

HTTP-origin nginx не предоставляет Clipboard API: проверены действительный fallback и открытие обеих ссылок; native clipboard покрыт полным smoke на localhost. Настоящие запросы только выдерживают интервал 2,2 с и продолжаются без изменения тела/ответа, рабочий router не останавливается. Лог published-check.log содержит только результаты/статусы, без личных ссылок; снимки в `/tmp/placelens-r3-live/` внутри node, мобильный снимок скопирован в исходный архив и просмотрен.

Ограничения: mocked smoke не доказывает backend/GIS/OSRM; отдельная опубликованная проверка ограничена небольшой публичной выборкой. Backend/GIS suites, импорты, миграции, массовая маршрутизация, физический телефон и screen reader не запускались. Прежние модельные время/доступ/покрытие не получают новых обещаний. Независимый финальный аудит остаётся отдельным этапом.

## Файлы и независимый аудит

Изменены ComparePage.vue, tests/frontend/address-comparison.test.mjs, docs/address-comparison.md, docs/frontend-structure.md; добавлены useComparisonLink.ts, tests/frontend/comparison-link.test.mjs и этот протокол. После публикации — manifest и новые assets. Backend/API/GIS, CityMap/overlay, TripsPage/useTripsState, useComparisonTrips, форматы/лимиты, зависимости, Compose и viewport matrix вне изменений.

Для независимого аудита: проверить разделение URL/state signatures при очистке hints адресным restore; достаточность эффекта restored для представления; сохранение поведения при коротких последовательностях reset/restore/edit до flush. Ссылка сохраняет выбор, не результаты/кандидатов. Действия useComparisonTrips остаются широким публичным интерфейсом; readonly-фасад и переработка модели в R3 не вводятся.
