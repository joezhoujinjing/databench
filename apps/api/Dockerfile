FROM node:22-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  git \
  openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json prisma.config.ts ./
COPY prisma ./prisma
COPY apps ./apps
COPY packages ./packages
COPY tooling ./tooling

RUN git init
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @databench/api... build
RUN pnpm --filter @databench/api deploy --prod --legacy /opt/databench-api
RUN mkdir -p /opt/databench-runtime/apps/api \
  && cp package.json prisma.config.ts /opt/databench-runtime/ \
  && cp -R prisma /opt/databench-runtime/prisma \
  && cp /opt/databench-api/package.json /opt/databench-runtime/apps/api/package.json \
  && cp -R /opt/databench-api/dist /opt/databench-runtime/apps/api/dist \
  && cp -R /opt/databench-api/node_modules /opt/databench-runtime/node_modules \
  && cd /opt/databench-runtime \
  && node_modules/.bin/prisma generate

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8000
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/databench-runtime /app
COPY deploy/evalscope/api-routes.json /app/evalscope-api-routes.json

EXPOSE 8000

CMD ["node", "apps/api/dist/index.js"]
