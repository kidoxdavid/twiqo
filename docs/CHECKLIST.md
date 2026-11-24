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
| Disputes, refunds, payments | ⬜ | Phase 4 — UI states plainly that funds are not held |

## Phase 3 — Communities and video ⬜
Circles + permissions · Clips · Stories · media processing.

## Phase 4 — Transactions and monetization ⬜
Payments (Stripe Connect) · commissions from `fee_rules` · payouts · premium listings · promotions · disputes · refunds.

## Phase 5 — Growth ⬜
Recommendations · trending · subscriptions · referrals · analytics · performance · internationalisation.
