FROM node:22.22.0-bookworm-slim

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu=1.14-1+b10 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY dashboard ./dashboard
COPY --chmod=0755 docker/basis-entrypoint.sh /usr/local/bin/basis-entrypoint.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/basis.db \
    AUDIT_PATH=/data/audit.jsonl

RUN mkdir -p /data && chown -R node:node /app /data
USER root
ENTRYPOINT ["/usr/local/bin/basis-entrypoint.sh"]
EXPOSE 3000

CMD ["node", "--experimental-strip-types", "src/api/server.ts"]
