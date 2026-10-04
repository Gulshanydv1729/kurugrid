# KuruGrid — static export served by nginx. No server, no backend.

# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# Slow-registry flags (see AGENTS.md §9); harmless on a normal network.
ENV npm_config_no_audit=true \
    npm_config_no_fund=true \
    npm_config_maxsockets=2 \
    npm_config_fetch_timeout=1800000 \
    npm_config_fetch_retries=8 \
    npm_config_fetch_retry_mintimeout=20000

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* vars are inlined at build time. Pass with:
#   docker build --build-arg NEXT_PUBLIC_KURU_MARKET_ADDRESS=0x... .
ARG NEXT_PUBLIC_KURU_MARKET_ADDRESS=""
ENV NEXT_PUBLIC_KURU_MARKET_ADDRESS=$NEXT_PUBLIC_KURU_MARKET_ADDRESS

RUN npm run build

# ---------- serve stage ----------
FROM nginx:alpine
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
