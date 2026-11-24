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

## Growth features (Phase 5)

- **Trending and discovery** (`GET /api/discover`): listings with real saves, likes, offers and views in the last `discover.trending_window_days`, trending tags (listing tags plus #hashtags in public posts), and circles that gained members. Cached for 60 s per process.
- **Recommendations**: `/recommendations/listings` (from your own saves, likes and offers, plus distance and recency), `/listings/:id/similar`, `/recommendations/people` (followed by people you follow, same city, completed deals). Plain SQL on first-party signals; there is no machine learning and no outside data.
- **Referrals**: every account has a code and link (`/login?ref=CODE`). The referrer earns twiqo credit (`referral.reward_cents`, default $5) when the invited person completes a first deal of at least `referral.min_deal_cents` with someone other than the referrer; capped per person (`referral.max_rewards_per_user`). Credit lives in an append-only ledger, has no cash value, and pays for a boost only when it covers the whole price. Admins can reject a referral and take the reward back. This reduces but does not eliminate abuse (e.g. a friend creating two accounts); watch the Growth tab.
- **Business Pro** (Stripe Billing via hosted Checkout, billing portal for cancel/card changes): lowers twiqo's commission by `subscription.fee_discount_bps` on card sales and bookings, and unlocks daily trends and conversion in Insights. To use it with Stripe: create a recurring monthly Price in your Stripe dashboard, set `STRIPE_PRICE_BUSINESS_PRO`, and enable the `customer.subscription.*` webhook events. The adapter is mock-tested only, like the rest of the Stripe integration.
- **Analytics** are first-party: `analytics_events` stores event name, target, and the signed-in user id or a random per-browser id. No IP addresses; visitors who send Do Not Track or Global Privacy Control are not recorded; rows are deleted after 180 days; switch everything off with `analytics.enabled`. Update your privacy policy to describe this. Seller **Insights** (`/insights`) and the admin **Growth** tab (DAU/WAU/MAU, signups, funnel, retention, referrals) read from it. Numbers start when analytics were switched on.
- **Internationalisation**: English and Canadian French (`users.locale`, browser language detection, switcher on the sign-in page and profile). French covers the shell, sign-in, feed, market, deals, payments labels and the growth pages; other screens, category names and API error messages are still English. Money and dates follow the language. The French text has not been reviewed by a native speaker.
- **Performance**: `npm run perf:check -w apps/api` loads 40k synthetic rows into the dev database, times the main read endpoints and removes the data. It found the For You feed scoring every row (~950 ms p95); it now ranks a bounded candidate pool (~40 ms). Also added response compression, route-level code splitting in the web app (main bundle 568 kB -> 420 kB) and the indexes the discovery queries need.

## Trust, safety, accounts and operations (Phase 6)

- **Accounts**: terms acceptance at sign-up (versioned), email verification, password reset, change password, two-step verification (authenticator app + recovery codes, secrets encrypted at rest), session list with remote sign-out, new-device sign-in emails, data export and account deletion (Settings → Account security).
- **Email and push**: everything goes through a Postgres job queue (retries with backoff, safe with several servers). `EMAIL_PROVIDER=smtp` + `SMTP_URL` sends real mail; `fake` only records it (and is refused in production). Push needs VAPID keys. People choose email/push per notification type, can unsubscribe in one click, and get at most one digest a day if they have unread notifications and have been away.
- **Alerts**: saved searches (listings, journeys along a corridor, shipments for drivers) and price-drop alerts for saved items.
- **Trust**: ID verification through Stripe Identity (enable it in your Stripe dashboard first), driver documents (private storage, staff review, expiry reminders), optional rule that drivers must be verified before posting (`transport.require_verified_driver`, off by default), badges on journeys and services, instant book for trusted drivers.
- **Fraud and abuse**: explainable text heuristics hold suspicious listings for review and warn the receiver of off-platform payment requests in chat; velocity limits (tighter for new accounts); duplicate and copy-paste detection; blind reviews (revealed together or after 7 days). Staff work the queues in Admin → Risk / Documents / Safety.
- **Safety**: emergency contacts, trip-sharing links (progress only), opt-in live location, GPS saved with PIN confirmations, SOS alert (notifies the other person, staff and contacts by email). twiqo is not an emergency service and says so.
- **Money tools**: price guidance from real completed deals, receipts, estimated GST/HST on twiqo fees (an estimate for your accountant; tax is not collected), chargeback tracking with evidence built from twiqo's own records.
- **Operations**: JSON logs with request ids (`LOG_LEVEL`), `GET /ready` for load balancers, Admin → System health, blanket write rate limit, `npm audit` in CI, an automated authorization sweep over every route, `scripts/backup.sh` and `scripts/restore-check.sh` (restore is actually tested), Dockerfiles + `docker-compose.yml` (demo/staging with fake providers; **not run in this build, no Docker daemon was available**), PWA (installable, offline page, push).
- **Before you launch**, work through [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md). Several items need people (a lawyer, an accountant, a Stripe test run, a security test), not code.

## Voice messages and shipment bundles (Phase 7)

- **Voice messages**: tap the mic in a chat, record up to 2 minutes, preview, send. The server checks the recording by content (WebM/Opus from Chrome and Firefox, MP4/AAC from Safari), re-encodes it to mono AAC `.m4a` with metadata removed (needs `ffmpeg`/`ffprobe` on the server, which the Docker image includes), and stores it privately. Playback uses a signed link that expires after an hour and only goes to members of the conversation; blocking someone stops playback. Recordings are deleted after `voice.retention_days` (default 180) and when an account is deleted; the message stays, marked as expired. Voice can't be text-scanned, so moderation relies on reports. Microphone access requires HTTPS in production.
- **Trip plan** (`/trip-plan/:journeyId`, drivers): every shipment on a journey as ordered pick-ups and drop-offs along the route (drops before pick-ups at the same place), running load, estimated times at 70 km/h, addresses for jobs still to do, and warnings for opposite-direction shipments, over-capacity, and pick-up or deliver-by dates the trip can't meet.
- **Fill the empty space**: the best set of matching open shipments that fits the remaining kilograms and cubic metres, chosen by exhaustive search (highest earnings, then least detour), with one tap to offer to carry them all. Shipments that already have an open offer on the trip are left out.
- **Bundles**: a shipper can book several of their shipments on one journey for one total (split by weight, or the fixed price each); a driver can offer a bundle. Each shipment stays its own offer and booking, so PINs, payments, disputes and reviews are unchanged. Recipients can accept, decline or withdraw all at once; if one accept fails part-way the rest are reported honestly (partial), not rolled back after the fact.

## Honest scope notes

* Payments are **not implemented yet** (Phase 4); the UI says so plainly instead of faking it.
* Circles, Clips, Stories, polls and events **are implemented** (Phase 3). The Bunny Stream adapter is written but has not been run against a live Bunny account.
* Offers, transport requests, journeys, services, matching, bookings with PIN confirmation and reviews **are implemented** (Phase 2). Payment between people happens outside TWIQO for now.
* TWIQO makes **no escrow or insurance claims**. Listing pages say funds are not held and that insurance depends on the transporter.
