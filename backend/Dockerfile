# Multi-stage: the build stage carries the toolchain DuckDB's native addon needs, the runtime
# stage carries only Node and the installed tree. Building in the runtime image would ship a
# C++ compiler and Python to production for no reason.

# ---- build ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# node-gyp's dependencies. `duckdb` publishes prebuilds for common platforms, but when none
# matches it falls back to compiling, and a build that only works when a prebuild happens to
# exist is a build that breaks on a Node bump.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests alone first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime --------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Run as the unprivileged `node` user the base image already provides. Root in a container is
# still root on the kernel; a process that only reads its own source has no reason to be it.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# The DuckDB file lives on a volume, not in the image layer, so a redeploy does not discard
# the bar cache and two containers do not each get their own private copy.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 4000

# The image's own liveness check, so `docker ps` and Compose's `depends_on: service_healthy`
# know the difference between "the process started" and "the process answers".
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so Node is PID 1 and receives SIGTERM directly — which is what makes the drain
# in src/lifecycle.js run on `docker stop` instead of the process being killed outright.
CMD ["node", "src/server.js"]
