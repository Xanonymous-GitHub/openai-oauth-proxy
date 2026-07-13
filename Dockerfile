# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.build.json ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY config ./config
RUN bun run protocol:generate && bun run build

FROM --platform=$BUILDPLATFORM oven/bun:1-alpine AS prod-deps
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock ./
RUN case "$TARGETARCH" in amd64) BUN_CPU=x64 ;; arm64) BUN_CPU=arm64 ;; *) exit 1 ;; esac \
    && bun install --frozen-lockfile --production --cpu="$BUN_CPU" --os=linux \
    && test -x node_modules/@openai/codex-linux-$BUN_CPU/vendor/*/bin/codex

FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    CODEX_HOME=/data/codex \
    PATH=/app/node_modules/.bin:$PATH
WORKDIR /app
RUN addgroup --gid 10001 app \
    && adduser -D -H -u 10001 -G app -h /nonexistent -s /sbin/nologin app \
    && mkdir -p /data /tmp/work /tmp/response-operations \
    && chown 10001:10001 /data /tmp/work /tmp/response-operations \
    && chmod 0700 /data /tmp/work /tmp/response-operations
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
RUN chmod -R a-w /app \
    && chmod 0555 /app/config /app/config/codex \
    && chmod 0444 /app/config/codex/config.toml /app/config/codex/neutral-instructions.md
USER 10001:10001
EXPOSE 8080 8081
ENTRYPOINT ["node", "dist/main.js"]
