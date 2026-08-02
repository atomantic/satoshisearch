# satoshisearch — single Node container (SvelteKit adapter-node).
# node:sqlite (zero native DB deps) needs Node >= 22; use 22 LTS.
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
# node:sqlite is behind a flag on Node 22.
ENV NODE_OPTIONS=--experimental-sqlite
WORKDIR /app

# App code, production deps, vendored datasets, and the worker (loaded at runtime).
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/datasets ./datasets
COPY --from=build /app/src/lib/server/grinder/worker.mjs ./build/worker.mjs

# Persisted DB + vault live here; mounted as a volume by Umbrel.
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data

EXPOSE 3117
CMD ["node", "build/index.js"]
