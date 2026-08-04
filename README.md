# PriceWatch API — Blocked-stores fork

Node.js + Express + Prisma backend for the **single-user** PriceWatch app.
This fork tracks **only** the 4 stores that were edge/WAF-blocked from the
Hetzner (Finland) VPS IP hosting the Flipkart/Amazon/Others forks: **Meesho,
Zepto, BigBasket, and Tata Neu**. It's a hard fork of the Others server, meant
to be deployed somewhere with a **different egress IP** (e.g. Railway) to see
if that alone resolves the block — without risking the stores that already
work fine on the VPS.

Designed for **Railway** (Postgres + Redis plugins), but works with any
managed Postgres (Neon, Railway Postgres, etc.).

## 1. Create a Postgres database

- **Railway**: New Project → Add Plugin → PostgreSQL. Railway auto-generates
  `DATABASE_URL` — reference it in your service as `${{Postgres.DATABASE_URL}}`.
- **Neon** (alternative): [console.neon.tech](https://console.neon.tech) →
  create project → Dashboard → Connection details → copy the **pooled**
  string to `DATABASE_URL` and the **direct** string (no `-pooler` in the
  hostname) to `DIRECT_URL`.

## 2. Configure env

```bash
cd server
copy .env.example .env
```

Edit `.env` and paste your Neon URLs + change `JWT_SECRET`.

## 3. Install, migrate, seed

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run db:seed
```

Seed creates:
- Owner: `you@pricewatch.app` / `watch123` (or values from `.env`)
- Stores: Meesho, Zepto, BigBasket, Tata Neu

## 4. Run API

```bash
npm run dev
```

API: `http://localhost:4003` (or `PORT` from `.env`)
Health: `http://localhost:4003/api/health`

## Deploying to Railway

1. Push this `server/` folder as its own Railway service (Root Directory =
   `blocked/server` if deploying from the monorepo, or its own repo).
2. Railway detects the `Dockerfile` automatically — no build config needed.
3. Add Postgres + Redis plugins to the project; reference them in this
   service's variables as `DATABASE_URL=${{Postgres.DATABASE_URL}}` and
   `REDIS_URL=${{Redis.REDIS_URL}}`.
4. Set the rest of the variables from `.env.example` in the Railway
   dashboard (`JWT_SECRET`, `CORS_ORIGIN` → your frontend's Railway/Vercel
   URL, `OWNER_EMAIL`/`OWNER_PASSWORD`).
5. First deploy runs `prisma migrate deploy` automatically (see `Dockerfile`
   CMD). Run the seed once via Railway's shell/one-off command:
   `railway run npm run db:seed`.
6. Add a product for Meesho/Zepto/BigBasket/Tata Neu and check the deploy
   logs — if it scrapes successfully, Railway's IP isn't on the same
   blocklist as the Hetzner VPS. If it still says `BLOCKED: edge/WAF denied
   access`, you'll need `SCRAPE_PROXY_URL` (see `.env.example`) even here.

## Auth

```http
POST /api/auth/login
Content-Type: application/json

{ "email": "you@pricewatch.app", "password": "watch123" }
```

Use returned `token` as:

```http
Authorization: Bearer <token>
```

## Main routes

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/health` | DB ping |
| POST | `/api/auth/login` | JWT |
| GET | `/api/auth/me` | Owner profile |
| GET/POST | `/api/stores` | List / add store |
| DELETE | `/api/stores/:id` | Custom stores only |
| GET/POST | `/api/products` | List / create (multi-pincode) |
| GET/PATCH/DELETE | `/api/products/:id` | Detail / update / delete |
| POST | `/api/products/:id/pause` | Toggle pause |
| POST | `/api/products/:id/refresh` | Force scrape now |
| GET/PATCH | `/api/settings` | Telegram + tracking prefs |
| GET | `/api/notifications` | Alerts |
| GET | `/api/dashboard/stats` | Overview |
| GET | `/api/logs` | Activity logs |
| POST | `/api/jobs/sweep` | Enqueue due checks |
| GET | `/api/jobs/stats` | Queue counts (needs Redis) |

## Workers & scrapers

On boot the API starts a checker:

1. **Redis available** → BullMQ worker + sweep every 60s  
2. **No Redis** → in-process fallback (works for local/dev without Docker)

```bash
# optional Redis
docker compose up -d redis
```

Env:

| Var | Meaning |
|-----|---------|
| `REDIS_URL` | default `redis://127.0.0.1:6379` |
| `ENABLE_WORKER` | `true` / `false` |
| `SCRAPER_MODE` | **`live`** (real only) · `auto` (live→demo) · `demo` (fake) |

Default for delivery is **`live`** — never invents prices. Failures show in Logs / product `error` status.

Live scrapers use **Playwright Chromium** when sites block plain HTTP.

```bash
npm run playwright:install   # once per machine
```

Flow: sweep → scrape → compare price/discount/offer/pincode → history + notification → Telegram (if configured).

## Schema highlights

- **Owner** — one personal account
- **Store** — ecommerce + quick_commerce (`requiresPincode`)
- **Product** + **ProductPincode** — many pincodes per product
- **Notification** — includes `pincode_available`
- **PriceHistory** / **ActivityLog**

## Scripts

```bash
npm run dev          # API + worker
npm run redis:up     # docker compose redis (if Docker installed)
npm run db:migrate
npm run db:seed
npm run db:studio
```
