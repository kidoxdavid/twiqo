import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { optionalAuth, requireAuth, requirePermission } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { setting } from '../lib/policy.js';
import { notify } from '../lib/notify.js';
import { hydrateListings } from '../lib/hydrate.js';
import { thumbUrl } from '../lib/views.js';
import { anonIdOf, optedOut, track } from '../lib/analytics.js';
import { config } from '../config.js';
import { isPro } from './subscriptions.js';

export const growth = Router();
const uuid = z.string().uuid();
const BLOCKED = (alias: string, viewerParam: string) =>
  `NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id=${viewerParam}::uuid AND bl.blocked_id=${alias}) OR (bl.blocker_id=${alias} AND bl.blocked_id=${viewerParam}::uuid))`;

// ---------------------------------------------------------------------------------------------- tiny in-memory cache (per process)
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key); if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await fn(); cache.set(key, { at: Date.now(), v }); if (cache.size > 200) cache.delete(cache.keys().next().value!); return v;
}
export const clearGrowthCache = () => cache.clear();

// ---------------------------------------------------------------------------------------------- trending
const windowDays = async () => Math.max(1, Math.min(60, Number(await setting('discover.trending_window_days', 7))));

async function trendingListingIds(city: string | null) {
  const days = await windowDays();
  return cached(`tl:${city ?? ''}:${days}`, 60_000, async () => (await pool.query(
    `SELECT id FROM (
       SELECT l.id, l.seller_id, l.created_at,
         ( (SELECT count(*) FROM reactions r WHERE r.target_type='listing' AND r.target_id=l.id AND r.created_at > now() - ($1 || ' days')::interval)
         + 2 * (SELECT count(*) FROM saved_items s WHERE s.target_type='listing' AND s.target_id=l.id AND s.created_at > now() - ($1 || ' days')::interval)
         + 3 * (SELECT count(*) FROM offers o WHERE o.listing_id=l.id AND o.created_at > now() - ($1 || ' days')::interval)
         + 0.1 * (SELECT count(*) FROM analytics_events a WHERE a.name='view' AND a.target_type='listing' AND a.target_id=l.id AND a.created_at > now() - ($1 || ' days')::interval)
         ) / (1 + extract(epoch from now() - l.created_at) / 86400 / 14) AS score
       FROM listings l WHERE l.status='active' AND l.visibility='public' AND l.expires_at > now() AND ($2::text IS NULL OR l.city ILIKE $2)
     ) t WHERE score > 0 ORDER BY score DESC, created_at DESC LIMIT 40`, [String(days), city])).rows.map((r) => r.id as string));
}

async function trendingTags() {
  const days = await windowDays();
  return cached(`tt:${days}`, 60_000, async () => (await pool.query(
    `SELECT tag, count(*)::int AS uses FROM (
       SELECT lower(t) AS tag FROM listings l, unnest(l.tags) t WHERE l.status='active' AND l.visibility='public' AND l.created_at > now() - ($1 || ' days')::interval
       UNION ALL
       SELECT lower(m[1]) FROM posts p, regexp_matches(p.body, '#([A-Za-z][A-Za-z0-9_]{1,29})', 'g') m
        WHERE p.status='active' AND p.visibility='public' AND p.group_id IS NULL AND p.created_at > now() - ($1 || ' days')::interval
     ) x GROUP BY tag HAVING count(*) >= 2 ORDER BY uses DESC, tag LIMIT 12`, [String(days)])).rows as { tag: string; uses: number }[]);
}

async function trendingCircles() {
  const days = await windowDays();
  return cached(`tc:${days}`, 60_000, async () => (await pool.query(
    `SELECT g.id, g.slug, g.name, g.city, g.province, g.member_count, count(m.user_id)::int AS new_members
     FROM groups g JOIN group_members m ON m.group_id=g.id AND m.status='active' AND m.created_at > now() - ($1 || ' days')::interval
     WHERE g.status='active' AND g.visibility='public' GROUP BY g.id HAVING count(m.user_id) >= 1 ORDER BY new_members DESC, g.member_count DESC LIMIT 6`, [String(days)])).rows);
}

