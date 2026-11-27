# bored? — runs on Raspberry Pi (arm64 / armv7) and x86
FROM node:22-alpine

ARG APP_VERSION=dev
ARG BUILD_DATE=
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    APP_VERSION=${APP_VERSION} \
    BUILD_DATE=${BUILD_DATE}

# pick up the latest Alpine security patches on every build (CI rebuilds weekly too)
RUN apk upgrade --no-cache

WORKDIR /app
COPY package.json server.js score.js ./
COPY public ./public
# Pi setup files, so the Pi can pull them straight out of the image
COPY pi ./pi

RUN mkdir -p /data && chown node:node /data && chmod 700 /data \
    && chmod -R a-w /app
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "--disallow-code-generation-from-strings", "server.js"]
