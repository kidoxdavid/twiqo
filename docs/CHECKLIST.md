# Implementation checklist

Legend: ✅ done and tested · 🟡 partial · ⬜ not started

## Phase 1 — Platform foundation (in progress)

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

## Phase 2 — Transport marketplace ⬜
Requests · journeys · services · matching engine · offers/negotiation (goods and transport) · bookings · PIN pickup/delivery · reviews · transporter profiles.

## Phase 3 — Communities and video ⬜
Circles + permissions · Clips · Stories · media processing.

## Phase 4 — Transactions and monetization ⬜
Payments (Stripe Connect) · commissions from `fee_rules` · payouts · premium listings · promotions · disputes · refunds.

## Phase 5 — Growth ⬜
Recommendations · trending · subscriptions · referrals · analytics · performance · internationalisation.
