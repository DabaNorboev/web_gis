---
status: current
updated: 2026-11-11
verified: code
---

# Анализ одного места: целевой контракт API

API А7 реализован: POST `/api/v1/place-analysis`, явный адрес/точка, 200–1000 м, эхо и серверный круг; блоки независимы. POI: [grocery](../data/osm-grocery.md), [аптеки](../data/osm-pharmacy.md) и [официальные остановки](../data/transport-import.md#остановки-в-анализе-места-а8), [парки](../data/osm-parks.md). Спутниковый provider реализован и [локально активирован](../runbook-local.md#локальные-спутники-рабочая-активация). Воздух пока недоступен (А11–А12). Без доступных POI — `UNAVAILABLE / POI_SNAPSHOTS_UNAVAILABLE`, ошибки не подменяются нулём.

Экран — `/`; прежние UI URL перенаправляются на него. Демо удалено; недоступные блоки без синтетических данных. Хранение/обмен/reload остаются открытым решением владельца. Прежние profile (300/500 м) и transport API сохранены.

## 1. Решение о совместимости

Выбран новый вход `POST /api/v1/place-analysis`, а не расширение адресного профиля:

- профиль закреплён за конкретным адресным ID и радиусами 300/500 м, содержит шесть других блоков и сохраняется как совместимый API;
- свободная точка не должна получать выдуманный адресный ID, а профиль без адреса невозможен;
- новый вход принимает адрес или точку, 200–1000 м, дату и отдельный выбор станций, не ослабляя старые контракты;
- координаты и списки передаются в JSON-теле, а не в query; ответы не кэшируются.

Resolver, coverage и серверный круг переиспользуются. POI, спутниковые runtime и raster-доставка реализованы (§5–6); нужны локальные данные. Provider воздуха — задача А11–А12; пока `UNAVAILABLE`.

## 2. Вход

`POST /api/v1/place-analysis`, `Content-Type: application/json`, `Accept: application/json`.

```json
{"place":{"kind":"point","lon":92.9,"lat":56.0},"radius_m":500,"date":"2026-08-12","stations":{"selected_ids":["synthetic-station-1"],"radius_m":5000},"blocks":["poi","satellite","air"]}
```

| Поле | Правило |
|---|---|
| `place.kind` | Обязательно `address` или `point`. Ровно один способ выбора; смешение полей — 422. |
| `place.address_id` | Только для `address`: точный `osm:node:…`, `osm:way:…` или `osm:relation:…` из активного снимка. `address:<hash>` и выдуманный ID не принимаются. Некорректный/исчезнувший ID — 404 `ADDRESS_NOT_FOUND`; недоступный набор — 503 `ADDRESS_SOURCE_UNAVAILABLE`. |
| `place.lon`, `place.lat` | Только для `point`: оба конечных числа; lon ∈ [−180, 180], lat ∈ [−90, 90]. Точка не получает адресный ID, подпись или ID группы. |
| `radius_m` | Необязательное целое 200–1000 включительно, по умолчанию 500. Дробное, `null`, строка и значения вне диапазона — 422. Шаг UI определяет А6; API принимает любое целое в диапазоне. |
| `date` | Необязательная календарная дата `YYYY-MM-DD`. Формат — 422; доступность — предметное состояние блока. Без даты возвращается каталог подготовленных дат без выбранного слоя. |
| `stations.selected_ids` | Необязательный список до 20 уникальных строк 1–64 символа. Неизвестный по формату ID не ломает анализ и попадает в `missing_selected_ids`. |
| `stations.radius_m` | Необязательное целое 1000–20000, по умолчанию 5000. Отдельная область выбора станций; не ограничена `radius_m` места и не расширяет круг анализа. |
| `blocks` | Необязательный уникальный непустой список `poi`, `satellite`, `air`; по умолчанию все. Не реализованный блок — `UNAVAILABLE` с причиной; незапрошенный отсутствует. |

Некорректный ввод — HTTP 422 без частичного анализа. Лимит — 60 запросов/мин на IP, включая отдельные запросы блоков; 429 содержит `Retry-After`, автоматического повтора нет.

### 2.1. Приватность нового POST

- Клиент: фиксированный POST JSON, `cache: no-store`/`referrerPolicy: no-referrer`; ввод из query не принимается, API stateless. В журналах/ошибках нет тела, координат, адресных/станционных ID.
- Middleware до FormRequest/сервиса: фактическое тело ≤8 KiB, не только Content-Length; иначе 413, не-JSON — 415. Валидация/разбор JSON не возвращают ввод; throttle хранит только счётчики.
- Laravel `report`: новый путь, включая ошибки до/после контроллера; фиксированное сообщение, тип исключения и известный ключ блока. Без exception message/object, stack arguments, SQL/bindings, URL/тела; то же для блочных catch.
- `render`: предметные 4xx сохраняются, неожиданный отказ — безопасный 503 `SERVICE_UNAVAILABLE`, включая debug. `respond`: `Cache-Control: no-store` и `Referrer-Policy: no-referrer` на всех ответах пути, включая 404/405/413/415/422/429/5xx.
- Nginx: отдельный location, `client_max_body_size 8k`, `client_body_buffer_size 16k`, без spool принятых тел. Сохранить `zend.exception_ignore_args=1`, safe access log с фиксированным классом `place_analysis` вместо URI/query/Referer/body и отключённый request error log. Оба заголовка — `always`, без дублей upstream; 413/502/504 безопасны до Laravel, в том числе без Content-Length.

Серверные защиты реализованы в Laravel/Nginx; файлы и регрессии — §11. Ответы Nginx до PHP сохраняют HTTP 413/502/504 с фиксированным JSON-кодом; Laravel отдаёт безопасный 503 при неожиданном отказе. Изменённый Nginx config требует штатного применения в целевом окружении; этот срез не перезапускает рабочий Nginx.

## 3. Общий ответ

| Поле | Значение |
|---|---|
| `analysis_version` | `1`. Не меняет `profile_version` адресного профиля. |
| `place.kind` | `address` или `point`. Для адреса заполнены `label` и `address`; для точки `label: null`, `address: null`, координаты — ровно введённые. Приблизительная подпись UI не является идентичностью. |
| `place.address` | Адресная часть resolver: `id`, `label`, `object` (`id`, `lon`, `lat`, `geometry`, `point_method`, `object_type`, `levels`), `bounds`, `source`, `dataset_import_id`, `observed_at`, `source_updated_at`, `reason`. Точка контура не вход. |
| `place.point` | Точка анализа: для адреса — `object.lon/lat`, для точки — ввод. EPSG:4326. |
| `radius_m` | Эхо принятого радиуса. |
| `analysis_area` | Обязательный GeoJSON Polygon круга `place.point`/`radius_m`, EPSG:4326, `lon, lat`; строится сервером через существующий `AnalysisArea::forPoint` (PostGIS geography). |
| `analysis_bounds` | Обязательный bbox этого контура `[west, south, east, north]`, EPSG:4326; не bounds адресного объекта. |
| `date` | Эхо `date` или `null`. |
| `station_selection` | Эхо `selected_ids` и `radius_m`. |
| `calculated_at` | Время сборки ответа, UTC ISO-8601. Не дата наблюдения. |
| `blocks` | Только запрошенные `poi`, `satellite`, `air`. |

В каждом HTTP 200 круг полный, без обрезки источниками: поля сохраняются при `PARTIAL`/`UNKNOWN`/`OUTSIDE_SERVICE_AREA` и всех `UNAVAILABLE`. Клиент рисует серверный контур, не рассчитывает замену. Отказ resolver/круга — без частичного тела (§8).

Эхо проверяется относительно **отправленного запроса**, актуальность — по §8. Defaults: `radius_m=500`, `date=null`, `stations.selected_ids=[]`, `stations.radius_m=5000`, `blocks` — все три. Ответ называет `stations` полем `station_selection`; ID сравниваются как множество. Точка: `kind=point`, `address/label=null`, `place.point` точно повторяет ввод. Адрес: `kind=address`, `place.address.id=place.address.object.id` равно отправленному `place.address_id`; `place.point` равна `object.lon/lat` resolver, не прежним UI-координатам/подписи. Чужое эхо/состав блоков отклоняются даже при HTTP 200.

## 4. Конверт блока

| Поле | Значение |
|---|---|
| `status` | `READY` — расчёт завершён и `data` присутствует; `ERROR` — неожиданный отказ, `data: null`, код `BLOCK_CALCULATION_FAILED`; `UNAVAILABLE` — блок/источник/дата недоступны по предметной причине, `data: null`, отдельный код. HTTP остаётся 200. |
| `code` | `null` у `READY`; иначе стабильный код причины, не выведенный из текста исключения. |
| `message` | Короткое безопасное объяснение без SQL, путей, координат и личных данных. |
| `calculated_at` | Время расчёта блока, UTC ISO-8601. |
| `coverage` | Географическое покрытие радиуса активным набором источника; не доказывает полноту источника. |
| `completeness` | Полнота сведений источника по категории/области; `COMPLETE` только при зафиксированном основании, по умолчанию `UNKNOWN`. |
| `data` | Результат или `null` у `ERROR`/`UNAVAILABLE`. Пустой список при `READY` — не ошибка. |

`PARTIAL` не является статусом расчёта. Частичный результат — `READY` с `coverage.status: PARTIAL` и/или `completeness.status: PARTIAL`; агрегаты при этом `null`. Это отделяет успешность расчёта от неполноты данных.

### 4.1. Покрытие, полнота и ноль

| Поле / состояние | Смысл |
|---|---|
| `coverage.status: COVERED` | Активная область отбора покрывает весь радиус. |
| `coverage.status: PARTIAL` | Точка в сервисе, но область отбора обрезает радиус. |
| `coverage.status: OUTSIDE_SERVICE_AREA` | Точка вне сервисной территории; значения `null`/`UNAVAILABLE`. |
| `coverage.status: UNKNOWN` | Нет активного снимка или подтверждённой области отбора. |
| `coverage.available_radius_m` | Подтверждённый радиус, м, или `null`; радиус покрыт только при `available_radius_m >= radius_m`. |
| `completeness.status` | `COMPLETE` — полнота подтверждена основанием; `PARTIAL` — известны пропуски/дубли/неразрешённые сведения; `UNKNOWN` — полнота не установлена. Для OSM и станций по умолчанию `UNKNOWN`. |
| `coverage.reason`, `completeness.reason` | Конкретная причина; общий текст её не заменяет. |

| Ситуация | Ответ | Что нельзя утверждать |
|---|---|---|
| Полный запрос, объектов нет | `READY`, `COVERED`, `items: []`, `count: 0`, полнота обычно `UNKNOWN` | «Объектов нет на местности». Верно: «в используемом наборе найдено 0». |
| Радиус обрезан | `READY`, `PARTIAL`, найденные элементы видны, агрегаты `null` | Полный подсчёт или ноль. |
| Источник отсутствует | `READY` с `coverage: UNKNOWN` для категории или `UNAVAILABLE` для блока, значения `null` | Ноль и «объектов нет». |
| Неожиданный отказ | `ERROR`, `data: null`, `BLOCK_CALCULATION_FAILED` | Частичный успех блока. |
| Блок не реализован | `UNAVAILABLE`, `BLOCK_NOT_AVAILABLE` | Пустой набор или ноль. |

### 4.2. Даты, единицы и `null`

- `calculated_at`, `acquired_at` и известные `source_updated_at` — UTC ISO-8601 с `Z`.
- `observed_at` — дата/время наблюдения источника. Если часовой пояс не подтверждён, время остаётся исходной строкой, а `timezone: null`; подстановка UTC/местного времени запрещена.
- `distance_m` — метры по прямой geography до геометрии; не маршрут, не подход и не вход.
- `valid_fraction`, `masked_fraction`, `nodata_fraction`, `scene_fraction` — доли 0–1, не проценты растительности.
- NDVI безразмерен; `cloud_cover_percent` — проценты 0–100 из метаданных; PM2.5 — `µg/m³`.
- `null` — неизвестность/отсутствие результата, не ноль. Причина — в `quality.reason`, `coverage.reason`, `completeness.reason` или `message`.

## 5. Блок `poi`

Четыре согласованные категории с разными источниками: `grocery`, `pharmacy`, `official_stop`, `park`.

| Ключ | Что входит | Источник |
|---|---|---|
| `grocery` | Супермаркеты и небольшие магазины общего продуктового ассортимента | Подготовленный OSM-снимок |
| `pharmacy` | Розничные аптеки | Подготовленный OSM-снимок |
| `official_stop` | Официальные остановочные точки | Отдельный официальный набор, не OSM |
| `park` | Явно обозначенные парки и скверы | Подготовленный OSM-снимок |

Стабильный ID: `osm:node|way|relation:<id>` для OSM; `official-stop:<source_id>` для остановки. Это не адресный ID, не ID группы, не имя и не позиция в ответе. Один объект показывается один раз; совпадение названия/адреса не объединяет объекты.

| Поле объекта | Значение |
|---|---|
| `id` | Стабильный ID выше. |
| `category` | `grocery`, `pharmacy`, `official_stop`, `park`. |
| `name`, `address` | Подпись/адрес источника или `null`; не идентичность и не создаются из координат. |
| `geometry` | GeoJSON Point/Polygon/MultiPolygon, EPSG:4326. |
| `point` | Координата метки/списка; для площадного — внутренняя точка, не вход. |
| `distance_m` | Прямое расстояние до `geometry`, м; 0 внутри контура. |
| `source_version`, `source_url`, `limitations` | Необязательные версия, HTTPS-паспорт и ограничения источника; строки или null. |
| `identity_note` | Необязательное пояснение возможного дубля или `null`; без догадки об общей identity. |
| `access` | Исходный `access`/аналог парка или `null`; не подтверждение общественного доступа. |
| `source`, `dataset_import_id` | `OpenStreetMap`/`official-stops` и ID активного снимка или `null`. |
| `observed_at`, `source_updated_at` | Дата наблюдения и дата версии источника или `null`; дата импорта их не заменяет. |

Элементы упорядочены по `distance_m`, затем `id`; порядок не рейтинг. Расстояние до территории не является расстоянием до входа.

- `method_version` — обязательная версия правил. `poi-v3-geography-source-geometry-park-outer-aliases` с парками; иначе v2/retail. [Правила](../data/osm-parks.md).
- Обязательны `coverage.by_category` (`status`, `reason`, `available_radius_m`) и `completeness.by_category` (`status`, `reason`). Сводный `coverage.status` — `OUTSIDE_SERVICE_AREA`, если все категории вне сервиса; иначе `PARTIAL`, если есть `PARTIAL` или `OUTSIDE_SERVICE_AREA`; иначе `UNKNOWN`, если есть `UNKNOWN`; иначе `COVERED`. Сводная полнота — `PARTIAL`, если есть `PARTIAL`; иначе `UNKNOWN`, если есть `UNKNOWN`; `COMPLETE` только если все `COMPLETE`.
- `availability_by_category` — необязательное поле; retail-provider возвращает `{status: READY|UNAVAILABLE|ERROR, code: null|string, message: string}` для всех категорий. TS валидирует, UI показывает ошибки. [Правила](../data/osm-pharmacy.md).
- `data.items` — найденные элементы; при `PARTIAL` это неполный список.
- `data.count` — число возвращённых элементов; `null`, если хотя бы одна категория имеет `coverage != COVERED` или `completeness == PARTIAL`. `counts_by_category` считается независимо: такая категория даёт `null`, покрытая — число. `UNKNOWN` полнота не обнуляет счёт используемого набора, но не превращает 0 в отсутствие объектов.
- `data.official_stop_summary` — `found_count`, `source_without_coordinates` (≥0|null) и `excluded_outside_scope?` (≥0, не больше source_without_coordinates): отбор круга, исходные и исключённые негеокодированные записи. [Семантика](../data/transport-import.md#подпись-найденного-количества).
- `count: 0` при `COVERED` — «в используемом наборе найдено 0»; при `UNKNOWN` полноте это не «объектов нет».
- Отсутствие/отказ источника даёт категории UNKNOWN/count=null, сохраняя остальные. Без готовых категорий блок `ERROR` при ошибке, иначе `UNAVAILABLE / POI_SNAPSHOTS_UNAVAILABLE`. Другие блоки независимы.
- Площади, доли круга и рейтинг здесь не возвращаются. Парк/сквер не равен растительной территории.

## 6. Блок `satellite`

NDVI дат без процента растительности и анализа изменений; UI/активация отдельно. Нет runtime/pin — `UNAVAILABLE/SATELLITE_NOT_CONFIGURED`, недоверенный каталог — `UNAVAILABLE/SATELLITE_CATALOG_UNTRUSTED`, неожиданный отказ — `ERROR/SATELLITE_READ_FAILED`. data=null при отказе; coverage/completeness блока всегда null. POI/air независимы; READY допускает [].

`data`: method/mask/legend versions, catalog/source-index hashes, legend, delivery_status и:

| Поле | Смысл |
|---|---|
| `available_dates` | Пригодные для круга date/release_id/manifest_sha256/scenes/warnings/limitations. |
| `releases[]` | Все даты с status/reason/coverage/mean_ndvi/mean_ndvi_reason, теми же provenance и ограничениями. |
| `scenes[]` | Все составляющие: scene_id/product_uri/tile/platform/baseline/datatake, acquired_at_catalog/acquired_at_granule UTC; общей выдуманной сцены нет. |
| `selected` | Запрошенная строка releases + `layers`. Нет даты — DATE_NOT_SELECTED; нет её в каталоге — DATE_NOT_IN_CATALOG; coverage/mean_ndvi=null с причиной. Автовыбора нет; неверный формат — 422. |
| `layers` | MapLibre raster-source descriptors true-color/ndvi; null без подготовленных пикселей или доставки. |

Знаменатель — круг native-центров 10 м EPSG:32646 через PostGIS, не точный geography-контур. `source_footprint_fraction` — объединение футпринтов, `prepared_fraction` — target, `geographic_fraction` — ненулевые исходные данные, `usable_fraction` — допустимый NDVI. Доли независимы от городских. Coverage: *_pixels, circle_pixels, outside_rectangle_pixels, inside_rectangle_outside_target_pixels, reason_counts/source_pixels. Overlap один раз; краевой пиксель неизвестен.

Ноль NDVI допустим. Нет подготовленных/географических/пригодных данных — UNAVAILABLE с NO_PREPARED_DATA/NO_GEOGRAPHIC_DATA/NO_USABLE_NDVI, среднее null. Повреждение блока — SATELLITE_RELEASE_UNTRUSTED, coverage/среднее null; бюджет — READ_BUDGET_EXCEEDED. Остальные даты и статус каталога сохраняются.

`EARLY_SPRING_SNOW` для 07.05.2024: снег запада и ранняя фенология, не летнее состояние; [метаданные](../../config/satellite/catalog-metadata.json) закреплены по hash manifest. ndvi-fixed-v2 общая; отказ доставки сохраняет аналитику. Порча PNG проверяется при чтении.

POST сохраняет no-store/no-referrer и безопасные ошибки/логи. [Reader](../data/satellite.md#серверное-чтение-а101); [same-origin PNG XYZ, бюджеты, pins и отдельная активация](../data/satellite.md#доставка-и-активация-а102).

## 7. Блок `air`

Показывает наблюдения конкретных станций, положение, расстояние и доступность истории. Не измеряет воздух в точке и не ограничивает станции кругом места. `coverage` блока — `null`; полнота сети/истории — `completeness`.

| Поле | Значение |
|---|---|
| `selection` | `radius_m` (1000–20000, по умолчанию 5000), `selected_ids`. Не зависит от `radius_m` места. |
| `data.stations` | Станции: выбранные, до 5 ближайших в области выбора и остальные в ней. |
| `missing_selected_ids` | Запрошенные ID, отсутствующие в справочнике; не делают блок ошибочным. |
| `counts` | `selected`, `nearest`, `other` — число возвращённых станций по группам, не оценка полноты сети. |

Станция:

| Поле | Значение |
|---|---|
| `id`, `name`, `source`, `dataset_import_id` | ID источника, подпись, ключ источника, ID снимка/справочника. |
| `lon`, `lat`, `distance_m` | Координаты EPSG:4326 и прямое geography-расстояние до места; не измерение в точке. |
| `group`, `selected` | `selected` — явно запрошена; `nearest` — до 5 ближайших, не попавших в `selected`; `other` — остальные в области выбора. `selected` имеет приоритет; порядок — группа, затем расстояние. |
| `status` | `ACTIVE`, `INACTIVE`, `UNKNOWN` из справочника. |
| `metadata` | `observed_at`, `source_updated_at`, `timezone`, `crs`, `reason`; неизвестное — `null`. Дата наблюдения не заменяется датой публикации. |
| `latest` | Последнее наблюдение или `null`; `latest_reason` объясняет отсутствие. |
| `history` | Сводка: `status: AVAILABLE|UNAVAILABLE|UNKNOWN`, `first_observed_at`, `last_observed_at`, `reason`; полный ряд — А12. |

`latest`: `observed_at` — исходная строка времени; `timezone`/`utc_offset` — `null`, пока часовой пояс не подтверждён; `aggregation: hourly`; `values` — список наблюдений. В первом выпуске только `pm2_5`, `unit: µg/m³`: нуль допустим, пропуск — `null` с `quality.availability: INSUFFICIENT_DATA` и причиной. `quality`: `method: MEASURED|null`, `availability: AVAILABLE|INSUFFICIENT_DATA|UNAVAILABLE`, `freshness: UNKNOWN`, `qc: UNKNOWN|VALID|SUSPECT` (по умолчанию `UNKNOWN`). Другие величины требуют свидетельства А11.

- Станции вне круга места доступны; отсутствие станции в области выбора не означает её отсутствия в городе.
- Нет справочника/импорта — `UNAVAILABLE` (`AIR_SOURCE_UNAVAILABLE`); неожиданный отказ расчёта — `ERROR`.
- Глубина, непрерывность и QC архива не обещаются; `history.status: UNKNOWN` — допустимое состояние. `first_observed_at`/`last_observed_at` — исходные строки времени; часовой пояс не подставляется.

## 8. Независимость и поздние ответы

1. Подтверждение адреса/здания или точки запускает независимые POST к одному endpoint, каждый с `blocks:[один блок]`, своими `loading`/`error`/`retry`, AbortController/epoch/таймаутом. POI показывается по своему ответу, не ждёт air/satellite. Пакетный API сохранён, но один JSON не даёт поэтапной доставки и для независимой загрузки UI не используется.
2. Ошибка/повтор затрагивают только свой блок. Неожиданный отказ resolver/круга — 503 `SERVICE_UNAVAILABLE` данного запроса; предметные 404/503 адреса сохраняются. Бюджет А7: в транзакции resolver/круга `statement_timeout=2s`, `lock_timeout=500ms`; до трёх предметных SELECT (снимок адресов, объект, круг), без сетевых providers. Настройки локальны транзакции и снимаются при commit/rollback. Nginx: connect 2s, read 15s; read timeout ограничивает ожидание upstream, не гарантирует остановки PHP. Подключение к БД зависит от конфигурации соединения; общего wall-clock deadline PHP этот срез не добавляет. Клиент ждёт каждый блок не более 20s, различает timeout/cancel и не повторяет автоматически. Бюджеты спутникового provider — §6, будущего provider воздуха — А12; abort fetch не гарантирует остановки сервера.
3. Снимки фиксируются один раз на HTTP-запрос; независимые ответы сохраняют свои `dataset_import_id`/`calculated_at`, не общий атомарный snapshot. Изменившиеся координаты resolver того же ID не смешиваются со старым кругом: зависимые результаты неактуальны до явного обновления.
4. Зависимости: `poi` — место/радиус; `satellite` — место/радиус/дата; `air` — место/радиус/selection. Дата инвалидирует только satellite, selection — только air, сохраняя остальные результаты и pending-запросы. Место/радиус инвалидируют все три; старые показатели не показываются текущими. Экран запускает анализ при подтверждении места и через 350ms после изменения радиуса. До нового ответа остаётся серверный контур прежнего радиуса с явной пометкой «предыдущий»; при смене места он удаляется. Дата — только satellite; станции — явно.
5. Запуск/повтор/инвалидация увеличивает epoch только затронутого блока и отменяет его запрос. Приём ответа требует эха своего запроса (§3), текущего epoch и неизменных зависимостей. А→Б→А не оживляет старый ответ А. `date=D1` у pending POI допустима после выбора D2. После смены места/unmount старые response/error/finally не меняют данные/loading/карту.
6. Хранение/обмен и восстановление после reload/Back/Forward не реализованы: решение владельца открыто. Новый ввод живёт только в памяти экрана; URL с координатами не создаётся, старые ссылки/records не мигрируются. Сервер результаты не хранит.
7. Сеть, таймаут, 429, 422, 404/503 адреса и предметные `ERROR`/`UNAVAILABLE` различаются в клиенте. Повтор — только по конкретной причине; автоматического повтора нет.

## 9. Совместимость

| Существующее | Что сохраняется |
|---|---|
| `GET /api/v1/addresses/{id}/profile` | Полный профиль, шесть блоков, 300/500, default 500, `scope=selected` v1, поля/ошибки. Новый контракт его не меняет. |
| `GET /api/v1/addresses/{id}` | Resolver, 404/503, `resolver_version: 1`, `selected_profile_version: 1`; новая capability не требуется. |
| `/api/v1/transport/analysis`, `/api/v1/trips/analyze`, `/api/v1/addresses/search`, `/api/v1/addresses/resolve-point` | Прежние методы, параметры, лимиты и ответы. Официальные остановки остаются отдельным источником. |
| URL `/?lon=…&lat=…&radius_m=300|500`, `/address/{id}?radius_m=300|500` | Старые страницы удалены; query/fragment не восстанавливаются, отдельные URL перенаправляются на `/`. В API `radius_m=1000` в старом профиле по-прежнему 422. |
| Типы `AddressProfile`, `SelectedAddressProfile`, `TransportAnalysis`, `SpatialCoverage` | Не ослабляются до optional-полей и не переиспользуются как новый контракт. Новые типы — отдельные. |
| Ссылки и результат | Ссылка не является снимком анализа. Новый URL/состояние определяет А7; сервер результаты не хранит. |

Расчёт использует только `POST /api/v1/place-analysis`; [адрес-ориентир точки](point-address.md#ориентир-точки-на-analysis) независим. Он не делает fallback на старый профиль при 404/422/503 и не отправляет 1000 м в старый endpoint. Если новый endpoint недоступен, UI показывает причину, старые серверные API сохраняются.

## 10. Синтетические примеры

Два вымышленных входа, не runtime:

```json
{"place":{"kind":"address","address_id":"osm:way:1"},"radius_m":300,"blocks":["poi"]}
```

```json
{"place":{"kind":"point","lon":92.9,"lat":56.0},"radius_m":500,"blocks":["poi"]}
```

Для точки ещё два POST — с `blocks:["satellite"]` и `blocks:["air"]`. Общие поля/состояния — §3–7; независимость ответов и повторов — §8.

## 11. Файлы реализации и оставшаяся работа

API и клиентский lifecycle А7 реализованы без миграций и изменения данных. Весь А7 не закрыт: хранение/URL и восстановление требуют решения владельца.

### 11.1. Backend

`PlaceAnalysisRequest`, `LimitPlaceAnalysisRequest`, `PlaceAnalysisController`, `Services/Analysis/PlaceAnalysisService`, `routes/api.php`, `bootstrap/app.php`, `docker/nginx/nginx.conf` реализуют §2–4. Resolver/AnalysisArea переиспользуются; старый профиль не изменён. `GroceryPoiProvider` использует `DatasetCoverage` для отдельного grocery-снимка. Предметные данные А8–А12 — §5–7.

### 11.2. Frontend

В `resources/js`: `types/placeAnalysis.ts` — типы; `api/placeAnalysis.ts` — POST/schema/эхо; `composables/usePlaceAnalysis.ts` — lifecycle §8. `PlaceAnalysisPage` выбирает объект/точку, `PlaceAnalysisResults` показывает состояния/POI/выбор даты и станций, `PlaceAnalysisMap` получает серверный круг/bbox и проверенные списки. При открытии реального экрана метки места нет до выбора. TCI/NDVI подключены через raster-source descriptors API. Наблюдения воздуха пока недоступны (А11–А12), без синтетической замены.

### 11.3. Проверки

| Файл | Проверка |
|---|---|
| `tests/Feature/PlaceAnalysisApiTest.php` | SQLite/моки: XOR/строгие типы/defaults/эхо, выбор блоков/независимый отказ, 404/405/413/415/422/429/503 и headers, debug-canary до контроллера/в сервисе, старые 300/500 |
| `tests/Integration/PlaceAnalysisTest.php` | Защищённый `PostGISReadOnly`: реальный круг/bbox 200/1000 без providers, UNKNOWN/null, SQL timeout и восстановление настроек; без импорта/записи fixtures |
| `tests/security/test_trip_nginx.py`, `tests/security/trip_nginx_probe.sh` | Изолированный Nginx: граничные тела с Content-Length/chunked, безопасные 413/502/504/headers, нет canary в logs/temp; старые пути |

Клиентские регрессии: `tests/frontend/place-analysis-api.test.mjs` (schema/эхо/контур/ошибки), `place-analysis-state.test.mjs` (зависимости/epochs/abort/timeout), browser `place-analysis-api.spec.mjs` (независимая доставка/UI) и `place-analysis.spec.mjs` (единственный экран, redirect, отсутствие демо и сохранность browser records). Старые API/records сохранены.

Команды и эффекты — [testing](../testing.md). Клиент: целевые Node tests, typecheck и browser-файлы; сборка отдельно от `public/build`. GIS — только `web_gis_test`.

## 12. Ограничения и открытые вопросы

- **Источники:** grocery поддержан отдельным снимком и provider. Рабочая активация не выполнена. Остальные категории, спутники и воздух недоступны; старые наборы их не подменяют.
- **А8:** допуск grocery в рабочее окружение и остальные категории. Правила первого среза — [grocery](../data/osm-grocery.md). Пользовательская польза проверяется отдельно с людьми, не А8.
- **А9/А10:** радиометрия, маски, геометрия, легенда, формат assets и реальные даты. `valid_fraction` — покрытие данных, не процент растительности; композиции/различия не входят.
- **А11/А12:** часовой пояс, QC, история оборудования/координат, полный ряд и стабильность ID. `timezone: null`/`qc: UNKNOWN` обязательны, пока это не подтверждено.
- **Остаток А7:** решение владельца о хранении, обмене, URL и восстановлении reload/Back/Forward; затем отдельная реализация и регрессии совместимости. Сейчас новый ввод только в памяти. А6 и весь А7 не закрыты; полная проверка UI на данных будущих providers — А8–А12/И1–И3/А13.
- **Производительность:** число дат/станций ограничивают А10/А12; тяжёлая raster/GIS-обработка в HTTP запрещена. 5 станций и 5 км — стартовые технические значения, не обещание полной сети.
- **Пользовательская польза** не подтверждена; контракт не является продуктовым доказательством.
