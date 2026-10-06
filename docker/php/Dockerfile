FROM php:8.4-fpm-bookworm

ARG UID=1000
ARG GID=1000

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libicu-dev \
        libpq-dev \
        libzip-dev \
        git \
        unzip \
    && docker-php-ext-install -j$(nproc) \
        intl \
        zip \
        pgsql \
        pdo_pgsql \
        opcache \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

RUN groupadd -g ${GID} www \
    && useradd -u ${UID} -m -s /bin/bash -g www www

WORKDIR /var/www/html

USER www
