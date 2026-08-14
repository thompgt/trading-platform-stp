# The SPA is static once built, so the runtime image is nginx and nothing else — no Node, no
# node_modules, no source. Vite inlines VITE_* variables at build time, which means the API
# base URL and key are baked into the bundle and must be supplied as build args, not env vars.

# ---- build ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Defaults suit the Compose stack, where the browser reaches the backend on the host port.
ARG VITE_API_BASE_URL=http://localhost:4000/api
ARG VITE_API_KEY=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_API_KEY=$VITE_API_KEY
RUN npm run build

# ---- runtime --------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
