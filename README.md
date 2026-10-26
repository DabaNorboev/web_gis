# PlaceLens

PlaceLens помогает сравнить выбранные адресные объекты в Красноярске по локальным данным об окружении и подготовить вопросы к просмотру жилья. Анализ доступен без аккаунта. Технический сценарий реализован; его добавочная польза для людей, выбирающих жильё, ещё проверяется.

Работают поиск/явный выбор объекта, профиль, сравнение пары, остановки по точке, слои карты и темы интересов. Поездки доступны как ограниченный автомобильный пилот — отдельно и к общим личным местам сравнения. Подбор территории, входы/доступ, актуальные пробки, аккаунт и объявления не являются готовыми возможностями.

[Карта документации](docs/README.md) · [Границы продукта](docs/product.md) · [Архитектура](docs/architecture.md) · [Проверки](docs/testing.md) · [Roadmap](docs/roadmap.md) · [Гипотезы](docs/product-hypotheses.md)

Планирование на 26.10.2026: [датированный снимок состояния](docs/current-state.md), [видение и согласованные вводные](docs/project-vision.md), [ограничения](docs/project-constraints.md), [план E0–E8](docs/roadmap.md). Целевой сценарий для покупателей с пешим и автомобильным режимами ещё не реализован; текущий автомобильный пилот сохраняет свой контракт.

## Стек и сервисы

PHP 8.4 / Laravel 13, PostgreSQL 16 / PostGIS 3.4, Vue 3 / TypeScript 6, Vite, MapLibre, Tailwind CSS 4 и shadcn-vue. Python ETL — одноразовая офлайн-подготовка, без постоянного сервиса. Точные зависимости — manifests/lock, версии контейнеров — Compose/Dockerfile; установленный пакет не означает реализованную функцию.

Базовые четыре сервиса: nginx, php, node, db. Nginx 80, Vite 5173 и БД 54325 опубликованы только на loopback. PHP использует `db:5432`; для IDE — `127.0.0.1:54325`, учётные данные из локального `.env`. Node-зависимости контейнера хранятся в named volume.

## Первый запуск нового окружения

Нужны Docker и Compose v2. Команды выполнять из корня. Этот раздел относится к новому окружению: существующие `.env`, APP_KEY и volumes не заменять.

```bash
test -f .env || cp .env.example .env
```

Настроить параметры БД в локальном `.env`; на Linux при необходимости LOCAL_UID/LOCAL_GID по `id -u`/`id -g`. Новый checkout не содержит подготовленного графа OSRM, поэтому сначала использовать только базовый compose:

```bash
docker compose -f docker-compose.yml up -d --build
docker compose exec php composer install
```

Только если APP_KEY пустой — `docker compose exec php php artisan key:generate`. Для новой БД применить миграции, затем установить/собрать frontend от пользователя node:

```bash
docker compose exec php php artisan migrate
docker compose exec node npm ci
docker compose exec node npm run build
```

Миграции и установка меняют окружение; это не диагностические команды для уже работающего экземпляра. Без локального импорта профиль/поиск не получают выдуманных данных: подготовка наборов описана в [runbooks](docs/README.md#runbooks-данных-и-принятые-технические-решения).

Приложение: [localhost](http://localhost); health endpoint — `/up`. Готовность окружения проверяется по [testing](docs/testing.md), а не только по статусу контейнеров.

## Разработка и автомобильный пилот

В существующем окружении с готовым routing runtime обычный Compose автоматически читает относительный симлинк `docker-compose.override.yml` → `docker-compose.routing.yml`:

```bash
docker compose up -d
docker compose exec node npm run dev
```

Vite работает в отдельном терминале, без `--host`; приложение открывается через Nginx. Обычный запуск сохраняет общую routing-сеть PHP/OSRM. Router не имеет опубликованного порта и использует закреплённый локальный выпуск read-only.

Для намеренного запуска базового контура: `docker compose -f docker-compose.yml up -d`. Он исключает routing-сеть PHP; расчёт поездок будет недоступен до запуска с override, локальное окружение/остановки сохраняют свой сценарий. Менять `.env` или COMPOSE_FILE для выбора режима не нужно.

[Поездки и ограничения](docs/trips.md) · [Подготовка runtime и запуск](docs/local-routing-integration-2026-10-21.md). Не создавать runtime автоматически из HTTP и не удалять связанные отчёты/источники подготовки.

Пеший режим `/trips` и `/compare` имеет отдельный закреплённый ORS runtime.
Он считает только уличную часть; подходы от объектов остаются неизвестными.
При наличии проверенного пешего снимка
добавить opt-in override явно:

```bash
docker compose -f docker-compose.yml -f docker-compose.routing.yml -f docker-compose.walking.yml up -d --no-build --wait --wait-timeout 120 php local-router local-walking
```

Эта команда может запустить обычный db по зависимости PHP; это команда запуска
подготовленного окружения, не read-only проверка. Базовый Compose и существующий
override-симлинк не изменены. Внешний ORS API и ключ не используются. Подготовка
снимка, контракт `walking`, пределы и свежие проверки — [пеший backend](docs/walking-backend.md).

Интерактивные оболочки при необходимости: `docker compose exec php bash`, `docker compose exec node bash`. UI-компоненты добавляются только в node: [frontend conventions](docs/frontend-structure.md).

## Проверки

[docs/testing.md](docs/testing.md) — основное место команд, требований и побочных эффектов. Обычные frontend-команды: `docker compose exec node npm run typecheck`, `docker compose exec node npm test`; browser smoke — `docker compose exec node npm run test:smoke` после [подготовки Chromium](docs/browser-smoke.md).

PHP: `docker compose exec php composer test`; GIS: `docker compose exec php composer test:postgis` **только** с защищённой `web_gis_test`. Создание этой БД и особенности READ ONLY описаны в testing. Composer-обёртки очищают config, build меняет опубликованные assets, browser smoke пишет отчёты. Для задачи только на документацию полный запуск не требуется.

## Остановка

```bash
docker compose stop
```

Данные БД остаются в volume `postgres_data`. Остановка не является очисткой volumes, исходников или routing runtime.
