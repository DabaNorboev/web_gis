---
status: plan
updated: 2026-11-04
verified: not verified
---

# Анализ одного места: целевой контракт API

Контракт А5 для А6–А12. Он **не реализован**: общего анализа адреса/точки, радиуса 200–1000 м, POI-блока, NDVI дат и станций воздуха в приложении нет. Существующие `/api/v1/addresses/{id}/profile` с 300/500 м и `/api/v1/transport/analysis` продолжают работать без изменений.

Состав и критерии блоков — в [плане анализа](../plans/analysis-transition-plan.md#вопросы-и-конечный-объём-анализа).

## 1. Решение о совместимости

Выбран новый вход `POST /api/v1/place-analysis`, а не расширение адресного профиля:

- профиль закреплён за конкретным адресным ID и радиусами 300/500 м, содержит шесть других блоков и используется работающими страницами;
- свободная точка не должна получать выдуманный адресный ID, а профиль без адреса невозможен;
- новый вход принимает адрес или точку, 200–1000 м, дату и отдельный выбор станций, не ослабляя старые контракты;
- координаты и списки передаются в JSON-теле, а не в query; ответы не кэшируются.

Новый вход переиспользует resolver, проверку покрытия и построение круга, когда это подходит. Новый GIS-сервис, очередь, брокер или вторая карта не нужны. Импорт POI, raster-подготовка и importer станций остаются задачами А8–А11; до реализации блок возвращает `UNAVAILABLE`, а не выдуманные данные. Сверены `AddressProfileRequest`, `AddressProfileService`, `AddressResolverService`, `AnalysisArea`, `DatasetCoverage`, клиенты `profiles.ts`/`searchProfiles.ts`, `useAddressProfile` и тесты профиля/покрытия; они не меняются.

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

Некорректный ввод — HTTP 422 без частичного анализа. Лимит — 60 запросов/мин на IP; 429 содержит `Retry-After`, автоматического повтора нет. Ответы — `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. Тела запросов, координаты и ID станций не пишутся в журналы; технический лог содержит только тип исключения и ключ блока.

## 3. Общий ответ

| Поле | Значение |
|---|---|
| `analysis_version` | `1`. Не меняет `profile_version` адресного профиля. |
| `place.kind` | `address` или `point`. Для адреса заполнены `label` и `address`; для точки `label: null`, `address: null`, координаты — ровно введённые. Приблизительная подпись UI не является идентичностью. |
| `place.address` | Адресная часть resolver: `id`, `label`, `object` (`id`, `lon`, `lat`, `geometry`, `point_method`, `object_type`, `levels`), `bounds`, `source`, `dataset_import_id`, `observed_at`, `source_updated_at`, `reason`. Точка контура не вход. |
| `place.point` | Точка анализа: для адреса — `object.lon/lat`, для точки — ввод. EPSG:4326. |
| `radius_m` | Эхо принятого радиуса. |
| `date` | Эхо `date` или `null`. |
| `station_selection` | Эхо `selected_ids` и `radius_m`. |
| `calculated_at` | Время сборки ответа, UTC ISO-8601. Не дата наблюдения. |
| `blocks` | Только запрошенные `poi`, `satellite`, `air`. |

Ответ всегда возвращает эхо `place`, `radius_m`, `date` и `station_selection`. Клиент отвергает ответ, если эхо не совпадает с текущим вводом, даже при HTTP 200.

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
| `access` | Исходный `access`/аналог парка или `null`; не подтверждение общественного доступа. |
| `source`, `dataset_import_id` | `OpenStreetMap`/`official-stops` и ID активного снимка или `null`. |
| `observed_at`, `source_updated_at` | Дата наблюдения и дата версии источника или `null`; дата импорта их не заменяет. |

Элементы упорядочены по `distance_m`, затем `id`; порядок не рейтинг. Расстояние до территории не является расстоянием до входа.

- `method_version` — обязательное правило прямого расстояния/дедупликации; значение уточняет А8.
- `coverage.by_category` и `completeness.by_category` обязательны: источники различаются. Элемент `coverage.by_category` содержит `status`, `reason`, `available_radius_m`; элемент `completeness.by_category` — `status`, `reason`. Сводный `coverage.status` — `OUTSIDE_SERVICE_AREA`, если все категории вне сервиса; иначе `PARTIAL`, если есть `PARTIAL` или `OUTSIDE_SERVICE_AREA`; иначе `UNKNOWN`, если есть `UNKNOWN`; иначе `COVERED`. Сводная полнота — `PARTIAL`, если есть `PARTIAL`; иначе `UNKNOWN`, если есть `UNKNOWN`; `COMPLETE` только если все `COMPLETE`.
- `data.items` — найденные элементы; при `PARTIAL` это неполный список.
- `data.count` — число возвращённых элементов; `null`, если хотя бы одна категория имеет `coverage != COVERED` или `completeness == PARTIAL`. `counts_by_category` считается независимо: такая категория даёт `null`, покрытая — число. `UNKNOWN` полнота не обнуляет счёт используемого набора, но не превращает 0 в отсутствие объектов.
- `count: 0` при `COVERED` — «в используемом наборе найдено 0»; при `UNKNOWN` полноте это не «объектов нет».
- Если ни одна категория не может быть рассчитана, блок — `UNAVAILABLE`. Отсутствующий источник категории даёт `coverage/completeness: UNKNOWN` и не скрывает другие категории; неожиданный отказ расчёта блока — `ERROR` (другие блоки независимы).
- Площади, доли круга и рейтинг здесь не возвращаются. Парк/сквер не равен растительной территории.

## 6. Блок `satellite`

Отвечает за исходные изображения и NDVI конкретной доступной даты. Не возвращает процент растительности, ежегодную композицию, разность лет или оценку изменения. Без даты — только каталог подготовленных дат.

`satellite.status` описывает каталог: `READY` — каталог доступен (даже пустой), `UNAVAILABLE` — источник/каталог не подключён, `ERROR` — неожиданный отказ. `coverage`/`completeness` блока — `null`: они относятся к выбранной сцене.

| Поле `data` | Значение |
|---|---|
| `available_dates` | Даты, для которых подготовлены и проверены слои для этого места/радиуса; не все сцены каталога. Пустой список — не ошибка. Элемент: `date`, `scene_id`, `cloud_cover_percent`. |
| `selected` | `null` или объект выбранной даты; `status: READY|UNAVAILABLE|ERROR`. Ошибка слоя не делает `satellite.status` ошибочным. |
| `selected.coverage` | `status`, `reason`, `scene_fraction`, `valid_fraction`, `masked_fraction`, `nodata_fraction`. Доли пикселей круга в native-сетке; считаются независимо и не складываются в «процент зелени». |
| `selected.completeness` | `status`, `reason`; полнота сцены/маски. |
| `selected.method_version` | Версия NDVI/маски; значение фиксирует А9. |
| `selected.scene` | `scene_id`, `product` (`sentinel-2-l2a`), `acquired_at` UTC, `tile`, `baseline`, `cloud_cover_percent`, `bounds` EPSG:4326, `crs`, `resolution_m`, `mask_resolution_m`; неизвестное — `null`. |
| `selected.assets` | `true_color` и `ndvi`: `href` того же origin, `media_type`, `crs`, `bounds` EPSG:4326. NDVI дополнительно `value_min: -1`, `value_max: 1`, `nodata` (число или `null`). Формат/endpoint выбирает А10. |
| `selected.legend` | `version`, `classes` (`min`, `max`, `label`, `color`). Общая легенда NDVI; не процент растительности. |

- Для недоступной даты — `selected.status: UNAVAILABLE`, код `SATELLITE_DATE_UNAVAILABLE`; каталог остаётся в `available_dates`.
- Для отказа слоя — `selected.status: ERROR`, код `SATELLITE_LAYER_FAILED`, остальные поля `null`.
- `valid_fraction` — доля пикселей с допустимым NDVI после маски; `masked_fraction` — облако/снег/SCL; `nodata_fraction` — nodata/вне сцены; `scene_fraction` — покрытие круга футпринтом.
- Нет сцены/даты, неизвестная радиометрия или непригодная маска — `UNAVAILABLE`/`ERROR` с причиной, не ноль и не «нет растительности».

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

1. Блоки рассчитываются независимо. Ошибка одного блока не отменяет остальные; HTTP 200 с `ERROR` одного блока допустим. Полный отказ оркестрации (resolver, общий круг) — 503 `SERVICE_UNAVAILABLE` без частичного тела.
2. Снимки каждого источника фиксируются один раз до расчёта блоков; публикация нового снимка между блоками не смешивает данные. `dataset_import_id` в элементах это подтверждает.
3. Смена места, радиуса, даты или выбора станций делает прежний результат неактуальным. Клиент отменяет текущий запрос, не показывает прежние блоки как текущие и не пересчитывает автоматически без действия пользователя. Поздний ответ отбрасывается по токену и эху; сервер не обязан успеть прервать работу.
4. При выборочном `blocks` клиент может обновить только затронутый блок. Неизменённые блоки сохраняют собственные `calculated_at`; нельзя выдавать их за единый атомарный снимок нового запроса.
5. Смена даты влияет на `satellite.selected`; выбор станций — на `air`; место/радиус — на `poi`, `satellite` и расстояния `air`. Старый и новый ответ не смешиваются.
6. Back/Forward/reload — А6/А7: восстанавливают ввод и запрашивают текущие данные, а не исторический снимок. Сервер результаты не хранит и по ссылке не отдаёт.
7. Сеть, таймаут, 429, 422, 404/503 адреса и предметные `ERROR`/`UNAVAILABLE` различаются в клиенте. Повтор — только по конкретной причине; автоматического повтора нет.

## 9. Совместимость

| Существующее | Что сохраняется |
|---|---|
| `GET /api/v1/addresses/{id}/profile` | Полный профиль, шесть блоков, 300/500, default 500, `scope=selected` v1, поля/ошибки. Новый контракт его не меняет. |
| `GET /api/v1/addresses/{id}` | Resolver, 404/503, `resolver_version: 1`, `selected_profile_version: 1`; новая capability не требуется. |
| `/api/v1/transport/analysis`, `/api/v1/trips/analyze`, `/api/v1/addresses/search`, `/api/v1/addresses/resolve-point` | Прежние методы, параметры, лимиты и ответы. Официальные остановки остаются отдельным источником. |
| URL `/?lon=…&lat=…&radius_m=300|500`, `/address/{id}?radius_m=300|500` | Прежние страницы и радиусы. Новый анализ их не переинтерпретирует; `radius_m=1000` в старом профиле по-прежнему 422. |
| Типы `AddressProfile`, `SelectedAddressProfile`, `TransportAnalysis`, `SpatialCoverage` | Не ослабляются до optional-полей и не переиспользуются как новый контракт. Новые типы — отдельные. |
| Ссылки и результат | Ссылка не является снимком анализа. Новый URL/состояние определяет А7; сервер результаты не хранит. |

Новый клиент вызывает только `POST /api/v1/place-analysis`. Он не делает fallback на старый профиль при 404/422/503 и не отправляет 1000 м в старый endpoint. Если новый endpoint недоступен, UI показывает причину, а старые страницы продолжают работать.

## 10. Синтетические примеры

Все ID, координаты, даты, сцены, станции и значения вымышлены и не описывают реальный объект или измерение. Примеры сокращены до ключевых полей; полный состав — в таблицах. Это не результат запуска приложения.

### 10.1. Вход с явным адресом

```json
{"place":{"kind":"address","address_id":"osm:way:1"},"radius_m":300,"blocks":["poi"]}
```

### 10.2. Успех

```json
{
  "analysis_version": 1,
  "place": {"kind": "point", "label": null, "address": null, "point": {"lon": 92.9, "lat": 56.0}},
  "radius_m": 500,
  "date": "2026-08-12",
  "station_selection": {"selected_ids": ["synthetic-station-1"], "radius_m": 5000},
  "calculated_at": "2026-11-03T12:00:00Z",
  "blocks": {
    "poi": {"status": "READY", "code": null, "message": null, "calculated_at": "2026-11-03T12:00:00Z",
      "coverage": {"status": "COVERED"}, "completeness": {"status": "UNKNOWN"},
      "data": {"items": [{"id": "osm:node:900001", "category": "grocery", "distance_m": 120.5, "source": "OpenStreetMap"}],
        "count": 1, "counts_by_category": {"grocery": 1, "pharmacy": 0, "official_stop": 0, "park": 0}}},
    "satellite": {"status": "READY", "code": null, "message": null, "calculated_at": "2026-11-03T12:00:00Z",
      "data": {"available_dates": [{"date": "2026-08-12", "scene_id": "SYNTH-SCENE-1", "cloud_cover_percent": 0.014}],
        "selected": {"status": "READY", "coverage": {"status": "COVERED", "valid_fraction": 0.42, "masked_fraction": 0.55, "nodata_fraction": 0.03},
          "scene": {"scene_id": "SYNTH-SCENE-1", "acquired_at": "2026-08-12T05:03:00Z"},
          "assets": {"ndvi": {"href": "/synthetic/ndvi.png", "value_min": -1, "value_max": 1, "nodata": null}}}}},
    "air": {"status": "READY", "code": null, "message": null, "calculated_at": "2026-11-03T12:00:00Z",
      "data": {"stations": [{"id": "synthetic-station-1", "distance_m": 2790.2, "group": "selected",
        "latest": {"observed_at": "2026-08-15 23:00:00", "timezone": null, "values": [
          {"key": "pm2_5", "value": 12.4, "unit": "µg/m³", "quality": {"availability": "AVAILABLE", "qc": "UNKNOWN"}}]}}],
        "counts": {"selected": 1, "nearest": 0, "other": 0}}}
  }
}
```

### 10.3. Частичный результат

Радиус обрезан; найденный элемент виден, агрегаты не выглядят полными. HTTP 200.

```json
{
  "analysis_version": 1,
  "place": {"kind": "point", "label": null, "address": null, "point": {"lon": 92.9, "lat": 56.0}},
  "radius_m": 1000, "date": null, "station_selection": {"selected_ids": [], "radius_m": 5000},
  "blocks": {"poi": {"status": "READY", "code": null, "message": null, "calculated_at": "2026-11-03T12:00:00Z",
    "coverage": {"status": "PARTIAL", "reason": "Область отбора обрезает радиус.", "by_category": {"grocery": {"status": "PARTIAL"}}},
    "completeness": {"status": "UNKNOWN", "reason": "Полнота источников не подтверждена."},
    "data": {"items": [{"id": "osm:node:900002", "category": "pharmacy", "distance_m": 251.0}],
      "count": null, "counts_by_category": {"grocery": null, "pharmacy": null, "official_stop": null, "park": null}}}}
}
```

### 10.4. Независимый отказ блока

POI готов, станции упали; готовый блок не скрыт, отказ не стал нулём. HTTP 200.

```json
{
  "analysis_version": 1,
  "place": {"kind": "point", "label": null, "address": null, "point": {"lon": 92.9, "lat": 56.0}},
  "radius_m": 500, "date": null, "station_selection": {"selected_ids": [], "radius_m": 5000},
  "blocks": {
    "poi": {"status": "READY", "code": null, "message": null, "calculated_at": "2026-11-03T12:00:00Z",
      "coverage": {"status": "COVERED"}, "completeness": {"status": "UNKNOWN"},
      "data": {"items": [], "count": 0, "counts_by_category": {"grocery": 0, "pharmacy": 0, "official_stop": 0, "park": 0}}},
    "air": {"status": "ERROR", "code": "BLOCK_CALCULATION_FAILED", "message": "Блок станций временно недоступен; остальные блоки сохранены.",
      "calculated_at": "2026-11-03T12:00:00Z", "coverage": null, "completeness": null, "data": null}
  }
}
```

## 11. Что менять при реализации

Код, тесты и миграции сейчас не менялись. Таблица — план работ А6–А12.

### 11.1. Backend

| Файл | Изменение | Назначение |
|---|---|---|
| `routes/api.php` | Новый `POST v1/place-analysis` с throttle | Единственная точка входа; старые маршруты не меняются |
| `app/Http/Requests/PlaceAnalysisRequest.php` | Новый FormRequest | XOR адрес/точка, 200–1000, дата, лимиты станций, whitelist блоков |
| `app/Http/Controllers/Api/V1/PlaceAnalysisController.php` | Новый controller | JSON, `no-store`/`no-referrer`, 404/503 адреса, безопасный 503 оркестрации |
| `app/Services/Analysis/PlaceAnalysisService.php` | Новый оркестратор | Фиксация снимков, эхо, независимые блоки, конверт без второй GIS-логики |
| `app/Services/Analysis/PoiAnalysisService.php` | Новый (А8) | Категории/теги/дедупликация/расстояния; детали — А8 |
| `app/Services/Satellite/…` | Новые (А9/А10) | Подготовленные даты, NDVI, маски, покрытие, assets; без тяжёлого расчёта в HTTP |
| `app/Services/Air/…` | Новые (А11/А12) | Справочник/наблюдения станций, отдельное selection, история — А12 |
| `app/Services/Addresses/AddressResolverService.php`, `app/Services/Gis/AnalysisArea.php`, `app/Services/Gis/DatasetCoverage.php` | Не меняются | Точный ID, круг и покрытие переиспользуются |
| `app/Services/Addresses/AddressProfileService.php`, `app/Http/Requests/AddressProfileRequest.php` | Не меняются | 300/500, шесть блоков и старый API сохраняются |

### 11.2. Frontend

| Файл | Изменение | Назначение |
|---|---|---|
| `resources/js/types/placeAnalysis.ts` | Новый | Типы входа/выхода, блоков, покрытия, полноты, POI/сцены/станции |
| `resources/js/api/placeAnalysis.ts` | Новый | POST, проверка эха/блоков/`null`, нейтральное сообщение 422; без fallback на профиль |
| `resources/js/composables/usePlaceAnalysis.ts` | Новый (А6/А7) | Abort, токен, поздние ответы, раздельные блоки, отсутствие автопересчёта |
| `resources/js/api/searchProfiles.ts`, `resources/js/types/profile.ts`, `resources/js/types/transport.ts` | Не меняются | Старый профиль и его валидатор остаются отдельным контрактом |
| `resources/js/api/errors.ts` | Не меняется | Новый клиент переиспользует `requestJson`/`ApiRequestError` и сам задаёт сообщение 422 |
| `resources/js/pages/…`, `resources/js/components/…` | А6 | Экран, легенда, слои, станции, состояния; не входят в А5 |

### 11.3. Проверки

| Файл | Изменение | Что проверяет |
|---|---|---|
| `tests/Feature/PlaceAnalysisApiTest.php` | Новый (SQLite/моки) | XOR/радиус/дата/станции, эхо, 404/503/422, независимые `ERROR`/`UNAVAILABLE`, `no-store`, отсутствие секретов |
| `tests/Integration/PlaceAnalysisTest.php` | Новый, только `web_gis_test` через `Tests\PostgisTestCase` | 200/1000, границы покрытия, `COVERED`/`PARTIAL`/`OUTSIDE`, пустой полный набор ≠ частичный, остановки ≠ OSM, заморозка снимков, независимость |
| `tests/frontend/place-analysis-api.test.mjs` | Новый | Эхо, радиус, дата, станции, `null`/`ERROR`/`UNAVAILABLE`; отклонение чужого/неполного ответа |
| `tests/frontend/place-analysis-state.test.mjs` | Новый (А6/А7) | Смена места/радиуса/даты/станций, abort, поздний/устаревший ответ, независимое обновление блока |
| `tests/browser/place-analysis.spec.mjs` | Новый (А6/А13) | Экран, легенда/слои, состояния, клавиатура/фокус/мобильный; синтетический API |
| `tests/Feature/SearchProfileApiTest.php`, `tests/Integration/AddressProfileTest.php`, `tests/Integration/TransportAnalysisTest.php`, `tests/Integration/OsmAreaAnalysisTest.php` | Не меняются | Регрессии старых 300/500, resolver, покрытия и независимости |
| `tests/frontend/search-api.test.mjs`, `tests/frontend/address-profile.test.mjs`, `tests/frontend/transport-coverage.test.mjs` | Не меняются | Регрессии существующих клиентов и состояний `null`/покрытия |

Команды реализации (не выполнялись в А5): `composer test -- --filter=PlaceAnalysisApiTest`, `composer test:postgis -- --filter=PlaceAnalysisTest`, `npm test`, `npm run typecheck`, целевой browser-сценарий. GIS-тесты — только защищённая `web_gis_test`; рабочая БД не используется.

## 12. Ограничения и открытые вопросы

- **Не реализовано:** endpoint, POI-импорт, спутниковые layers/API, importer/API станций, UI и хранение. Документ не подтверждает реальный результат.
- **А8:** теги/границы категорий, дедупликация, полнота и пригодность данных. Контракт задаёт форму, но не качество POI. Пользовательская польза проверяется отдельно с людьми, не А8.
- **А9/А10:** радиометрия, маски, геометрия, легенда, формат assets и реальные даты. `valid_fraction` — покрытие данных, не процент растительности; композиции/различия не входят.
- **А11/А12:** часовой пояс, QC, история оборудования/координат, полный ряд и стабильность ID. `timezone: null`/`qc: UNKNOWN` обязательны, пока это не подтверждено.
- **А6:** экран, легенда, панель слоёв, станции, мобильные состояния, хранение/ссылки. **А7:** новый URL/состояние; старые 300/500 не переинтерпретируются.
- **Производительность:** число дат/станций ограничивают А10/А12; тяжёлая raster/GIS-обработка в HTTP запрещена. 5 станций и 5 км — стартовые технические значения, не обещание полной сети.
- **Пользовательская польза** не подтверждена; контракт не является продуктовым доказательством.