growth.get('/discover', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user?.id ?? null; const city = z.string().max(80).optional().parse(req.query.city) ?? null;
  const [ids, tags, circles] = await Promise.all([trendingListingIds(city), trendingTags(), trendingCircles()]);
  const blocked = viewer ? new Set((await pool.query(`SELECT blocked_id AS u FROM blocks WHERE blocker_id=$1 UNION SELECT blocker_id FROM blocks WHERE blocked_id=$1`, [viewer])).rows.map((r) => r.u)) : new Set<string>();
  const map = await hydrateListings(ids.slice(0, 24), viewer);
  const listings = ids.map((i) => map.get(i)).filter((l) => l && !blocked.has(l.seller.id)).slice(0, 12);
  if (!viewer) res.set('Cache-Control', 'public, max-age=60');
  res.json({ listings, tags, circles, window_days: await windowDays() });
}));

// ---------------------------------------------------------------------------------------------- recommendations
/** Candidate scoring is plain SQL on signals the person created themselves (saves, likes, offers). No outside data, no profiling beyond that. */
growth.get('/recommendations/listings', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  const rows = (await pool.query(
    `WITH seen AS (
        SELECT target_id AS id FROM saved_items WHERE user_id=$1 AND target_type='listing'
        UNION SELECT target_id FROM reactions WHERE user_id=$1 AND target_type='listing'
        UNION SELECT listing_id FROM offers WHERE customer_id=$1 AND listing_id IS NOT NULL),
      liked AS (SELECT l.category_id, l.tags FROM listings l WHERE l.id IN (SELECT id FROM seen)),
      cat AS (SELECT category_id, count(*)::float n FROM liked GROUP BY 1),
      tg AS (SELECT t, count(*)::float n FROM liked, unnest(tags) t GROUP BY 1),
      home AS (SELECT location FROM user_profiles WHERE user_id=$1)
      SELECT l.id, coalesce(c.n,0) AS cat_n,
        ( 2 * coalesce(c.n,0) + coalesce((SELECT sum(tg.n) FROM tg WHERE tg.t = ANY(l.tags)),0)
          + CASE WHEN l.location IS NULL OR (SELECT location FROM home) IS NULL THEN 0 ELSE 1.5 / (1 + ST_Distance(l.location, (SELECT location FROM home)) / 1000 / 30) END
          + 1.0 / (1 + extract(epoch from now() - l.created_at) / 86400 / 14) ) AS score
      FROM listings l LEFT JOIN cat c ON c.category_id = l.category_id
      WHERE l.status='active' AND l.visibility='public' AND l.expires_at > now() AND l.seller_id <> $1 AND l.id NOT IN (SELECT id FROM seen) AND ${BLOCKED('l.seller_id', '$1')}
      ORDER BY score DESC, l.created_at DESC LIMIT 12`, [me])).rows;
  const personal = rows.some((r) => Number(r.cat_n) > 0);
  const ids = rows.map((r) => r.id as string); const map = await hydrateListings(ids, me);
  res.json({ basis: personal ? 'your_activity' : 'nearby_and_new', items: ids.map((i) => map.get(i)).filter(Boolean) });
}));

growth.get('/listings/:id/similar', optionalAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const viewer = req.user?.id ?? null;
  const src = (await pool.query(`SELECT category_id, tags, price_cents, location FROM listings WHERE id=$1 AND status IN ('active','reserved','sold') AND visibility='public'`, [id])).rows[0];
  if (!src) throw notFound('Listing');
  const rows = (await pool.query(
    `SELECT l.id FROM listings l
     WHERE l.id <> $1 AND l.status='active' AND l.visibility='public' AND l.expires_at > now() AND (l.category_id=$2 OR l.tags && $3::text[]) AND ${BLOCKED('l.seller_id', '$5')}
     ORDER BY ( (CASE WHEN l.category_id=$2 THEN 2 ELSE 0 END)
       + (SELECT count(*) FROM unnest(l.tags) t WHERE t = ANY($3::text[]))
       + CASE WHEN $4::int > 0 AND l.price_cents BETWEEN $4::int * 0.5 AND $4::int * 2 THEN 1 ELSE 0 END
       + CASE WHEN l.location IS NULL OR $6::geography IS NULL THEN 0 ELSE 1.5 / (1 + ST_Distance(l.location, $6::geography) / 1000 / 30) END ) DESC, l.created_at DESC LIMIT 8`,
    [id, src.category_id, src.tags, src.price_cents, viewer, src.location])).rows;
  const ids = rows.map((r) => r.id as string); const map = await hydrateListings(ids, viewer);
  res.json({ items: ids.map((i) => map.get(i)).filter(Boolean) });
}));

