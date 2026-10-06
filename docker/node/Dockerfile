FROM node:22-bookworm-slim

ARG UID=1000
ARG GID=1000

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        git \
    && rm -rf /var/lib/apt/lists/*

RUN groupmod -g ${GID} node \
    && usermod -u ${UID} -g ${GID} node

WORKDIR /var/www/html

RUN mkdir -p /var/www/html/node_modules \
    && chown node:node /var/www/html/node_modules

USER node

CMD ["sleep", "infinity"]
