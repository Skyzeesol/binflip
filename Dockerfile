# One image for every service; docker-compose picks the entrypoint per service.

FROM node:22.21-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
# Optional: behind a TLS-intercepting proxy, pass its CA with
#   docker build --secret id=extra_ca,src=/path/ca.crt ...
# Without the secret this is a no-op.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/listener/package.json apps/listener/
COPY apps/executor/package.json apps/executor/
COPY apps/manager/package.json apps/manager/
COPY apps/mm/package.json apps/mm/
COPY apps/api/package.json apps/api/
COPY apps/telegram/package.json apps/telegram/
COPY apps/web/package.json apps/web/

# Full install + compile.
FROM manifests AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
# The panel proxies /api/* to the api service; rewrites are baked in at build time.
ARG API_URL=http://api:3001
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm -r build

# Production dependencies only.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --prod

FROM node:22.21-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app /app
COPY --from=build --chown=node:node /app/packages/core/dist packages/core/dist
COPY --from=build --chown=node:node /app/packages/db/dist packages/db/dist
COPY --from=build --chown=node:node /app/packages/db/drizzle packages/db/drizzle
COPY --from=build --chown=node:node /app/apps/listener/dist apps/listener/dist
COPY --from=build --chown=node:node /app/apps/executor/dist apps/executor/dist
COPY --from=build --chown=node:node /app/apps/manager/dist apps/manager/dist
COPY --from=build --chown=node:node /app/apps/mm/dist apps/mm/dist
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/apps/telegram/dist apps/telegram/dist
# Panel: Next.js standalone server (self-contained, has its own node_modules) + static assets.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone /app/web
COPY --from=build --chown=node:node /app/apps/web/.next/static /app/web/apps/web/.next/static
USER node
# Overridden per service in docker-compose.yml
CMD ["node", "apps/api/dist/main.js"]