growth.get('/recommendations/people', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  const { rows } = await pool.query(
    `WITH mine AS (SELECT target_id FROM follows WHERE follower_id=$1 AND target_type='user'),
          me AS (SELECT city FROM user_profiles WHERE user_id=$1)
     SELECT u.id, u.username, p.display_name, p.verification_level, p.follower_count, p.city,
            (SELECT storage_key FROM media_assets WHERE id=p.avatar_media_id) AS avatar_key,
            (SELECT count(*) FROM follows f WHERE f.target_type='user' AND f.target_id=u.id AND f.follower_id IN (SELECT target_id FROM mine))::int AS mutual,
            (SELECT x.username FROM follows f JOIN users x ON x.id=f.follower_id WHERE f.target_type='user' AND f.target_id=u.id AND f.follower_id IN (SELECT target_id FROM mine) ORDER BY x.username LIMIT 1) AS via,
            (SELECT count(*) FROM orders o WHERE o.seller_id=u.id AND o.status='completed')::int + (SELECT count(*) FROM bookings b WHERE b.transporter_id=u.id AND b.status='completed')::int AS deals,
            (p.city IS NOT NULL AND p.city = (SELECT city FROM me)) AS same_city
     FROM users u JOIN user_profiles p ON p.user_id=u.id
     WHERE u.status='active' AND u.id <> $1 AND u.id NOT IN (SELECT target_id FROM mine) AND ${BLOCKED('u.id', '$1')}
     ORDER BY (3 * (SELECT count(*) FROM follows f WHERE f.target_type='user' AND f.target_id=u.id AND f.follower_id IN (SELECT target_id FROM mine))
             + CASE WHEN p.city IS NOT NULL AND p.city = (SELECT city FROM me) THEN 2 ELSE 0 END
             + 1.5 * ((SELECT count(*) FROM orders o WHERE o.seller_id=u.id AND o.status='completed') + (SELECT count(*) FROM bookings b WHERE b.transporter_id=u.id AND b.status='completed'))
             + 0.5 * ln(1 + p.follower_count)) DESC, u.username LIMIT 10`, [me]);
  res.json({ items: rows.filter((r) => r.mutual > 0 || r.same_city || r.deals > 0 || r.follower_count > 0).map((r) => ({
    id: r.id, username: r.username, display_name: r.display_name, verification_level: r.verification_level, followers: r.follower_count, avatar_url: r.avatar_key ? thumbUrl(r.avatar_key) : null,
    reason: r.mutual > 0 ? (r.mutual > 1 ? `Followed by @${r.via} and ${r.mutual - 1} other${r.mutual > 2 ? 's' : ''} you follow` : `Followed by @${r.via}, who you follow`) : r.deals > 0 ? `${r.deals} completed deal${r.deals > 1 ? 's' : ''} on twiqo` : r.same_city ? `Also in ${r.city}` : 'Popular on twiqo' })) });
}));

// ---------------------------------------------------------------------------------------------- credits and referrals
export const creditBalance = async (db: Db, userId: string) => Number((await db.query('SELECT coalesce(sum(amount_cents),0)::bigint AS n FROM credit_ledger WHERE user_id=$1', [userId])).rows[0].n);

