# A2: первичная проверка спутников и воздуха

Изолированный исследовательский прототип, выполнен 03.11.2026. Основное свидетельство и выводы — [отчёт](../../docs/research/source-feasibility.md); состояние задания — только [roadmap](../../docs/plans/roadmap.md#ближайшая-очередь). Код приложения/его API, рабочая БД, зависимости и инфраструктура не менялись. Это не production pipeline и не новый UI.

## Проверка радиометрии двух продуктов

Последующее узкое поручение выполнено 03.11.2026: [новое свидетельство](../../docs/research/sentinel-radiometry.md). Исходные JP2 и XML этих же продуктов подтвердили, что COG уже хранит DN−1000. Текущий analyze требует `--radiometry-evidence`; одного флага каталога недостаточно. Профиль привязан к полному product ID/baseline/asset URL и SHA-256 четырёх проверенных COG. Для других файлов правило автоматически не применяется. COG DN=1 неоднозначен после обрезания и возвращает неизвестное значение; 0 — отдельный nodata.

Новый run — `data/reports/source-feasibility/2026-11-03-radiometry-01/`. До загрузок зафиксированы 60 HTTP-запросов, 2 GiB исходных ответов, 150 MiB wheels и 3 GiB итогового хранения. Rasterio 1.4.3 / NumPy 2.2.6 установлены только в `python-libs` этого run, зависимости проекта не изменены. Точные исходные URL/status/размеры/hashes находятся в `requests.jsonl`, XML содержит BOA quantification/offset. Каналы 2024 доступны в `R10m`, хотя старые STAC href без этого сегмента возвращали 404.

Выполненные команды:

```bash
python3 -B experiments/source-feasibility/check_radiometry.py \
  --run data/reports/source-feasibility/2026-11-03-radiometry-01 \
  --previous data/reports/source-feasibility/2026-11-03-a2-01 \
  --attempt native-comparison-v2
python3 -B experiments/source-feasibility/analyze.py \
  --run data/reports/source-feasibility/2026-11-03-a2-01 \
  --output-root data/reports/source-feasibility/2026-11-03-radiometry-01 \
  --attempt corrected-diagnostics-v1 \
  --radiometry-evidence data/reports/source-feasibility/2026-11-03-radiometry-01/derived/native-comparison-v2/evidence.json
python3 -B experiments/source-feasibility/test_prototype.py -v
python3 -B experiments/source-feasibility/verify_radiometry.py \
  --run data/reports/source-feasibility/2026-11-03-radiometry-01
```

Команды обработки не перезаписывают существующие каталоги попыток: для повторения нужны новые имена. verify_radiometry привязан к сохранённой структуре этого run и пишет новый `evidence/radiometry-verification.json`; для повторной проверки нужен отдельный стенд/новый run, а не удаление свидетельства. В check_radiometry добавляется только локальный `python-libs`; источник читается Rasterio без resampling, исходные DN сопоставляются целочисленно на всей native-сетке. Код старого analyze/тестов/README сохранён в `evidence/prototype-before`.

Исправленный преобразователь описывает отдельно provider shift и XML product offset; повторная передача отражения как raw DN запрещена типом входа. Правильный NDVI подтверждён прямой формулой JP2 на вырезке, но не точность SCL/растительности на местности и не реальное изменение. К ежегодной композиции и другим сценам вывод не переносится. `diagnostics.py` оставлен как историческое сравнение гипотез первого А2, не принят как текущий способ выбора радиометрии.

## Растительность одного периода

Отдельный опыт 03.11.2026 — [распределение NDVI и кандидат площади](../../docs/research/vegetation-period.md). Новый run: `data/reports/source-feasibility/2026-11-03-one-period-01/`. Только лето 2024, восемь публичных центров, круги 200/1000 м, три даты; приложение/воздух/маршрутизация/межгодовые изменения не затрагиваются. Очередь — только roadmap, связанный выше.

Зафиксированы исходный бюджет и выборка, её RGB-уточнения и окончательный `sampling-frozen-v2.json` **до просмотра NDVI**. Имена T/H обозначают настройку/пространственно отложенные участки, не независимую истинную разметку. Один кандидат NDVI ≥ 0,30, чувствительность 0,20/0,40/0,50. Кандидат не принят как площадь растительности; неизвестная площадь не считается нулём и не экстраполируется. T-B оказался озеленённым ядром в городской среде, исходная гипотеза «застройка» не скрыта.

Изолированные NumPy/Rasterio из предыдущего радиометрического run переиспользуются через `sys.path`; новые пакеты/сервисы не устанавливаются. Новые JP2/XML подтверждают COG-преобразование **только в приобретённом native-окне** с hashes конкретных GeoTIFF-вырезок; прежнее полное свидетельство 15 августа переиспользуется. `period_radiometry.py` не запускает полный scan tile. Ни одна metadata flag сама по себе не разрешает offset. COG DN=1 исключён с отдельной причиной.

До загрузок установлены 65 исходящих запросов, 1 258 291 200 байт загрузки, 1,5 GiB хранения, 45 минут запросов/обработки, 90 минут всего опыта, ноль новых dependencies. `period_fetch.py` считает HEAD/GET/Range, сохраняет байты/headers/hashes и ошибки, запрещает перезапись, останавливает бюджет и отказывается от полного COG при неисполненном Range. `RangeBridge` — временный localhost-сервер только учёта HTTP для GDAL, не новый сервис приложения. Все raster-операции выполняет Rasterio/GDAL, ручного TIFF/JP2-декодера нет.

Принятые outputs: `derived/window-proof-v2`, `derived/method-v2`, `derived/summary-v1`, `figures/presentation-v1`. Начальные остановленные попытки сохранены. Поля `candidate_fraction_of_valid_*` делятся на **пригодную часть, включая воду**, `valid_fraction` — на весь сеточный круг. Геометрическая πr² и растеризованная площадь приведены отдельно; DN1 записан числом/долей, прочие причины взаимоисключающие. Численная корректность не подтверждает площадь, сезонную устойчивость или пользовательскую пользу.

Офлайн-повтор по сохранённым входам (новые имена обязательны; старые outputs не удалять):

```bash
python3 -B experiments/source-feasibility/period_analysis.py \
  --run data/reports/source-feasibility/2026-11-03-one-period-01 \
  --proof data/reports/source-feasibility/2026-11-03-one-period-01/derived/window-proof-v2/proof.json \
  --attempt method-replay-01
python3 -B experiments/source-feasibility/period_present.py \
  --run data/reports/source-feasibility/2026-11-03-one-period-01 \
  --attempt method-replay-01 --output-name presentation-replay-01
python3 -B experiments/source-feasibility/period_summary.py \
  --run data/reports/source-feasibility/2026-11-03-one-period-01 \
  --attempt method-replay-01 --output-name summary-replay-01
python3 -B experiments/source-feasibility/period_verify.py \
  --run data/reports/source-feasibility/2026-11-03-one-period-01 \
  --attempt method-replay-01 --proof-attempt window-proof-v2 \
  --presentation presentation-replay-01 --output-name numerical-replay-01.json
python3 -B experiments/source-feasibility/test_prototype.py -v
python3 -B experiments/source-feasibility/test_period.py -v
```

Арифметический verifier использует прямую формулу исходных JP2 DN, независимо агрегирует все 144 строки SQLite в памяти и сверяет площади/причины/hashes/PNG. Он учитывает неуспешный муниципальный запрос как ошибку доступа, а не как файл данных. Тесты не запускают приложение или рабочую БД. `period_present.py` рисует легенды и гистограммы из уже посчитанных чисел без повторного сканирования радиометрии.

Сетевой повтор требует отдельного поручения и нового каталога: `period_acquire.py --run <новый-run> --init-from <этот-run>` копирует зафиксированные metadata/выборку и создаёт новый бюджет с новой датой старта. Затем по порядку: `period_acquire.py --stage metadata`, `period_inputs.py --stage retained`, `period_inputs.py --stage scl` для оценки локальной пригодности; только при достаточной пригодности — `period_inputs.py --stage windows`, `period_acquire.py --stage references`, `period_radiometry.py --attempt window-proof-01`. Каждый вызов принимает `--run <новый-run>`. После этого — анализ/представление/summary/verify с новым proof и именами попыток, как выше. Точные source URL, параметры Range и hashes исходного опыта — в `requests.jsonl`; доступность и побайтовая неизменность сервера в будущем не гарантируются. Прежние А2/радиометрический run нужны для сохранённой сцены и изолированных библиотек; ignored-входы не появляются в чистом checkout автоматически.

## Окружение и входы

Использованы уже установленные Python 3.10, requests 2.25.1, Pillow 9.0.1/libtiff, системный DejaVu Sans и pdftotext для официального уведомления Sentinel. NumPy/rasterio/pyproj/Matplotlib не устанавливались; декодирование GeoTIFF — Pillow, численные проверки — стандартная библиотека. Проекция сверяется с географическим footprint/native raster источника до половины пикселя; это не геодезическая полевая проверка.

Конкретный запуск: `data/reports/source-feasibility/2026-11-03-a2-01/`. Большие входы ignored и не гарантируются в Git. `config.json` фиксирует площадку и пределы; `selected-scenes.json` — точные STAC items; `requests.jsonl` — URL/публичные параметры/статусы/размеры/hashes/время. Старые попытки `analysis-v1/v2/v3` и `air-v1` сохранены, принятые диагностические outputs — `analysis-v4`, `diagnostics-v1`, `air-v2`. Их границы определяет отчёт, не имя «analysis».

Некоторые исходные HTML/JS/config оператора содержат встроенные публичные ключи клиента; они остаются в ignored raw, значения исключены из manifest и отчёта. Архивный API 2.0 проверен без ключа. Не публиковать весь raw-пакет без отбора этих файлов. `.env` и личные запросы не читались.

## Повтор без сети

Команды из корня проекта, при наличии сохранённых входов. Каждая обработка требует **нового** имени попытки; существующие outputs не перезаписываются. Имена ниже — пример для следующего повтора, не дополнительный уже выполненный прогон:

```bash
python3 -B experiments/source-feasibility/analyze.py \
  --run data/reports/source-feasibility/2026-11-03-a2-01 --attempt analysis-replay-01 \
  --output-root data/reports/source-feasibility/2026-11-03-radiometry-01 \
  --radiometry-evidence data/reports/source-feasibility/2026-11-03-radiometry-01/derived/native-comparison-v2/evidence.json
python3 -B experiments/source-feasibility/air.py \
  --run data/reports/source-feasibility/2026-11-03-a2-01 --attempt air-replay-01
```

`diagnostics.py` читает геометрию/гипотезу исходного `analysis-v3` и создаёт `diagnostics-v1`; для уже обработанного запуска повторный вызов откажется писать поверх. Это зафиксированная структура первого опыта. Для новых принятых результатов использовать JP2-свидетельство и corrected-diagnostics; не трактовать старые гипотезы как исправленный алгоритм.

## Новый сетевой повтор

Только для отдельного порученного повтора опыта, с новым конечным каталогом. `replay.py` повторяет успешные публичные запросы из manifest, пропуская запросы с credential и неудавшиеся обращения. Точные scenes закреплены сохранёнными STAC items. Динамические метаданные/текущие таблицы на сервере могут измениться; побайтовый повтор всех HTTP-ответов не обещается, новые hashes фиксируются отдельно.

```bash
python3 -B experiments/source-feasibility/replay.py \
  --from-run data/reports/source-feasibility/2026-11-03-a2-01 \
  --to-run data/reports/source-feasibility/<новый-run-id>
```

В песочнице этого сеанса DNS/сеть были недоступны; разрешённые сетевые команды вне неё получили реальные данные. Обхода авторизации/ограничений источников не выполнялось. Повтор не требует запуска приложения или Compose. Предел загрузки 1 GiB и числа запросов проверяется fetch; время/ресурсы опыта контролировались исполнителем. Не запускать бесконечный подбор источников.

## Проверки и ограничения

```bash
python3 -B experiments/source-feasibility/test_prototype.py -v
python3 -B experiments/source-feasibility/verify.py \
  --run data/reports/source-feasibility/2026-11-03-a2-01
```

verify проверяет hashes/размеры raw, бюджеты запросов, независимую агрегацию статистики кругов через SQLite **в памяти**, исходные значения воздуха/сохранение нулей/неизвестного часового пояса и декодирование PNG. Никакой рабочей БД нет. `evidence/verification.json` создаётся исключительно новым; повтору нужна копия стенда или новый run, не удаление старого свидетельства.

Численная сходимость не подтверждает растительность, точность облачной маски, изменение на местности или калибровку станций. На первичном А2 конфликт радиометрии не разрешался выбором удобной гипотезы. После описанного выше сравнения JP2 повторный offset исправлен для точных проверенных файлов; старые карты сохранены, новые разности остаются диагностикой. Независимые датированные изменившиеся/неизменившиеся контроли не установлены. Временные метки воздуха без timezone остаются исходными строками, UTC — null. Нет интерполяции загрязнения, причин выбросов, процента зелени или пользовательского рейтинга.

Изображения/кропы содержат модифицированные Copernicus Sentinel data 2024, 2026, полученные через Element 84 Earth Search. Условия и атрибуция — в отчёте и сохранённом официальном уведомлении. Данные воздуха — [air.krasn.ru](https://air.krasn.ru/), КНЦ СО РАН.
