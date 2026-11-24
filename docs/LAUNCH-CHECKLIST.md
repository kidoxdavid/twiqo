# Launch checklist: what code can't do for you

twiqo handles money, identity documents, strangers meeting in person and (in Quebec) French-language law. The software is only part of being ready. Tick these before real users and real money.

## Legal and compliance (needs a lawyer / accountant)
- [ ] A Canadian lawyer reviews and replaces the draft Terms, Privacy Policy, Community Guidelines, Refund policy and Prohibited items (`apps/web/src/pages/Legal.tsx`). Bump `terms.version` in Admin → Config so everyone re-accepts.
- [ ] Quebec: French versions of the terms and the app (Charter of the French Language / Bill 96) and Law 25 privacy requirements (privacy officer, incident process).
- [ ] Marketplace/money rules: confirm you are not a money transmitter given how Stripe Connect is used; confirm Stripe Connect Express terms for your sellers.
- [ ] Sales tax: decide who charges GST/HST/PST on twiqo's fees and on boosts and subscriptions, register if required, and replace the estimate in Admin → Tax with real invoicing. CRA digital-platform reporting obligations.
- [ ] Insurance: decide what (if anything) twiqo promises about goods in transit; keep the "not insured" wording until a policy exists.
- [ ] Update the privacy policy to describe analytics, Stripe, Stripe Identity, email and push providers.

## Verify the integrations with real accounts (needs your keys)
- [ ] Stripe test mode: `npm run stripe:check -w apps/api`, then one end-to-end purchase, refund, payout setup, subscription and dispute using test cards.
- [ ] Stripe Identity enabled on the account; run one verification.
- [ ] Webhooks: platform + Connect endpoints, with `customer.subscription.*`, `identity.verification_session.*`, `charge.dispute.*` events added.
- [ ] SMTP provider with SPF, DKIM and DMARC on your sending domain; send yourself a verification and reset email; confirm unsubscribe works.
- [ ] VAPID keys set; enable push on a real phone (iPhone needs the app added to the Home Screen).
- [ ] Bunny Stream: `npm run video:check -w apps/api`.
- [ ] Decide `transport.require_verified_driver` (recommended ON) and `payments.required_for_pickup`.

## Security
- [ ] Independent penetration test; fix findings.
- [ ] Production secrets in a secret manager; strong `JWT_SECRET`; separate staging and production keys.
- [ ] TLS and HSTS at the edge; CSP header in `apps/web/nginx.conf` tested in a browser against your real CDN/video hosts.
- [ ] Virus scanning for uploaded files (not built).
- [ ] Admin accounts use two-step verification; keep the number of admins small.

## Operations
- [ ] Managed Postgres with point-in-time recovery; run `scripts/backup.sh` on a schedule, copy backups off the machine, and run `scripts/restore-check.sh` monthly.
- [ ] Run more than one API instance? Move the in-process caches (trending, rate limits) to Redis first.
- [ ] Error tracking: set `ERROR_WEBHOOK_URL` or add your preferred tracker in `lib/logger.ts`; alert on `/ready` failing.
- [ ] Load test beyond the single-node `npm run perf:check` numbers using production-like data.
- [ ] Build and run the Docker images once in CI (they were written but not run in this build).
- [ ] CDN in front of `/media` and the web app.

## Voice messages
- [ ] Privacy policy states that voice recordings are stored for 180 days (or your chosen `voice.retention_days`) and deleted with the account.
- [ ] Decide how staff handle a reported voice message (staff can't search audio; reports link to the message). Consider whether you want to listen to reported recordings and add that to your privacy policy and staff rules.
- [ ] HTTPS everywhere (browsers only allow microphone access on secure pages); test recording on a real iPhone and Android phone.
- [ ] `ffmpeg` and `ffprobe` installed in every API environment (the Docker image has them).

## People and process
- [ ] Someone watches Admin → Risk, Documents, Safety, Disputes and Chargebacks daily, with a written response-time promise. Safety alerts need a 24/7 plan or a clear statement that they don't have one.
- [ ] A support inbox that exists (`support@`, `privacy@`) and is monitored.
- [ ] A scripted response for a serious incident (injury, theft, data leak).
- [ ] Native-French review of every French string; translate the remaining screens.
- [ ] Manual accessibility testing with a screen reader and keyboard only (automated checks pass, but they find roughly a third of problems).
- [ ] Seed the first corridor deliberately (e.g. Calgary–Edmonton or Toronto–Calgary): drivers first, then shippers.
