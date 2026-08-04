# Playwright base image — includes Chromium + OS deps (required for live scrapers)
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install ALL deps (incl. typescript + @types) for compile — NODE_ENV=production
# would skip devDependencies and break `tsc`.
COPY package.json package-lock.json* ./
COPY prisma ./prisma

# Dummy URLs ONLY for this RUN (inline env does not persist into the image).
# Do NOT use Dockerfile ENV for DATABASE_URL — that baked the build dummy into
# the runtime container and overrode Railway's real Postgres URL.
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
    DIRECT_URL="postgresql://build:build@127.0.0.1:5432/build" \
    npm ci --include=dev

# App source
COPY tsconfig.json ./
COPY src ./src

RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
    DIRECT_URL="postgresql://build:build@127.0.0.1:5432/build" \
    npx prisma generate && npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=4000
ENV ENABLE_WORKER=true
ENV SCRAPER_MODE=live

EXPOSE 4000

# Railway injects DATABASE_URL from its Postgres plugin. DIRECT_URL is optional —
# default it to DATABASE_URL so migrate works without an extra env var.
CMD ["sh", "-c", "export DIRECT_URL=\"${DIRECT_URL:-$DATABASE_URL}\" && npx prisma migrate deploy && node dist/index.js"]
