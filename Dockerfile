# Each stage is keyed by only what it reads, so a deploy rebuilds only what changed (#915):
#   deps       every dependency, for the client build: the lockfile
#   prod-deps  the production node_modules: the lockfile (no prune after a build)
#   client     vite build + the service worker: the client's inputs (src/, public/, index.html, vite.config.ts,
#              tsconfig.json, scripts/build-sw.mjs) and the lockfile
#   runtime    the server's files, copied last: a server-only change rebuilds only that layer.
# There is no typecheck here: the land check typechecks every commit before it can deploy (#905).
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM deps AS client
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
COPY scripts/build-sw.mjs ./scripts/build-sw.mjs
RUN npx vite build && node scripts/build-sw.mjs

FROM node:24-bookworm-slim
# The remote alignment pool stages audio with ssh and scp.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=127.0.0.1 PORT=3001 DATA_DIR=/app/data
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --from=client --chown=node:node /app/dist ./dist
COPY --chown=node:node src/types.ts src/series-selection.ts src/appearance.ts src/reading-types.ts src/prepared-text-rules.ts ./src/
COPY --chown=node:node scripts/image-smoke.mjs ./scripts/image-smoke.mjs
COPY --chown=node:node server ./server
USER node
EXPOSE 3001
# Probed every second while the server starts, so `docker ps` says healthy within seconds of a swap.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --start-interval=1s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
