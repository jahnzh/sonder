FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
# The remote alignment pool stages audio with ssh and scp.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOST=127.0.0.1 PORT=3001 DATA_DIR=/app/data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/scripts/image-smoke.mjs ./scripts/image-smoke.mjs
COPY --from=build --chown=node:node /app/src/types.ts ./src/types.ts
COPY --from=build --chown=node:node /app/src/series-selection.ts ./src/series-selection.ts
COPY --from=build --chown=node:node /app/src/appearance.ts ./src/appearance.ts
COPY --from=build --chown=node:node /app/src/reading-types.ts ./src/reading-types.ts
COPY --from=build --chown=node:node /app/src/prepared-text-rules.ts ./src/prepared-text-rules.ts
COPY --from=build --chown=node:node /app/package.json /app/tsconfig.json ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
