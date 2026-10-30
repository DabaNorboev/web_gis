---
status: current
updated: 2026-10-27
verified: not verified
replaces: local-routing-integration-2026-10-21.md
---

# Локальный автомобильный runtime: подготовка и запуск

Извлечены действующие инструкции подготовки из протокола интеграции; маршрутизация заново не запускалась. Выбор режима и пользовательские обещания — [trips](../features/trips.md), пеший runtime — [walking-backend](../features/walking-backend.md), обычный запуск — [runbook](../runbook-local.md).

## Ограничения ресурсов и изоляция

`docker-compose.routing.yml` дополняет основной Compose: пятый, только
опциональный сервис `local-router`. Он не требует изменения `.env`.
Router подключён только к сети `routing` с `internal:true`, портов хоста нет;
из приложения к нему обращается PHP по фиксированному hostname. Корневая ФС,
данные и startup script read-only, capabilities сняты, no-new-privileges.
2 CPU, один worker, RAM 1 GiB, swap запрещён. Фактическая историческая проверка изоляции сохранена в протоколе; при переносе она не повторялась.

Provider: connect timeout 0,5 с, полный запрос 1,5 с, максимум ответа 1 MB,
без редиректов/сжатия и выбора внешнего URL. Линия до 10 000 точек, до 40 км,
annotations до 30 000 узлов. Ограничены также поток чтения/декодирование ответа.
Отдельные read-only SQL-транзакции имеют statement_timeout 1500 мс.
Guard-загрузка ограничена 2000 ячейками, 12 MB сырого JSON, 50 000 features,
8 MB на tile и оценкой доступной PHP-памяти; недостающий/изменённый файл — UNKNOWN,
не «препятствий нет». Исторический опыт использовал PHP memory_limit=128M; это не новый замер.
Общий клиентский deadline 20 с, ввод отменяет запрос и очищает старые линии.

Startup проверяет закреплённые SHA manifest, списка графа и всех его файлов;
provider проверяет manifest и каждую прочитанную guard-ячейку. В OSRM 5.27.1
минимальное допустимое `max-viaroute-size` и `max-matching-size` — 3;
provider при этом отправляет только пары. Table limit 16 не является публичным
матричным API приложения. OSRM работает с verbosity WARNING без координатных
query-логов.

## Воспроизведение и запуск

Источники и общий PoC — [методика](../../experiments/local-routing-poc/README.md).
Новая геодата не скачивалась, системные зависимости не устанавливались.
Сохранённый региональный PBF:
`data/raw/osm_pbf/2026-10-19-geofabrik/siberian-fed-district-261018.osm.pbf`,
SHA `25c716a36131aab2e99802feca29d44495b80303d37e1d46eddc2a36f211863e`.
Общий extract SHA
`7b6233984c6246db014fa8d85461d7a2f33405261410f040612e0380a1c1089d`.
Образ OSRM 5.27.1 закреплён:
`ghcr.io/project-osrm/osrm-backend@sha256:855614a38f464b0558a2ad6eaa7cb8c139f39887da9b38b485ce453c6e6e6124`,
штатный `/opt/car.lua` и библиотеки внутри того же образа, MLD.
PHP-конфигурация — `config/routing.php`, параметры процесса —
`docker/routing/start.sh`; меняющий граф/guard набор требует новой версии и pins.

Runtime находится в `data/prepared/local-routing/osrm-car-20261021-v1`:
граф ~34 MB, 5815 guard-ячеек, суммарно 226 292 796 байт.
Guard-данные: контекст того же PBF и read-only экспорт существующих
81 491 здания / 263 водных геометрий внутри bbox; service geometry и
исходные import ID/хеши сохранены в `manifest.json`.
SHA manifest: `cd62979bb110e446addd6c4221e731990b7e553a679a85921562b9ed557683cc`;
SHA `graph.sha256`: `6b4b314f72190f18c85ad9950bf8a9ba4dc57ad19688997147a8610c0a369680`.
`data/` игнорируется Git: чистый checkout сам по себе не содержит runtime,
новый запуск не должен молча скачивать данные или собирать другой граф.

При наличии проверенного локального снимка:

```bash
docker compose -f docker-compose.yml -f docker-compose.routing.yml up -d --no-build --wait --wait-timeout 30 php local-router
```

Открыть `/trips`. Если router выключен или снимок отсутствует/изменён, страница
даёт явный отказ; базовые функции не зависят от него. Проверка источников
не требует миграций и не меняет рабочие таблицы.

Для точного повторения подготовки использовать сохранённые
`data/reports/local-routing-2026-10-21/` и
`data/reports/local-routing-integration-2026-10-21/guard-export/`.
`scripts/prepare-routing-runtime.py` — стандартная библиотека Python 3.12,
без сети/БД, проверяет входные хеши и отказывается писать в существующий каталог:

```bash
python3 scripts/prepare-routing-runtime.py \
  --guards data/reports/local-routing-integration-2026-10-21/guard-export \
  --output /tmp/placelens-routing-new-replay \
  --prepared-at 2026-10-20T17:46:49.033379+00:00
```

Python должен быть в подходящем ETL-контейнере; здесь команда показывает
аргументы для уже доступного runtime, установка на хост не требуется.
Побайтовое совпадение SHA подтверждено отдельно на Python 3.12-slim с
network=none/read-only (`runtime-replay-python312.json`). Рабочий каталог
при повторении не перезаписывать. `export-routing-guards.php` предназначен
только для явно нового snapshot: требует PGOPTIONS read-only и нового output,
а не выполняется на каждом HTTP-запросе. Обновление данных — отдельная проверка.

Полный исходный протокол сохранён в [истории](../history/local-routing-integration-2026-10-21.md); читать только по прямому указанию.
