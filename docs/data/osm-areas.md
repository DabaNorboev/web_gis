---
status: current
updated: 2026-11-04
verified: not verified
---

# Локальная зелень и вода OSM

`osm_green_areas` / `osm_water` и офлайн-команда `osm:import-areas green_areas|water`. Импорт сохраняет исходные геометрии. Независимые `is_park`, `is_garden`, `is_vegetation` и формулы площади — в [методике анализа](../features/area-analysis.md). Подготовка и импорт с буфером — в [покрытии данных](../features/coverage.md).

## Что входит

| Набор | Теги | Представление |
|---|---|---|
| Зелень | `natural=wood,scrub,grassland,heath`; `landuse=forest,grass,meadow,village_green,orchard` | `vegetation_landuse`: картографическое описание растительного покрова/землепользования, не измерение текущей растительности |
| Парки и сады | `leisure=park,garden` | `recreation_boundary`: граница территории, которая может включать дорожки, здания и воду |
| Вода | `natural=water`; старые `waterway=riverbank`, `landuse=reservoir` | `water_area`: полигон воды по OSM |

При нескольких подходящих тегах основной `feature_type` / `representation` выбирается в порядке natural → landuse → leisure; все исходные теги сохраняются. Эти поля описывают первичный отбор, не исключающие друг друга продуктовые категории. Один OSM-объект не размножается по числу тегов. Сочетание wood+park получает оба независимых признака; park без растительного тега не становится растительной территорией. Ни один тег не является измерением текущего растительного покрова.

Деревья-точки, линии водотоков, поля, кладбища, спортивные площадки, бассейны и потенциально сухие `landuse=basin` не включаются автоматически. `area=no` отклоняется. Положительные lifecycle-теги (disused/abandoned/demolished/razed/construction/proposed) исключают объект. Сезонность, intermittent и доступ сохраняются; наличие контура не гарантирует постоянную воду или общественный доступ.

