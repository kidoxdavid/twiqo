# Implementation checklist

Legend: ✅ done and tested · 🟡 partial · ⬜ not started

## Phase 1 — Platform foundation (done)

| Area | Status | Notes |
|---|---|---|
| Repo, monorepo, CI workflow | ✅ | npm workspaces, GitHub Actions with PostGIS service |
| Migrations + seed + reset | ✅ | 5 SQL migrations, realistic seed (10 users, 12 listings, posts, chat) |
| Authentication | ✅ | scrypt, JWT + rotating refresh, lockout, suspension, rate limits |
| RBAC + permissions | ✅ | moderator / admin / super_admin, permission-checked routes |
| User profiles + privacy | ✅ | followers/location visibility, who-can-message, coarse location only |
| Business profiles + team roles | ✅ | owner/manager/listing_manager/support/delivery roles enforced |
| Follow / unfollow / block | ✅ | counters consistent, block hides both ways, removes follows |
| Posts (text, photo) | ✅ | visibility, business posting, banned-word block/flag-for-review |
| Posts (video, poll) | ⬜ | Phase 3 — API returns an explicit "coming soon" error |
| Likes, threaded comments, saves | ✅ | idempotent, counters never negative, notifications |
| Share / repost | 🟡 | share-link + share-a-listing post; repost not built |
| Reports (user/post/comment/listing/message) | ✅ | one-per-target, moderator queue |
| Media upload | ✅ | magic-byte validation, EXIF stripped, re-encoded WebP + thumbnail |
| Marketplace categories | ✅ | admin add / edit / reorder / disable / restrict |
| Listings (create, edit, status, renew, expire) | ✅ | restricted categories → review queue |
| Search + filters | ✅ | FTS + trigram typo tolerance, price, condition, category tree, radius, sort, pagination |
| Feed (For You / Following / Nearby) | ✅ | unified `feed_items`, configurable weights, cursor pagination |
| Feed (Circles) | ⬜ | Phase 3 — tab shows an honest empty state |
| Messaging | ✅ | 1:1 + listing threads, unread, read receipts, images, SSE, privacy, search |
| Notifications | 🟡 | follow / comment / reply; preferences UI not built |
| Admin console | ✅ | stats, reports, listing review, users, appeals, categories, settings, banned words, fees, audit log |
| Audit log | ✅ | every admin mutation, append-only enforced by DB trigger |
| Web app (mobile + desktop) | ✅ | design direction A; loading / empty / error states |
| Automated tests | ✅ | 50 integration tests (auth, social, content, marketplace, feed, messaging, admin) |
| Map visualisation | ⬜ | needs a map provider key |
| Accessibility audit, Playwright suite | ⬜ | manual browser walkthrough done; automated e2e to add |

## Phase 2 — Transport marketplace (done)

| Area | Status | Notes |
|---|---|---|
| Transport requests | ✅ | item, size, weight, fragility, handling, date window, deadline, budget, vehicle preference, photos, public/private, link to a purchased listing |
| Journeys (available transportation) | ✅ | route through waypoints stored as a PostGIS line, detour tolerance, vehicle, capacity (kg / m³ / max size), restrictions, price |
| Transport services (local operators, businesses) | ✅ | service area + radius, intercity flag, flat / hourly / per-km pricing |
| Matching | ✅ | pickup and drop-off distance to the route, travel direction, route coverage, dates, capacity, restrictions, price, reliability; 0–100 score with reasons and warnings; partial matches kept |
| Unified offers (goods and transport) | ✅ | fixed vs negotiable, counter chain, history, expiry, withdraw, multiple simultaneous offers, auto-close |
| Orders for agreed goods | ✅ | quantity locked transactionally, sold-out closes other offers, cancel restores stock |
| Bookings | ✅ | capacity reserved under lock, one live booking per shipment enforced by the database |
| Pickup / delivery confirmation | ✅ | 4-digit PINs held by the shipper, entered by the transporter, 5-attempt lockout, photo evidence, transit updates |
| Private addresses | ✅ | stored only in `booking_addresses`, visible to the two parties only |
| Cancellation | ✅ | before pickup only; frees journey space and reopens the shipment |
| Reviews + reputation | ✅ | both sides after completion, rating and completed-move counts feed matching and profiles |
| Transporter profiles | ✅ | rating, upcoming journeys, services, optional move history |
| Notifications + preferences | ✅ | offers, counteroffers, accepted/declined, booking updates, matches, journeys from people you follow |
| Chat integration | ✅ | offer and booking cards are structured messages, separate from chat text |
| Housekeeping | ✅ | offers, listings, journeys, requests expire; delivered bookings auto-complete |
| Web UI | ✅ | Move hub, journey/request/service pages, create forms, offers inbox, booking page, orders |
| Tests | ✅ | 102 API integration tests incl. concurrency and PIN lockout; full two-user browser walkthrough |
| Map tiles / geocoding | ⬜ | route preview is schematic; needs a map provider key |
| Disputes, refunds, payments | ✅ | Phase 4 — UI states plainly that funds are not held in escrow |

## Phase 3 — Communities and video (done)

