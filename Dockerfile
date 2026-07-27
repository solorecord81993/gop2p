# syntax=docker/dockerfile:1

# KataGo is downloaded during the image build instead of being committed to
# GitHub. Both the engine archive and network are pinned and checksum-verified.
FROM debian:bookworm-slim AS katago

ARG KATAGO_VERSION=1.16.5
ARG KATAGO_ARCHIVE=katago-v1.16.5-eigen-linux-x64.zip
ARG KATAGO_ARCHIVE_SHA256=61401d4ddabb4255f67b63e405a9f730426d5b38b5b72a519a9a02c2139ea05b
ARG KATAGO_MODEL=kata1-b15c192-s449394432-d140458288.txt.gz
ARG KATAGO_MODEL_SHA256=751504d8f818b91eb5c8008e79a0a66526122d3fdc1250fa4857f49e874e046f

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/katago-build

RUN curl --fail --location --retry 4 \
      --output katago.zip \
      "https://github.com/lightvector/KataGo/releases/download/v${KATAGO_VERSION}/${KATAGO_ARCHIVE}" \
    && echo "${KATAGO_ARCHIVE_SHA256}  katago.zip" | sha256sum --check --strict \
    && unzip -q katago.zip katago \
    && chmod +x katago \
    && ./katago --appimage-extract >/dev/null \
    && mkdir -p /opt/katago \
    && mv squashfs-root /opt/katago/runtime \
    && ln -s runtime/AppRun /opt/katago/katago

RUN curl --fail --location --retry 4 \
      --output /opt/katago/model.txt.gz \
      "https://media.katagotraining.org/uploaded/networks/models/kata1/${KATAGO_MODEL}" \
    && echo "${KATAGO_MODEL_SHA256}  /opt/katago/model.txt.gz" | sha256sum --check --strict

FROM node:24-bookworm-slim AS app

ENV NODE_ENV=production \
    KATAGO_BIN=/opt/katago/katago \
    KATAGO_MODEL=/opt/katago/model.txt.gz \
    KATAGO_CONFIG=/app/katago/analysis.cfg \
    KATAGO_MAX_VISITS=32 \
    KATAGO_ROOT_SYMMETRIES=1 \
    KATAGO_TIMEOUT_MS=120000 \
    KATAGO_RETRY_COOLDOWN_MS=30000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node . .
COPY --from=katago /opt/katago /opt/katago

USER node

EXPOSE 3000

CMD ["node", "server.js"]
