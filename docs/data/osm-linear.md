---
status: current
updated: 2026-11-04
verified: not verified
---

# Локальные дороги и железная дорога OSM

Две независимые таблицы `osm_roads` / `osm_railways`, одна офлайн-команда `osm:import-linear roads|railways`. Показатели и слои описаны в [контракте линий](../features/map-linear-layers.md). Подготовка и импорт с буфером — в [покрытии данных](../features/coverage.md).

## Отбор и ограничения

- Дороги: только `highway=motorway|trunk|primary|secondary`, как согласовано для крупных дорог. Остальные улицы, дворовые проезды, тротуары и `*_link` не входят.
- Железная дорога: `railway=rail|narrow_gauge`. Трамваи, платформы и маршрутные relations не входят. Теги `disused`, `abandoned`, `demolished`, `razed`, `construction`, `proposed` с положительным значением исключают объект; отсутствие таких тегов не подтверждает эксплуатацию.
- Единица хранения — исходная OSM way, а не улица, маршрут или уникальный физический путь. Две проезжие части/соседние рельсовые пути сохраняются отдельно. Число ways не является пользовательским показателем обеспеченности дорогами.
- Геометрия — полный исходный `LineString`, 2D EPSG:4326, порядок `lon,lat`. Узлы, порядок координат, `bridge`, `tunnel`, `layer`, `access` и остальные теги сохраняются. Пересечения линий не превращаются в соединения; маршрутизация не реализуется.
- Предварительный bbox только уменьшает набор кандидатов. Окончательный отбор — `ST_Intersects` с областью данных, вычисленной из сохранённой сервисной границы и `--buffer-m` (по умолчанию 0; для буферных снимков — 1000 м). Пересекающие границу отбора линии не обрезаются, получают `crosses_boundary` и предупреждение. Сервисная территория не расширяется; достаточность покрытия радиуса проверяется отдельно.
- Геометрии не ремонтируются; пропуски имеют причину. Нехватка узлов при подготовке PBF останавливает подготовку целиком, разрывы не соединяются. Пустой импорт не публикуется.

## Исходник

Для воспроизведения используется фиксированный [экстракт Geofabrik](https://download.geofabrik.de/russia/siberian-fed-district-261018.osm.pbf). Исходные данные — OpenStreetMap, лицензия [ODbL / атрибуция](https://www.openstreetmap.org/copyright).

| Параметр | Значение |
|---|---|
| PBF | `data/raw/osm_pbf/2026-10-19-geofabrik/siberian-fed-district-261018.osm.pbf` |
| Размер / SHA-256 PBF | 587 534 856 байт / `25c716a36131aab2e99802feca29d44495b80303d37e1d46eddc2a36f211863e` |
| Версия из заголовка PBF | `2026-10-18T20:25:06Z` |
| Подготовленный JSON | `data/raw/osm_linear/2026-10-19-pbf-disk/linear.json`, 2 565 193 байта |
| SHA-256 JSON | `773b5d2b3ed1064ea3101d5cf7e49a3c56118c820ecf1873d532ba387c486067` |
| Наблюдение | `observed_at=null`: версия базы не является датой натурного наблюдения |

## Подготовка PBF

Подготовка выполняется в одноразовом контейнере без сети. Runtime: Python 3.12.15, osmium 4.3.0; официальный Python image закреплён digest в `docker/etl/Dockerfile`, зависимости — версиями/хешами в `requirements.txt` (проверено Linux amd64). API pyosmium: [обработчики и индексы координат](https://docs.osmcode.org/pyosmium/latest/reference/Handler-Processing/).

PBF предварительно скачать по фиксированной ссылке, сверить SHA-256 выше; наш Laravel-импортер ничего не скачивает. Сохранённая граница: `data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson`, SHA-256 `0a631518e68855b2eba44a72429b9a11fa95e0de075c013f523eafa4b84ef5f8`. Команды из корня проекта:

```bash
docker build -t web-gis-osm-etl:local docker/etl

docker run --rm --network=none --memory=1g --cpus=2 \
  --user "$(id -u):$(id -g)" -v "$PWD:/work:ro" \
  web-gis-osm-etl:local python -m unittest discover -s tests/etl -v

docker run --rm --network=none --memory=1g --cpus=2 \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/scripts:/work/scripts:ro" -v "$PWD/data:/work/data" \
  web-gis-osm-etl:local python scripts/prepare-osm-linear.py \
  data/raw/osm_pbf/2026-10-19-geofabrik/siberian-fed-district-261018.osm.pbf \
  data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson \
  data/raw/osm_linear/2026-10-19-pbf-disk \
  --expected-pbf-sha256=25c716a36131aab2e99802feca29d44495b80303d37e1d46eddc2a36f211863e \
  --source-url=https://download.geofabrik.de/russia/siberian-fed-district-261018.osm.pbf
```

Каталог результата должен быть новым: скрипт отказывается перезаписывать существующий. Для воспроизведения использовать другой путь. JSON сохраняется после полного прохода; успешный манифест фиксирует хеши PBF/границы/скрипта, версии, длительность и пик памяти. При ошибке `.partial` не является пригодным снимком.

Замеры одной локальной подготовки, без нагрузки: 116,19 с; peak RSS Python 938 992 КиБ (~917 МиБ), ограничение контейнера 1 ГиБ / 2 CPU. Дисковый индекс координат занимал около 1,6 ГБ и удалён после обработки; предусмотреть несколько ГБ свободного места сверх PBF. Первоначальный запуск с кэшем в памяти завершился OOM и ничего не опубликовал; рабочая команда использует `sparse_file_array`. Это не оценка производительности на всём городе для остальных слоёв.

## Импорт и обновления

```bash
docker compose exec php php artisan migrate

docker compose exec php php artisan osm:import-linear roads \
  data/raw/osm_linear/2026-10-19-pbf-disk/linear.json \
  --boundary=data/raw/boundaries/krasnoyarsk/2026-10-07/boundary.geojson \
  --source-url=https://download.geofabrik.de/russia/siberian-fed-district-261018.osm.pbf \
  --expected-sha256=773b5d2b3ed1064ea3101d5cf7e49a3c56118c820ecf1873d532ba387c486067 \
  --dry-run --report=data/reports/osm_linear_import/2026-10-19/roads-dry-run.json
```

Для железной дороги заменить `roads` на `railways` и имя отчёта. После проверки опубликовать без `--dry-run`, с отдельным отчётом. Dry-run не меняет предметные строки и журнал; `source-url` только записывает происхождение. Текущий файл требует около 56 МиБ пикового PHP-потребления, dry-run каждого набора занял около 0,3 с.

Публикация набора атомарна; advisory lock запрещает одновременную загрузку того же набора. Снимки roads и railways независимы: ошибка одного не переключает другой. Контрольная сумма и стабильная конфигурация определяют повтор. Сбой оставляет прежний снимок активным, попытка становится `failed`. Исторический повтор не реактивируется; исчезнувшие объекты остаются в истории. Падение числа объектов более 20% требует проверки dry-run и явного `--allow-large-drop`.

## Проверки

`docker compose exec php composer test:postgis`: отдельная `web_gis_test`. Проверяются ограничения и индексы, раздельные наборы, отбор/жизненный цикл, уровни без соединения, неполные геометрии, граница с отверстиями, dry-run, повторы/история, защита уменьшения, откат публикации и CLI. Обратимость миграции проверяется только в изолированной тестовой схеме. Python-тесты проверяют подготовку на маленьких синтетических OSM-фикстурах без скачивания реальных данных.

Подготовка зелени и воды — [отдельный runbook](osm-areas.md).