/** Spend credit atomically: the user row is locked so two checkouts can't spend the same credit. Returns false when the balance is too low. */
export async function spendCredit(c: PoolClient, userId: string, cents: number, reason: 'boost_purchase', ref: { type: string; id: string }) {
  await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [userId]);
  if ((await creditBalance(c, userId)) < cents) return false;
  await c.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,ref_type,ref_id) VALUES ($1,$2,$3,$4,$5)`, [userId, -cents, reason, ref.type, ref.id]);
  return true;
}

/** Called when someone completes a deal. Rewards the referrer once, only for real deals between two different people. */
export async function qualifyReferral(c: PoolClient, refereeId: string, deal: { counterpartyId: string; amountCents: number }) {
  if ((await setting('referral.enabled', true, c)) !== true) return;
  const r = (await c.query(`SELECT * FROM referrals WHERE referee_id=$1 AND status='signed_up' FOR UPDATE`, [refereeId])).rows[0];
  if (!r || deal.counterpartyId === r.referrer_id) return;                                     // no rewarding a deal with yourself
  const minDeal = Number(await setting('referral.min_deal_cents', 1000, c)); if (deal.amountCents < minDeal) return;
  const reward = Number(await setting('referral.reward_cents', 500, c));
  const cap = Number(await setting('referral.max_rewards_per_user', 20, c));
  const done = Number((await c.query(`SELECT count(*)::int n FROM referrals WHERE referrer_id=$1 AND status='qualified'`, [r.referrer_id])).rows[0].n);
  if (reward <= 0 || done >= cap) { await c.query(`UPDATE referrals SET status='qualified', qualified_at=now(), reward_cents=0 WHERE id=$1`, [r.id]); return; }
  await c.query(`UPDATE referrals SET status='qualified', qualified_at=now(), reward_cents=$2 WHERE id=$1`, [r.id, reward]);
  await c.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,ref_type,ref_id) VALUES ($1,$2,'referral_reward','referral',$3) ON CONFLICT DO NOTHING`, [r.referrer_id, reward, r.id]);
  await notify(c, { userId: r.referrer_id, type: 'referral_reward', actorId: refereeId, targetType: 'referral', targetId: r.id, data: { reward_cents: reward } });
}

/** Link a new account to the referrer who invited them. Invalid codes are ignored silently so a typo never blocks sign-up. */
export async function attachReferral(c: PoolClient, newUserId: string, code: string | undefined) {
  if (!code || (await setting('referral.enabled', true, c)) !== true) return;
  const ref = (await c.query(`SELECT id FROM users WHERE referral_code=$1 AND status='active' AND id <> $2`, [code.toLowerCase(), newUserId])).rows[0];
  if (!ref) return;
  await c.query('UPDATE users SET referred_by=$2 WHERE id=$1', [newUserId, ref.id]);
  await c.query(`INSERT INTO referrals(referrer_id, referee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ref.id, newUserId]);
}

growth.get('/referrals/me', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  const u = (await pool.query('SELECT referral_code FROM users WHERE id=$1', [me])).rows[0];
  const st = (await pool.query(`SELECT count(*)::int AS signed_up, count(*) FILTER (WHERE status='qualified')::int AS qualified, coalesce(sum(reward_cents),0)::int AS earned FROM referrals WHERE referrer_id=$1`, [me])).rows[0];
  const recent = (await pool.query(`SELECT r.status, r.created_at, r.qualified_at, r.reward_cents, p.display_name FROM referrals r JOIN user_profiles p ON p.user_id=r.referee_id WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT 20`, [me])).rows;
  const ledger = (await pool.query(`SELECT amount_cents, reason, created_at FROM credit_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 20`, [me])).rows;
  res.json({
    enabled: (await setting('referral.enabled', true)) === true, code: u.referral_code, link: `${config.WEB_ORIGIN.split(',')[0]}/login?ref=${u.referral_code}`,
    reward_cents: Number(await setting('referral.reward_cents', 500)), min_deal_cents: Number(await setting('referral.min_deal_cents', 1000)),
    rules: 'You earn twiqo credit when someone you invite completes their first deal (at least the minimum amount, with someone other than you). Credit can be used toward boosts. It has no cash value.',
    stats: st, credit_cents: await creditBalance(pool, me), recent: recent.map((r) => ({ ...r, display_name: r.display_name })), ledger });
}));

growth.get('/credits', requireAuth, wrap(async (req, res) => {
  res.json({ balance_cents: await creditBalance(pool, req.user!.id), ledger: (await pool.query(`SELECT amount_cents, reason, note, created_at FROM credit_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [req.user!.id])).rows });
}));

