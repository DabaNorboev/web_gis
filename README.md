# Web GIS

Сервис анализа адресов Красноярска: окружение дома и изменения территории по историческим спутниковым данным. Сейчас подготовлено локальное окружение; интерфейс и импорты данных находятся в разработке.

**Стек:** Laravel 13, PHP 8.4, PostgreSQL 16 / PostGIS 3.4, Vue 3, TypeScript, Vite, MapLibre GL JS, ECharts. Окружение — Docker Compose и Nginx.

## Первый запуск

Нужны Docker и Docker Compose v2. Команды выполнять из корня проекта.

```bash
cp .env.example .env
```

Настроить параметры БД в `.env`. На Linux при необходимости указать `LOCAL_UID` и `LOCAL_GID` по значениям `id -u` и `id -g`.

Для нового окружения:

```bash
docker compose up -d --build
docker compose exec php composer install
docker compose exec php php artisan key:generate
docker compose exec php php artisan migrate
docker compose exec node npm ci
docker compose exec node npm run build
```

Приложение: [http://localhost](http://localhost). Существующий `.env` не перезаписывать; ключ генерировать только при пустом `APP_KEY`.

## Разработка

```bash
docker compose up -d
docker compose exec node npm run dev
```

Vite запускается в отдельном терминале. Приложение открывается через Nginx на `http://localhost`.

База для IDE: `127.0.0.1:54325`, учётные данные — из `.env`. Laravel подключается к `db:5432`. Все опубликованные порты доступны только локально.

## Проверки

```bash
docker compose exec php composer test
sh scripts/init-test-db.sh
docker compose exec php composer test:postgis
docker compose exec node npm run build
```

Обычные тесты используют SQLite в памяти, PostGIS-тесты — отдельную базу `web_gis_test`. CI также проверяет миграции на PostgreSQL.

## Остановка

```bash
docker compose stop
```

Данные БД сохраняются в volume `postgres_data`.
