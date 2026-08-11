FROM node:22.22.0-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/basis.db \
    AUDIT_PATH=/data/audit.jsonl

RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3000

CMD ["node", "--experimental-strip-types", "src/api/server.ts"]
