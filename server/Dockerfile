# better-sqlite3 ships prebuilt binaries for most platforms but falls back to a
# source build, so the toolchain has to exist in the build stage.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The volume is owned by root by default; run unprivileged and let compose
# create /data with the right ownership via the named volume.
RUN mkdir -p /data /certs && chown -R node:node /app /data
USER node

EXPOSE 8080 8443
CMD ["node", "src/server.js"]
