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
npm test                 # 138 integration tests against the real test database (TEST_DATABASE_URL to override)
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
| Video | Works with built-in FFmpeg today; Bunny Stream adapter included | Bunny account: Library ID, API key, CDN hostname (see below) |
| Identity / business verification | Badge fields exist; granting is admin-manual | Provider (Stripe Identity / Persona) if automated |
| Email / push | Not built | Postmark/SES, FCM/APNs credentials |
| Trademark | **Not cleared** | CIPO search for "TWIQO", domains and handles |

## Video: Bunny Stream setup

Videos use the local FFmpeg provider by default (fine for development and small scale). To use [Bunny Stream](https://bunny.net/stream/):

1. In the Bunny dashboard create a **Stream library**. Note its **Library ID**, the library **API key**, and the **CDN hostname** (looks like `vz-xxxxxxxx-xxx.b-cdn.net`).
2. In the library settings enable the **MP4 fallback** (used when HLS is unavailable) and add your site's domain to the allowed referrers.
3. Put the values in `apps/api/.env`:
   ```
   VIDEO_PROVIDER=bunny
   BUNNY_LIBRARY_ID=...
   BUNNY_API_KEY=...
   BUNNY_CDN_HOSTNAME=vz-xxxxxxxx-xxx.b-cdn.net
   BUNNY_WEBHOOK_SECRET=<any long random string>
   ```
4. Check the credentials (creates and deletes a throwaway video): `npm run video:check -w apps/api`
5. In the library's **Webhooks** setting add `https://<your-api>/api/videos/webhook/bunny?secret=<BUNNY_WEBHOOK_SECRET>`. Without it the app still works: it checks Bunny for the status when the uploader's page polls.

The adapter follows Bunny's documented API and is tested against a mocked HTTP server; confirm it with your own account before launch. Uploads go from the browser straight to Bunny (resumable TUS), so large files never pass through this server.

## Payments: Stripe setup (Phase 4)

twiqo uses **Stripe Connect (Express accounts, destination charges)**: the buyer pays twiqo's Stripe account, the seller's or driver's share is transferred to their connected account at the same moment, and twiqo's commission stays as the application fee. twiqo does not hold seller money and this is **not escrow**. In development `PAYMENT_PROVIDER=fake` (the default) simulates everything with a test panel and no network calls; the fake provider refuses to start in production.

1. Create a Stripe account, switch to **test mode**, and enable **Connect** (platform country Canada).
2. Put the keys in `apps/api/.env`: `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_PUBLISHABLE_KEY=pk_test_...`.
3. Run `npm run stripe:check -w apps/api`. It verifies the key, Connect, onboarding links and a test PaymentIntent, then cleans up after itself.
4. Add two webhook endpoints pointing at `<your API>/api/webhooks/stripe`: one for **your account** (secret -> `STRIPE_WEBHOOK_SECRET`) and one for **Connect/connected accounts** (secret -> `STRIPE_CONNECT_WEBHOOK_SECRET`). Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `refund.created`, `refund.updated`, `charge.refund.updated`, `charge.dispute.created`, `account.updated`, `payout.created`, `payout.paid`, `payout.failed`, `payout.updated`. For local testing use `stripe listen --forward-to localhost:4000/api/webhooks/stripe`.
5. Fees are data: Admin -> Config -> Fees (`product_sale`, `transport_booking`, `premium_listing`, `featured_service`, `sponsored`). Each payment snapshots the fee it was charged. Other settings: `payments.enabled`, `payments.required_for_pickup`, `payments.payout_delay_days`, `payments.refund_platform_fee`, `payments.dispute_window_days`, `boost.days`, `ads.every_n`.

Honest status: the Stripe adapter is covered by tests against a mocked Stripe client that assert the exact parameters sent (destination charge, application fee, reverse_transfer, signature verification), but it has **not been run against live Stripe** from this build. Run `stripe:check` and one end-to-end test purchase with your test keys before trusting it. Not handled: sales tax (GST/HST/PST) on sales or on twiqo's fees, tax reporting (e.g. payee tax forms), Stripe card-dispute evidence submission (chargebacks are recorded, not contested), multi-currency. Get legal and accounting review before going live (money-transmitter and marketplace-facilitator rules, terms of service, refund policy).

## Honest scope notes

* Payments are **not implemented yet** (Phase 4); the UI says so plainly instead of faking it.
* Circles, Clips, Stories, polls and events **are implemented** (Phase 3). The Bunny Stream adapter is written but has not been run against a live Bunny account.
* Offers, transport requests, journeys, services, matching, bookings with PIN confirmation and reviews **are implemented** (Phase 2). Payment between people happens outside TWIQO for now.
* TWIQO makes **no escrow or insurance claims**. Listing pages say funds are not held and that insurance depends on the transporter.