growth.get('/admin/referrals', requirePermission('view.growth'), wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT r.id, r.status, r.reward_cents, r.created_at, r.qualified_at, a.username AS referrer, b.username AS referee FROM referrals r JOIN users a ON a.id=r.referrer_id JOIN users b ON b.id=r.referee_id ORDER BY r.created_at DESC LIMIT 100`);
  res.json({ items: rows });
}));
growth.post('/admin/referrals/:id/reject', requirePermission('view.growth'), wrap(async (req, res) => {
  const b = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body); const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const r = (await c.query('SELECT * FROM referrals WHERE id=$1 FOR UPDATE', [id])).rows[0]; if (!r) throw notFound('Referral');
    if (r.status === 'rejected') throw conflict('Already rejected');
    if (r.reward_cents > 0) {   // take the reward back if it has not been spent; the ledger can go negative only through this explicit adjustment
      await c.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,ref_type,ref_id,note) VALUES ($1,$2,'admin_adjustment','referral',$3,$4)`, [r.referrer_id, -r.reward_cents, id, `Referral rejected: ${b.reason}`]);
    }
    await c.query(`UPDATE referrals SET status='rejected', reward_cents=0 WHERE id=$1`, [id]);
    await audit(c, req.user!.id, 'referral.reject', 'referral', id, { status: r.status, reward_cents: r.reward_cents }, { reason: b.reason }, req.ip ?? null);
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------------------------------------- analytics ingest
growth.post('/analytics/events', optionalAuth, wrap(async (req, res) => {
  if (optedOut(req)) return void res.status(202).json({ recorded: 0, reason: 'opted_out' });
  const b = z.object({ events: z.array(z.object({
    name: z.enum(['view', 'search', 'share', 'contact_click']), target_type: z.enum(['listing', 'post', 'user', 'business', 'transport_request', 'journey', 'transport_service', 'circle']).optional(), target_id: uuid.optional(),
    props: z.record(z.string().max(40), z.union([z.string().max(100), z.number(), z.boolean()])).optional() })).min(1).max(20) }).parse(req.body);
  const anon = anonIdOf(req); let n = 0;
  for (const e of b.events) if (await track(pool, { name: e.name, userId: req.user?.id, anonId: anon, targetType: e.target_type, targetId: e.target_id, props: e.props })) n++;
  res.status(202).json({ recorded: n });
}));

// ---------------------------------------------------------------------------------------------- seller insights

growth.get('/insights', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const days = z.coerce.number().int().min(1).max(90).default(30).parse(req.query.days ?? 30); const pro = await isPro(me);
  const w = `now() - ($2 || ' days')::interval`;
  const items = (await pool.query(
    `SELECT t.type, t.id, t.title,
        (SELECT count(*) FROM analytics_events a WHERE a.name='view' AND a.target_id=t.id AND a.created_at > ${w})::int AS views,
        (SELECT count(DISTINCT coalesce(a.user_id::text, a.anon_id)) FROM analytics_events a WHERE a.name='view' AND a.target_id=t.id AND a.created_at > ${w})::int AS visitors,
        (SELECT count(*) FROM saved_items s WHERE s.target_id=t.id AND s.created_at > ${w})::int AS saves,
        (SELECT count(*) FROM reactions r WHERE r.target_id=t.id AND r.created_at > ${w})::int AS likes,
        (SELECT count(*) FROM offers o WHERE (o.listing_id=t.id OR o.service_id=t.id) AND o.created_at > ${w})::int AS offers
     FROM (SELECT 'listing' AS type, id, title FROM listings WHERE seller_id=$1 AND status IN ('active','reserved','sold')
           UNION ALL SELECT 'transport_service', id, title FROM transport_services WHERE provider_id=$1 AND status='active') t
     ORDER BY views DESC, offers DESC LIMIT 50`, [me, String(days)])).rows;
  const sum = (k: string) => items.reduce((a, i) => a + Number(i[k]), 0);
  const totals = { views: sum('views'), saves: sum('saves'), likes: sum('likes'), offers: sum('offers') };
  const out: Record<string, unknown> = { days, pro, totals, items, note: 'Views are counted from the day analytics were switched on and exclude your own visits and visitors who send Do Not Track.' };
  if (pro) {
    out.daily = (await pool.query(
      `SELECT d::date AS day, coalesce(v.n,0)::int AS views, coalesce(o.n,0)::int AS offers FROM generate_series(current_date - ($2::int - 1), current_date, '1 day') d
       LEFT JOIN (SELECT created_at::date AS day, count(*) n FROM analytics_events WHERE name='view' AND target_id IN (SELECT id FROM listings WHERE seller_id=$1 UNION SELECT id FROM transport_services WHERE provider_id=$1) AND created_at > ${w} GROUP BY 1) v ON v.day=d::date
       LEFT JOIN (SELECT created_at::date AS day, count(*) n FROM offers WHERE provider_id=$1 AND created_at > ${w} GROUP BY 1) o ON o.day=d::date ORDER BY d`, [me, days])).rows;
    out.conversion = { views_to_offers: totals.views ? Math.round((totals.offers / totals.views) * 1000) / 10 : null };
  } else out.upgrade_hint = 'Business Pro adds daily trends and conversion.';
  res.json(out);
}));