| Area | Status | Notes |
|---|---|---|
| Circles (groups) | ✅ | public / private (invisible to outsiders), open / approval / invite, rules, categories, location, cover, discover + search |
| Roles | ✅ | owner > admin > moderator > member, enforced hierarchy, ownership transfer, exactly one owner (database-enforced) |
| Membership flow | ✅ | join, request, approve / decline, invite, accept, leave, remove, ban |
| Circle content | ✅ | posts, photos, polls, clips, shared listings / journeys / requests / services (live records, not copies), pinned posts (max 3), group feed |
| Circle moderation | ✅ | moderators remove posts with a recorded reason, posting rules (members / moderators only), commerce on/off, platform admins can take down circles |
| Events | ✅ | create, RSVP, cancel with notifications, reminders, discover nearby |
| Polls | ✅ | 2–6 options, one vote each, closing time, live results |
| Clips (short video) | ✅ | vertical snap-scroll player, autoplay on screen, sound toggle, like / comment / save / share / follow / report, product / journey / service tags, view counts, For You / Following / Nearby |
| Clip ranking | ✅ | configurable weights; capped engagement; brand-new accounts only reach followers (spam guard) |
| Stories | ✅ | text / photo / video, 24 h (admin-configurable), followers-only option, product / business links, tray with unseen ring, viewers visible to the author only |
| Video pipeline | ✅ | provider interface; FFmpeg provider transcodes to 720p H.264 + poster; size and length limits enforced server-side |
| Bunny Stream adapter | 🟡 | written to Bunny's documented API (TUS upload, status, HLS playback, webhook that re-verifies status), tested against a mocked API. **Not yet run against a live Bunny account** — use `npm run video:check` |
| Audio captions / subtitles | ⬜ | clips have a text caption only |
| Signed / private video URLs | ⬜ | clip URLs are unguessable but public |
| Tests | ✅ | 138 API integration tests (Circles, roles, privacy, polls, stories, real FFmpeg uploads, Bunny adapter with mocked HTTP) + browser walkthrough |

## Phase 4 — Transactions and monetization ✅ (Stripe adapter unverified against live Stripe)
- ✅ Provider interface with `fake` (dev/tests) and `stripe` (Connect Express, destination charges, Canada) implementations
- ✅ Payout onboarding (`/settings/payments`), account sync, earnings summary, payout history from webhooks
- ✅ Checkout for orders and transport bookings, Stripe Elements form (lazy-loaded), fee snapshot per payment from `fee_rules`
- ✅ Idempotent, signature-verified webhooks (`webhook_events`), two secrets (platform + connect)
- ✅ Refunds: partial/full, race-safe against over-refund, provider-outage safe, fee returned proportionally (setting)
- ✅ Auto-refund on cancel (order/booking), late-payment refund, housekeeping retry of failed refunds, abandoned payment cleanup
- ✅ Optional pickup gating on payment (`payments.required_for_pickup`)
- ✅ Disputes: open/reply/withdraw, completion + auto-complete paused while open, staff resolve with full/partial/no refund, audit-logged
- ✅ Boosts: featured listings/services (ranked higher, not labelled as ads), sponsored posts/listings in feeds (always labelled, one per page, never to owner/blocked)
- ✅ Admin: payments, disputes, boosts, revenue (net of returned fees), webhook log; permission `manage.payments`
- ✅ `npm run stripe:check`; tests: fees, checkout, webhooks, refunds, disputes, boosts, admin, mocked Stripe adapter
- ⬜ Not built: sales tax, tax forms, Stripe chargeback evidence, subscriptions/business plans, multi-currency, payout schedule UI beyond Stripe's dashboard

## Phase 5 — Growth ✅ (partly: see gaps)
- ✅ Trending listings / tags / circles, similar listings, personalised listing recommendations, people suggestions
- ✅ Referral codes, attribution at sign-up, qualified-deal rewards, append-only credit ledger, credit applied to boosts, admin reject + audit
- ✅ Business Pro subscription (provider interface, fake + Stripe Billing adapter, webhook sync with out-of-order protection), commission discount, Pro insights
- ✅ First-party analytics (DNT/GPC respected, no IPs, 180-day retention), seller insights, admin growth dashboard (DAU/WAU/MAU, funnel, retention, referrals)
- ✅ Performance: load-check script, For You candidate pool, compression, indexes, route code splitting
- ✅ Internationalisation: English + Canadian French for the main flows, language preference stored per account
- ⬜ Gaps: French for every screen and for API error messages; native review of French; push/email digests; A/B testing; ML ranking; referral fraud detection beyond the basic rules; subscription tiers beyond Business Pro; CDN/edge caching; load testing beyond the single-node check


## Phase 6 — Trust, notifications, compliance and operations ✅ (see launch checklist for what still needs people)
- ✅ Accounts: consent, verification, reset, 2FA + recovery codes, sessions, device alerts, export, deletion
- ✅ Postgres job queue; email provider (fake/SMTP) + outbox; web push + service worker; channel preferences, unsubscribe, digest
- ✅ Saved-search and price-drop alerts
- ✅ Identity verification (Stripe Identity adapter, mock-tested), driver documents (private), driver gate (setting), badges, instant book
- ✅ Risk heuristics + review queue, velocity limits, duplicate detection, chat warnings, blind reviews
- ✅ Safety: emergency contacts, share-trip links, live location, SOS, GPS at PIN, staff queue
- ✅ Price guidance, return-trip suggestions, renew/relist, bulk CSV upload, receipts, tax estimates, chargeback evidence
- ✅ Legal drafts (terms, privacy, guidelines, refunds, prohibited items) — **drafts, need a lawyer**
- ✅ Logging + request ids, /ready, system health page, write rate limit, authorization sweep test, dependency audit in CI, backup + verified restore, Dockerfiles/compose (unrun), PWA
- ✅ Accessibility: axe (WCAG 2.1 A/AA) clean on 20 key pages, contrast fixes; **manual screen-reader and keyboard testing still needed**
- ⬜ Not built / not possible here: voice messages, multi-stop consolidation, virus scanning of uploads, CDN, Redis cache, live Stripe/Identity/SMTP/push verification, penetration test, native apps, French for every screen, SMS (emergency contacts get email only)
