# TWIQO — Connect. Discover. Move.

A social marketplace where people discover, post, buy, sell, negotiate and (soon) move almost anything. Social network first, marketplace second, peer-to-peer transport as the differentiator.

* **Design:** `docs/mockups/` (direction A is the chosen one; B and C are kept for reference)
* **Architecture, ERD, plan, risks:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
* **Progress:** [`docs/CHECKLIST.md`](docs/CHECKLIST.md)

## Stack

React 18 + TypeScript + Vite · Node 22 + Express + TypeScript · PostgreSQL 16 + PostGIS · zod validation · JWT access + rotating refresh tokens · SSE realtime · sharp image processing · Vitest + Supertest.

## Run it locally

Requirements: Node 22+, PostgreSQL 16 with the **PostGIS** extension.

```bash
# 1. database (Docker option; or use any PostgreSQL 16 + PostGIS)
docker run -d --name twiqo-db -p 5432:5432 -e POSTGRES_USER=twiqo -e POSTGRES_PASSWORD=twiqo -e POSTGRES_DB=twiqo_dev postgis/postgis:16-3.4
docker exec twiqo-db createdb -U twiqo twiqo_test

# 2. install
npm install
cp apps/api/.env.example apps/api/.env      # edit JWT_SECRET for anything non-local

# 3. schema + sample data
npm run migrate
npm run seed                                # users, categories, listings, posts, a conversation

# 4. start (two terminals)
npm run dev:api                             # http://localhost:4000
npm run dev:web                             # http://localhost:5173
```

Sign in with any seeded user (`admin`, `moderator`, `amara`, `marcus`, `daniel`, `priya`, `lena`, `omar`, `calgarylife`, `brightside`) and password `Twiqo!Dev123`. `admin` is a super administrator.

`npm run db:reset` wipes the dev database and re-seeds it.

### Tests

```bash
npm test                 # 102 integration tests against the real test database (TEST_DATABASE_URL to override)
npm run typecheck
```

## Environment variables (`apps/api/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://twiqo:twiqo@localhost:5432/twiqo_dev` | PostgreSQL connection (PostGIS required) |
| `JWT_SECRET` | dev-only value | Signs access tokens. **Required in production** (≥16 chars) |
| `ACCESS_TOKEN_TTL_MIN` / `REFRESH_TOKEN_TTL_DAYS` | `15` / `30` | Session lifetimes |
| `PUBLIC_URL` | `http://localhost:4000` | Base URL used to build media links |
| `WEB_ORIGIN` | `http://localhost:5173` | Allowed CORS origin(s), comma separated |
| `UPLOAD_DIR` | `./uploads` | Local media storage (swap `StorageProvider` for S3 in production) |
| `RATE_LIMIT_DISABLED` | `false` | Only for tests |
| `PORT` | `4000` | API port |

Web: `VITE_API_URL` (optional) points the SPA at a different API origin; by default it uses the dev proxy / same origin.

## What needs your input before production

| Area | Status | Needed |
|---|---|---|
| Payments & payouts | Not built (Phase 4). Fee rules already live in the database; offers and bookings record agreed prices only | Stripe Connect (Canada) account + legal review of marketplace/KYC terms |
| Map tiles & geocoding | Route preview is a schematic drawing; city list is built in (72 Canadian cities) | Map/geocoding provider key for street-level maps and every city |
| Object storage & CDN | Local disk behind `StorageProvider` | S3-compatible bucket + CDN |
| Video | Not built (Phase 3) | Transcoding provider or FFmpeg workers |
| Identity / business verification | Badge fields exist; granting is admin-manual | Provider (Stripe Identity / Persona) if automated |
| Email / push | Not built | Postmark/SES, FCM/APNs credentials |
| Trademark | **Not cleared** | CIPO search for "TWIQO", domains and handles |

## Honest scope notes

* Groups (Circles), stories, video (Clips) and payments are **not implemented yet**; the UI marks them as coming soon rather than faking them.
* Offers, transport requests, journeys, services, matching, bookings with PIN confirmation and reviews **are implemented** (Phase 2). Payment between people happens outside TWIQO for now.
* TWIQO makes **no escrow or insurance claims**. Listing pages say funds are not held and that insurance depends on the transporter.
