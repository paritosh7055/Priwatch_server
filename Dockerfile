# Playwright base image — includes Chromium + OS deps (required for live scrapers)
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Dummy URLs so `prisma generate` (postinstall + explicit) can parse the schema
# without real Railway secrets at build time. Runtime uses the real DATABASE_URL.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
ENV DIRECT_URL="postgresql://build:build@127.0.0.1:5432/build"

# Install ALL deps (incl. typescript + @types) for compile — NODE_ENV=production
# would skip devDependencies and break `tsc`.
COPY package.json package-lock.json* ./
COPY prisma ./prisma

RUN npm ci --include=dev

# App source
COPY tsconfig.json ./
COPY src ./src

RUN npx prisma generate && npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=4000
ENV ENABLE_WORKER=true
ENV SCRAPER_MODE=live

EXPOSE 4000

# Railway only injects DATABASE_URL from its Postgres plugin — DIRECT_URL is
# optional. Default it to DATABASE_URL so `prisma migrate deploy` works without
# an extra env var. Neon users who need a separate direct connection can still
# set DIRECT_URL explicitly.
CMD ["sh", "-c", "export DIRECT_URL=\"${DIRECT_URL:-$DATABASE_URL}\" && npx prisma migrate deploy && node dist/index.js"]
