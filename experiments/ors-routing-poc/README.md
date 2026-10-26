# ORS: пеший, затем автомобильный эксперимент

Статус: локальные прогоны выполнены 26.10.2026; итог и ограничения —
[REPORT.md](REPORT.md). Это исследовательский код, приложение и его текущий
автомобильный provider не переключены на ORS.

После этого выполнена отдельная ревизия checker на неизменённых ответах:
[последовательный план](REVISION-PLAN.md), [результат до/после](REVISION-RESULT.md).
Первый REPORT и v1 checker сохранены как история. Актуальный экспериментальный
checker — `revision_review.py`; приложение по-прежнему использует прежний provider.

## Этапы и границы

1. Закрепить исходное дерево, входы и прежние публичные контрольные пары.
2. Построить только `foot-walking`, получить полную геометрию, snaps и диагностику.
3. Остановить первый контейнер, отдельно построить `driving-car` на том же PBF.
4. Проверить полные линии по исходным сегментам, доступу и препятствиям offline.
5. Зафиксировать ресурсы, ограничения и решение о необходимости продолжения.

Сохранены исходные координаты, пределы 20/35 м и геометрический допуск 0,25 м.
Здание не становится входом, выбранный улицей старт не становится адресом.
Внешний API, рабочая БД, `.env`, Compose, опубликованные assets и текущие графы
не используются для записи. Высоты отключены явно; новое геоданное не скачивается.
Отсутствие наблюдаемой даты остаётся неизвестным. ORS `osm_date=1970-01-01`
в этом производном PBF не является датой наблюдения или доказанной свежестью.

## Воспроизведение

Нужны Docker, Python 3 на хосте и сохранённые ignored-входы из `freeze.json`.
Один новый профиль ограничен 2 CPU / 3 GiB без swap, Java heap 2 GiB,
ожидание готовности — до 10 минут. Это бюджет **этого** эксперимента,
отличающийся от исторического бюджета OSRM/Valhalla; сравнение ресурсов
разных прежних запусков не является одинаковым benchmark.

Закреплённый образ:

```text
heigit/openrouteservice@sha256:e63d4df17a8df5fa1c0432c27b0c361be33e6f21a7b28496e97b6434b5954ce1
```

Для нового повтора выбрать отсутствующий каталог `data/reports/ors-replay-N`.
Создать его и скопировать **только** `freeze.json` из сохранённого прогона;
он закрепляет входы и историческое начальное дерево, а не новое текущее состояние.
Если нужны новые данные/координаты — сначала оформить отдельную версию выборки.
Драйвер проверит входные SHA и откажется перезаписывать профиль.

```bash
python3 -B experiments/ors-routing-poc/run.py walking --output data/reports/ors-replay-N
python3 -B experiments/ors-routing-poc/run.py driving --output data/reports/ors-replay-N
```

Контейнеры запускаются последовательно, `network=none`, без опубликованных портов;
helper использует только network namespace соответствующего ORS. Writable mount
ограничен новым каталогом профиля, исходный PBF монтируется read-only.
Драйвер останавливает только созданные им контейнеры, графы и raw-ответы сохраняет.
Он может скачать отсутствующий образ Docker по digest; выполненный первый прогон
предварительно скачал релизный образ и сверил digest. Образы не удаляются попутно.

После завершения отдельно вывести tagged nodes в **новый** файл:

```bash
docker run --rm --network=none --read-only --memory=256m --memory-swap=256m --cpus=1 \
  --user 1000:1000 \
  -v "$PWD/data/reports/local-routing-2026-10-21/prepared/pilot.osm.pbf:/input/pilot.osm.pbf:ro" \
  -v "$PWD/experiments/ors-routing-poc:/experiment:ro" \
  web-gis-osm-etl:local python -B /experiment/extract_nodes.py \
  > data/reports/ors-replay-N/nodes.jsonl
python3 -B experiments/ors-routing-poc/review_ors.py --source "$PWD" \
  --output data/reports/ors-replay-N --mode walking
python3 -B experiments/ors-routing-poc/review_ors.py --source "$PWD" \
  --output data/reports/ors-replay-N --mode driving
```

Перенаправление shell само не защищает существующий nodes.jsonl: перед командой
проверить отсутствие файла либо использовать `set -C` в отдельном shell.
`review.json`/CSV открываются только в режиме создания. Происхождение offline
кода и его ограничения описаны в [PROVENANCE.md](PROVENANCE.md).

Проверки самого экспериментального адаптера и отказов драйвера:

```bash
python3 -B -m unittest discover -s experiments/ors-routing-poc -p 'test*.py' -v
git diff --check
```

Успешный `directions` — наличие модельной линии. `MODEL_GEOMETRY_CONSISTENT` —
лишь согласованность с неполной исходной моделью; пользовательские метры/секунды
в review остаются null. Matrix и isochrones в raw-файлах проверяют доступность
API, не являются проверенными поездками или территорией поиска жилья.