// ---------------------------------------------------------------------------------------------- admin growth dashboard
growth.get('/admin/growth', requirePermission('view.growth'), wrap(async (req, res) => {
  const days = z.coerce.number().int().min(7).max(180).default(30).parse(req.query.days ?? 30); const d = String(days);
  const signups = (await pool.query(`SELECT created_at::date AS day, count(*)::int AS n, count(*) FILTER (WHERE referred_by IS NOT NULL)::int AS referred FROM users WHERE created_at > now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 1`, [d])).rows;
  const active = (await pool.query(
    `WITH ev AS (SELECT coalesce(user_id::text, 'a:' || anon_id) AS who, created_at FROM analytics_events WHERE created_at > now() - interval '30 days')
     SELECT (SELECT count(DISTINCT who) FROM ev WHERE created_at > now() - interval '1 day')::int AS dau, (SELECT count(DISTINCT who) FROM ev WHERE created_at > now() - interval '7 days')::int AS wau, (SELECT count(DISTINCT who) FROM ev)::int AS mau`)).rows[0];
  const funnel = (await pool.query(
    `WITH c AS (SELECT id FROM users WHERE created_at > now() - ($1 || ' days')::interval)
     SELECT (SELECT count(*) FROM c)::int AS signed_up,
       (SELECT count(*) FROM c WHERE EXISTS (SELECT 1 FROM listings l WHERE l.seller_id=c.id) OR EXISTS (SELECT 1 FROM transport_requests r WHERE r.requester_id=c.id) OR EXISTS (SELECT 1 FROM journeys j WHERE j.driver_id=c.id))::int AS posted,
       (SELECT count(*) FROM c WHERE EXISTS (SELECT 1 FROM offers o WHERE o.proposer_id=c.id))::int AS made_offer,
       (SELECT count(*) FROM c WHERE EXISTS (SELECT 1 FROM orders o WHERE (o.buyer_id=c.id OR o.seller_id=c.id) AND o.status='completed') OR EXISTS (SELECT 1 FROM bookings b WHERE (b.shipper_id=c.id OR b.transporter_id=c.id) AND b.status='completed'))::int AS completed_deal`, [d])).rows[0];
  const retention = (await pool.query(
    `WITH cohorts AS (SELECT id, date_trunc('week', created_at)::date AS wk FROM users WHERE created_at > now() - interval '6 weeks'),
          act AS (SELECT DISTINCT user_id, date_trunc('week', created_at)::date AS wk FROM analytics_events WHERE user_id IS NOT NULL)
     SELECT c.wk AS cohort, count(DISTINCT c.id)::int AS size,
       count(DISTINCT a1.user_id)::int AS week1, count(DISTINCT a2.user_id)::int AS week2, count(DISTINCT a3.user_id)::int AS week3
     FROM cohorts c LEFT JOIN act a1 ON a1.user_id=c.id AND a1.wk = c.wk + 7 LEFT JOIN act a2 ON a2.user_id=c.id AND a2.wk = c.wk + 14 LEFT JOIN act a3 ON a3.user_id=c.id AND a3.wk = c.wk + 21 GROUP BY c.wk ORDER BY c.wk`)).rows;
  const ref = (await pool.query(`SELECT count(*)::int AS signed_up, count(*) FILTER (WHERE status='qualified')::int AS qualified, coalesce(sum(reward_cents),0)::int AS credit_issued FROM referrals`)).rows[0];
  const subs = (await pool.query(`SELECT count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE status='past_due')::int AS past_due, count(*) FILTER (WHERE status='canceled')::int AS canceled FROM subscriptions`)).rows[0];
  res.json({ days, signups, active, funnel, retention, referrals: ref, subscriptions: subs,
    notes: ['Active-user numbers come from first-party events (page views and actions) and start when analytics were switched on.', 'Retention counts signed-in people with at least one event in the week.', 'Funnel steps use real records (listings, offers, completed deals), not events.'] });
}));

growth.patch('/me/locale', requireAuth, wrap(async (req, res) => {
  const b = z.object({ locale: z.enum(['en', 'fr']) }).parse(req.body);
  await pool.query('UPDATE users SET locale=$2 WHERE id=$1', [req.user!.id, b.locale]);
  res.json({ locale: b.locale });
}));

void badRequest;
