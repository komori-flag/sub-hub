# syntax=docker/dockerfile:1

########## stage 1: build ##########
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Dependency layer first - it is the expensive one and it changes rarely.
# `npm ci` requires package-lock.json to exist and match package.json.
#
# .npmrc MUST be copied. Without it `ignore-scripts=true` is not in effect, npm
# runs its automatic `node-gyp rebuild` for better-sqlite3 (which ships a
# vestigial binding.gyp alongside its prebuilt binaries), and this build fails
# outright because bookworm-slim has no python3/make/g++.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

########## stage 2: runtime ##########
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/sub.db \
    SUBCONVERTER_URL=http://subconverter:25500

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node public ./public

# The native binding has to load in the FINAL image, not just the builder.
# This fails the BUILD (rather than the first request) if the prebuild is
# missing for this architecture or a .node file was dropped by prune/copy.
RUN node --input-type=commonjs -e "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('create table t(x)');d.close();console.log('better-sqlite3 OK')"

# Created and chowned BEFORE USER node. Docker seeds a fresh NAMED volume from
# the image directory including its ownership, so the non-root user can write
# sub.db + sub.db-wal + sub.db-shm on first boot. A BIND MOUNT does not get
# this treatment - there the host directory's ownership wins. See README.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

# Probes /health (liveness), which has no dependencies - so a Subconverter
# outage can never mark the app unhealthy and trigger a restart loop.
# `node -e` rather than curl/wget: bookworm-slim ships neither, and installing
# curl purely for a probe is avoidable attack surface.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