Это ограниченный список тегов, не доказательство полноты реальной зелени/воды. Правила основаны на документации OSM: [растительные типы и землепользование](https://wiki.openstreetmap.org/wiki/Land_use), [парки](https://wiki.openstreetmap.org/wiki/Tag:leisure=park), [водные площади](https://wiki.openstreetmap.org/wiki/Tag:natural=water). **Граница парка не равна доле растительности**; спутниковая история остаётся отдельным источником.

## Геометрия и обновления

- Уникальность в снимке: `(dataset_import_id, osm_type, osm_id)`, тип way/relation. Замкнутые ways и multipolygon обрабатываются существующим строгим сборщиком `OsmAddressGeometry`. Отверстия и несколько внешних колец сохраняются; недостающие, неоднозначные и вложенные элементы отклоняются с причиной, без snapping/repair.
- Хранение — непустая валидная 2D Polygon/MultiPolygon EPSG:4326, `lon,lat`. FK на журнал, исходные теги/узлы/состав relation, версия и время правки. GiST по geometry и выражению `geom::geography`.
- Подготовка PBF отбирает по bbox всей way/всего relation, включая многоугольник, полностью охватывающий город. Все части кандидата сохраняются; bbox не заменяет точный отбор. Laravel проверяет `ST_Intersects` с сохранённой городской границей.
- Пересекающие границу отбора площади остаются целыми с `crosses_boundary`/предупреждением. `--buffer-m` расширяет только область данных (по умолчанию 0; рабочие снимки с 20.10 — 1000 м), не территорию сервиса. Расчёты около границы требуют проверки достаточности доступного радиуса.
- Наложения и одинаковые геометрии разных OSM-объектов не удаляются. Backend-расчёт [площади](../features/area-analysis.md) объединяет пересечения с радиусом отдельно по независимым категориям. Контур парка и лес внутри него нельзя складывать как две порции зелени.
- Каждый набор публикуется независимо и атомарно. Advisory lock предотвращает конкурентную загрузку одного набора; сбой оставляет старый снимок активным и записывает неудачную попытку. Пустой набор не публикуется.
- Dry-run не меняет строки или журнал. Повтор успешного файла/конфигурации возвращает `skipped`, исторический снимок не реактивируется. Исчезнувшие объекты остаются в истории. Падение более 20% проверяется в целом и отдельно по представлениям; после разбора отчёта доступен `--allow-large-drop`.

## Воспроизведение

Используется тот же фиксированный [PBF Geofabrik](https://download.geofabrik.de/russia/siberian-fed-district-261018.osm.pbf), что для дорог: `data/raw/osm_pbf/2026-10-19-geofabrik/siberian-fed-district-261018.osm.pbf`. SHA-256: `25c716a36131aab2e99802feca29d44495b80303d37e1d46eddc2a36f211863e`. Версия заголовка `2026-10-18T20:25:06Z`; `observed_at=null`, дата версии не заменяет дату наблюдения. OSM — [ODbL / атрибуция](https://www.openstreetmap.org/copyright).

Одноразовый ETL image прежний: Python 3.12.15 / osmium 4.3.0; версии/хеши закреплены в `docker/etl`. Дополнительного Compose-сервиса нет. Подготовка не собирает полигон библиотекой с автоматическим ремонтом: она лишь сохраняет полный состав исходных элементов, сборку и валидацию выполняет Laravel/PostGIS.

```bash
docker build -t web-gis-osm-etl:local docker/etl

docker run --rm --network=none --memory=1536m --cpus=2 \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/scripts:/work/scripts:ro" -v "$PWD/data:/work/data" \
  web-gis-osm-etl:local python scripts/prepare-osm-areas.py \
  data/raw/osm_pbf/2026-10-19-geofabrik/siberian-fed-district-261018.osm.pbf \
  data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson \
  data/raw/osm_areas/2026-10-19-pbf \
  --expected-pbf-sha256=25c716a36131aab2e99802feca29d44495b80303d37e1d46eddc2a36f211863e \
  --source-url=https://download.geofabrik.de/russia/siberian-fed-district-261018.osm.pbf
```

Результирующий каталог должен быть новым; существующий не перезаписывается. Скрипт дважды проходит PBF: сначала метаданные отношений, затем координаты нужных ways. Временные SQLite и индекс координат находятся в каталоге результата и удаляются после завершения. Оборванный `.partial` не является успешным снимком. Манифест фиксирует хеши PBF/границы/скриптов, правила, версии, размер, время и пик RSS. Сырые файлы и отчёты не коммитятся.

Импорт выполняется в `php`; `--source-url` записывает происхождение, не обращается к сети:

```bash
docker compose exec php php artisan migrate

docker compose exec php php -d memory_limit=1024M artisan osm:import-areas green_areas \
  data/raw/osm_areas/2026-10-19-pbf/areas.json \
  --boundary=data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson \
  --source-url=https://download.geofabrik.de/russia/siberian-fed-district-261018.osm.pbf \
  --dry-run --report=data/reports/osm_area_import/2026-10-19/green_areas-dry-run.json
```

Добавить `--expected-sha256` из проверенного манифеста подготовленного JSON. Для воды заменить `green_areas` на `water` и имя отчёта. Для публикации убрать `--dry-run`, сохранить отдельный отчёт. Один общий файл служит входом обоих наборов; каждый импортер применяет свой отбор.

## Проверки

`docker compose exec php composer test:postgis` — только `web_gis_test`. Проверяются классификация всех тегов, разделение парков/растительных площадей, перекрытия без слияния, отверстия/несколько outer, невалидные и неполные контуры, граница с отверстием, атомарность, независимость наборов, dry-run, SHA/remark/повторы, уменьшение числа объектов и конкурентная блокировка. Обратимость миграции проверяется в изолированной тестовой схеме.

Python-фикстуры (без скачивания данных):

```bash
docker run --rm --network=none --memory=1536m --cpus=2 \
  --user "$(id -u):$(id -g)" -v "$PWD:/work:ro" \
  web-gis-osm-etl:local python -m unittest discover -s tests/etl -v
```

Проверяется сохранение всех частей/отверстий исходного relation, отсутствие outer-узлов внутри bbox при охвате города, отказ при потерянном member, контроль суммы и запрет перезаписи.
