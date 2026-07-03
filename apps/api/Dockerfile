FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  git \
  openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json prisma.config.ts ./
COPY prisma ./prisma
COPY apps ./apps
COPY packages ./packages
COPY tooling ./tooling

RUN git init
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @databench/api... build
RUN rm -rf .git

FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=8000

COPY --from=build /app /app

EXPOSE 8000

CMD ["node", "apps/api/dist/index.js"]
