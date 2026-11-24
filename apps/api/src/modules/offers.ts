import { track } from '../lib/analytics.js';
import { enforceVelocity } from '../lib/risk.js';
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { HttpError, badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { checkText, setting } from '../lib/policy.js';
import { notify } from '../lib/notify.js';
import { assertNotBlocked, ensureConversation, postCard, type SubjectType } from '../lib/conversations.js';
import { checkFit, checkServiceFit, volumeM3 } from '../lib/matching.js';
import { thumbUrl } from '../lib/views.js';

export const offers = Router();
const uuid = z.string().uuid();

type Scope = { listingId?: string; requestId?: string; journeyId?: string; serviceId?: string };
const scopeSql = (s: Scope) => {
  if (s.listingId) return ['listing_id', s.listingId]; if (s.requestId) return ['request_id', s.requestId];
  if (s.journeyId) return ['journey_id', s.journeyId]; return ['service_id', s.serviceId!];
};

async function logEvent(c: Db, offerId: string, actor: string | null, kind: string, note?: string) {
  await c.query('INSERT INTO offer_events(offer_id,actor_id,kind,note) VALUES ($1,$2,$3,$4)', [offerId, actor, kind, note ?? null]);
}

/** Close every pending offer on a subject that can no longer be fulfilled. Runs inside the caller's transaction. */
export async function rejectOpenOffers(c: PoolClient, scope: Scope, actor: string | null, reason: string, exceptOffer?: string, onlyIfQtyOver?: number) {
  const [col, val] = scopeSql(scope);
  const { rows } = await c.query(
    `UPDATE offers SET status='rejected', responded_at=now() WHERE ${col}=$1 AND status='pending' AND ($2::uuid IS NULL OR id <> $2) AND ($3::int IS NULL OR quantity > $3)
     RETURNING id, customer_id, provider_id, proposer_id`, [val, exceptOffer ?? null, onlyIfQtyOver ?? null]);
  for (const o of rows) {
    await logEvent(c, o.id, actor, 'auto_rejected', reason);
    const other = o.proposer_id; // the proposer is the one waiting for an answer
    await notify(c, { userId: other, type: 'offer_rejected', actorId: actor, targetType: 'offer', targetId: o.id, data: { reason } });
  }
  return rows.length;
}

/** Lazily expire pending offers whose time ran out. Safe to call anywhere. */
export async function expireOffers(db: Db = pool) {
  const { rows } = await db.query(`UPDATE offers SET status='expired', responded_at=now() WHERE status='pending' AND expires_at <= now() RETURNING id, proposer_id`);
  for (const o of rows) {
    await logEvent(db, o.id, null, 'expired');
    await notify(db, { userId: o.proposer_id, type: 'offer_rejected', targetType: 'offer', targetId: o.id, data: { reason: 'expired' } });
  }
  return rows.length;
}

async function expiryHours(requested?: number) {
  const def = Number(await setting('offer.default_expiry_hours', 48)); const max = Number(await setting('offer.max_expiry_hours', 168));
  return Math.min(Math.max(requested ?? def, 1), max);
}

// ------------------------------------------------------------------------------------------ views
const userV = (r: any, p: string) => ({ id: r[`${p}_id`], username: r[`${p}_username`], display_name: r[`${p}_name`], avatar_url: r[`${p}_avatar`] ? thumbUrl(r[`${p}_avatar`]) : null });

async function offerViews(ids: string[], me: string) {
  if (!ids.length) return new Map<string, any>();
  const { rows } = await pool.query(
    `SELECT o.*, cu.username AS c_username, cp.display_name AS c_name, (SELECT storage_key FROM media_assets WHERE id=cp.avatar_media_id) AS c_avatar,
        pu.username AS p_username, pp.display_name AS p_name, (SELECT storage_key FROM media_assets WHERE id=pp.avatar_media_id) AS p_avatar,
        l.title AS l_title, l.price_cents AS l_price, l.price_type AS l_ptype, l.quantity AS l_qty, l.status AS l_status,
        (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id=lm.media_id WHERE lm.listing_id=l.id ORDER BY lm.position LIMIT 1) AS l_img,
        r.title AS r_title, r.origin_city AS r_oc, r.dest_city AS r_dc, r.weight_kg AS r_kg, r.quantity AS r_qty, r.status AS r_status,
        j.origin_city AS j_oc, j.dest_city AS j_dc, j.departure_at AS j_dep, s.title AS s_title,
        (SELECT id FROM bookings b WHERE b.offer_id=o.id) AS booking_id, (SELECT id FROM orders od WHERE od.offer_id=o.id) AS order_id,
        (SELECT count(*)::int FROM offers x WHERE x.bundle_id=o.bundle_id) AS bundle_n, (SELECT coalesce(sum(x.amount_cents),0)::int FROM offers x WHERE x.bundle_id=o.bundle_id) AS bundle_total, (SELECT count(*)::int FROM offers x WHERE x.bundle_id=o.bundle_id AND x.status='pending' AND x.expires_at > now()) AS bundle_open
     FROM offers o JOIN users cu ON cu.id=o.customer_id JOIN user_profiles cp ON cp.user_id=cu.id JOIN users pu ON pu.id=o.provider_id JOIN user_profiles pp ON pp.user_id=pu.id
     LEFT JOIN listings l ON l.id=o.listing_id LEFT JOIN transport_requests r ON r.id=o.request_id LEFT JOIN journeys j ON j.id=o.journey_id LEFT JOIN transport_services s ON s.id=o.service_id
     WHERE o.id = ANY($1::uuid[])`, [ids]);
  const out = new Map<string, any>();
  for (const r of rows) {
    const recipient = r.proposer_id === r.customer_id ? r.provider_id : r.customer_id;
    const live = r.status === 'pending' && new Date(r.expires_at) > new Date();
    out.set(r.id, {
      id: r.id, kind: r.kind, status: r.status === 'pending' && !live ? 'expired' : r.status, amount_cents: r.amount_cents, quantity: r.quantity, message: r.message,
      expires_at: r.expires_at, created_at: r.created_at, parent_offer_id: r.parent_offer_id, proposer_id: r.proposer_id,
      customer: userV(r, 'c'), provider: userV(r, 'p'), my_role: me === r.customer_id ? 'customer' : 'provider',
      counterparty: me === r.customer_id ? userV(r, 'p') : userV(r, 'c'),
      can_respond: live && recipient === me, can_withdraw: live && r.proposer_id === me,
      subject: r.kind === 'goods'
        ? { type: 'listing', id: r.listing_id, title: r.l_title, asking_cents: r.l_price, price_type: r.l_ptype, image_url: r.l_img ? thumbUrl(r.l_img) : null, available: r.l_qty }
        : { type: 'transport', request: { id: r.request_id, title: r.r_title, from: r.r_oc, to: r.r_dc, weight_kg: Number(r.r_kg), quantity: r.r_qty },
            journey: r.journey_id ? { id: r.journey_id, from: r.j_oc, to: r.j_dc, departure_at: r.j_dep } : null, service: r.service_id ? { id: r.service_id, title: r.s_title } : null },
      booking_id: r.booking_id, order_id: r.order_id,
      bundle: r.bundle_id ? { id: r.bundle_id, count: r.bundle_n, total_cents: r.bundle_total, open: r.bundle_open } : null,
    });
  }
  return out;
}
export const offerView = async (id: string, me: string) => (await offerViews([id], me)).get(id);
export { offerViews };

// ------------------------------------------------------------------------------------------ create
const base = { amount_cents: z.number().int().min(0).max(100_000_000), message: z.string().trim().max(1000).optional(), expires_in_hours: z.number().int().min(1).max(720).optional() };
export const createSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('goods'), listing_id: uuid, quantity: z.number().int().min(1).max(10000).default(1), ...base }),
  z.object({ kind: z.literal('transport'), request_id: uuid, journey_id: uuid.optional(), service_id: uuid.optional(), ...base }),
]);

/** Create an offer as `me`. Shared by the offer route and shipment bundles (which create several offers with one bundle id). */
export async function createOffer(me: string, b: z.infer<typeof createSchema>, opts: { bundleId?: string } = {}) {
  await checkText(b.message);
  await enforceVelocity(pool, me, 'offer');
  await expireOffers();
  const hours = await expiryHours(b.expires_in_hours);
  let instantDriver: string | null = null;
  let conv: { provider: string; customer: string; subject?: { type: SubjectType; id: string } };
  let row: Record<string, unknown>;

  if (b.kind === 'goods') {
    const l = (await pool.query(
      `SELECT l.*, (SELECT status FROM users WHERE id=l.seller_id) AS seller_status FROM listings l WHERE l.id=$1`, [b.listing_id])).rows[0];
    if (!l || l.seller_status !== 'active' || l.status !== 'active' || l.expires_at < new Date()) throw notFound('Listing');
    if (l.visibility === 'followers' && l.seller_id !== me && !(await pool.query(`SELECT 1 FROM follows WHERE follower_id=$1 AND target_type='user' AND target_id=$2`, [me, l.seller_id])).rowCount) throw notFound('Listing');
    if (l.seller_id === me) throw badRequest('You cannot make an offer on your own listing');
    await assertNotBlocked(pool, me, l.seller_id).catch(() => { throw notFound('Listing'); });   // never reveal that someone blocked you
    if (b.quantity > l.quantity) throw new HttpError(422, `Only ${l.quantity} available`, 'unavailable');
    const ask = l.price_cents * b.quantity;
    if (l.price_type === 'free' && b.amount_cents !== 0) throw badRequest('This item is free');
    if (l.price_type === 'fixed' && b.amount_cents !== ask) throw new HttpError(422, `This item has a fixed price of ${(ask / 100).toFixed(2)}`, 'fixed_price');
    if (l.price_type === 'negotiable' && (b.amount_cents <= 0 || b.amount_cents > ask)) throw badRequest('Offer between $0.01 and the asking price');
    if ((await pool.query(`SELECT 1 FROM offers WHERE listing_id=$1 AND customer_id=$2 AND status='pending' AND expires_at > now()`, [l.id, me])).rowCount) throw conflict('You already have an open offer on this listing. Withdraw it first.');
    row = { kind: 'goods', customer: me, provider: l.seller_id, listing_id: l.id, request_id: null, journey_id: null, service_id: null, amount: b.amount_cents, quantity: b.quantity };
    conv = { customer: me, provider: l.seller_id, subject: { type: 'listing', id: l.id } };
  } else {
    const r = (await pool.query(`SELECT r.*, (SELECT status FROM users WHERE id=r.requester_id) AS owner_status FROM transport_requests r WHERE r.id=$1`, [b.request_id])).rows[0];
    if (!r || r.owner_status !== 'active') throw notFound('Request');
    const asShipper = r.requester_id === me;
    if (!asShipper && (r.status !== 'open' || r.visibility !== 'public')) throw notFound('Request');
    if (r.status !== 'open') throw new HttpError(409, 'This request is no longer open', 'conflict');
    if (b.journey_id && b.service_id) throw badRequest('Choose a journey or a service, not both');
    if (asShipper && !b.journey_id && !b.service_id) throw badRequest('Choose the journey or service you want to book');
    let provider: string; let fixedPrice: number | null = null; let subject: { type: SubjectType; id: string };
    if (b.journey_id) {
      const j = (await pool.query(`SELECT j.*, (SELECT status FROM users WHERE id=j.driver_id) AS ds FROM journeys j WHERE j.id=$1`, [b.journey_id])).rows[0];
      if (!j || j.ds !== 'active' || j.status !== 'open' || j.departure_at < new Date()) throw notFound('Journey');
      if (asShipper ? j.driver_id === me : j.driver_id !== me) throw badRequest(asShipper ? 'You cannot book your own journey' : 'That journey is not yours');
      const fit = await checkFit(r.id, j.id);
      if (fit?.excluded && ['capacity', 'restriction'].includes(fit.excluded.code)) throw new HttpError(422, fit.excluded.reason, 'does_not_fit');
      provider = j.driver_id; subject = { type: 'journey', id: j.id }; if (j.price_type === 'fixed' && asShipper) fixedPrice = j.price_cents;
      if (asShipper && j.instant_book && j.price_type === 'fixed' && b.amount_cents === j.price_cents) instantDriver = j.driver_id;
    } else if (b.service_id) {
      const s = (await pool.query(`SELECT s.*, (SELECT status FROM users WHERE id=s.provider_id) AS ps FROM transport_services s WHERE s.id=$1`, [b.service_id])).rows[0];
      if (!s || s.ps !== 'active' || s.status !== 'active') throw notFound('Service');
      if (asShipper ? s.provider_id === me : s.provider_id !== me) throw badRequest(asShipper ? 'You cannot book your own service' : 'That service is not yours');
      const fit = await checkServiceFit(r.id, s.id);
      if (fit?.excluded) throw new HttpError(422, fit.excluded.reason, 'does_not_fit');
      provider = s.provider_id; subject = { type: 'service', id: s.id }; if (s.price_type === 'fixed' && s.pricing_model === 'flat' && asShipper) fixedPrice = s.price_cents;
    } else { provider = me; subject = { type: 'transport_request', id: r.id }; if (r.price_type === 'fixed' && r.budget_cents !== null) fixedPrice = r.budget_cents; }
    if (!asShipper && provider !== me) throw badRequest('Invalid offer');
    const customer = r.requester_id;
    if (customer === provider) throw badRequest('You cannot offer to yourself');
    await assertNotBlocked(pool, customer, provider).catch(() => { throw notFound('Request'); });
    if (fixedPrice !== null && b.amount_cents !== fixedPrice) throw new HttpError(422, `This has a fixed price of ${(fixedPrice / 100).toFixed(2)}`, 'fixed_price');
    if (fixedPrice === null && b.amount_cents <= 0) throw badRequest('Enter an amount');
    if ((await pool.query(`SELECT 1 FROM offers WHERE request_id=$1 AND customer_id=$2 AND provider_id=$3 AND coalesce(journey_id,service_id,request_id)=$4 AND status='pending' AND expires_at > now()`, [r.id, customer, provider, b.journey_id ?? b.service_id ?? r.id])).rowCount) throw conflict('There is already an open offer for this. Withdraw it first.');
    row = { kind: 'transport', customer, provider, listing_id: null, request_id: r.id, journey_id: b.journey_id ?? null, service_id: b.service_id ?? null, amount: b.amount_cents, quantity: 1 };
    conv = { customer, provider, subject };
  }

  const id = await tx(async (c) => {
    const o = await c.query(
      `INSERT INTO offers(kind,customer_id,provider_id,proposer_id,listing_id,request_id,journey_id,service_id,amount_cents,quantity,message,expires_at,bundle_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + ($12 || ' hours')::interval, $13) RETURNING id`,
      [row.kind, row.customer, row.provider, me, row.listing_id, row.request_id, row.journey_id, row.service_id, row.amount, row.quantity, b.message ?? null, String(hours), opts.bundleId ?? null]);
    await logEvent(c, o.rows[0].id, me, 'created', b.message);
    const other = me === conv.customer ? conv.provider : conv.customer;
    const cid = await ensureConversation(c, me, other, conv.subject);
    await postCard(c, cid, me, 'offer', { offer_id: o.rows[0].id, event: 'created' });
    await notify(c, { userId: other, type: 'offer_received', actorId: me, targetType: 'offer', targetId: o.rows[0].id, data: { amount_cents: row.amount } });
    return o.rows[0].id as string;
  });
  await track(pool, { name: 'offer_made', userId: me, targetType: b.kind === 'goods' ? 'listing' : 'transport_request', targetId: (b.kind === 'goods' ? b.listing_id : b.request_id) as string });
  // Instant book: a fixed-price journey from a trusted driver is confirmed straight away for an eligible shipper. Anything unusual falls back to a normal pending offer.
  let booking_id: string | undefined;
  if (instantDriver && (await instantEligible(me))) { try { booking_id = (await acceptOffer(id, instantDriver)).booking_id; } catch (e) { console.error('instant book fell back to a normal offer:', (e as Error).message); } }
  return { ...(await offerView(id, me)), instant_booked: !!booking_id, booking_id: booking_id ?? undefined };
}
offers.post('/offers', requireAuth, wrap(async (req, res) => { res.status(201).json(await createOffer(req.user!.id, createSchema.parse(req.body))); }));

async function instantEligible(shipper: string) {
  const minAge = Number(await setting('instant_book.min_account_age_hours', 24));
  const u = (await pool.query(`SELECT email_verified_at IS NOT NULL AS verified, created_at < now() - ($2 || ' hours')::interval AS old_enough, (SELECT count(*)::int FROM disputes d WHERE d.opened_by=$1 AND d.status='open') AS open_disputes FROM users WHERE id=$1`, [shipper, String(minAge)])).rows[0];
  return !!u && u.verified && u.old_enough && u.open_disputes === 0;
}

// ------------------------------------------------------------------------------------------ read
offers.get('/offers', requireAuth, wrap(async (req, res) => {
  const q = z.object({ role: z.enum(['sent', 'received', 'all']).default('all'), state: z.enum(['active', 'closed', 'all']).default('all'), listing_id: uuid.optional(), request_id: uuid.optional() }).parse(req.query);
  const me = req.user!.id; await expireOffers();
  const where = [`(o.customer_id=$1 OR o.provider_id=$1)`];
  if (q.role === 'sent') where.push('o.proposer_id=$1'); if (q.role === 'received') where.push('o.proposer_id<>$1');
  if (q.state === 'active') where.push(`o.status='pending'`); if (q.state === 'closed') where.push(`o.status<>'pending'`);
  const p: unknown[] = [me]; if (q.listing_id) { p.push(q.listing_id); where.push(`o.listing_id=$${p.length}`); } if (q.request_id) { p.push(q.request_id); where.push(`o.request_id=$${p.length}`); }
  const { rows } = await pool.query(`SELECT o.id FROM offers o WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT 100`, p);
  const m = await offerViews(rows.map((r) => r.id), me);
  res.json({ items: rows.map((r) => m.get(r.id)) });
}));

async function loadOffer(c: Db, id: string, me: string, lock = false) {
  const o = (await c.query(`SELECT * FROM offers WHERE id=$1 ${lock ? 'FOR NO KEY UPDATE' : ''}`, [id])).rows[0];
  if (!o || (o.customer_id !== me && o.provider_id !== me)) throw notFound('Offer');
  return o;
}

offers.get('/offers/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  await loadOffer(pool, id, me); await expireOffers();
  // negotiation history = every version in the chain, oldest first, with its events
  const chain = (await pool.query(
    `WITH RECURSIVE up AS (SELECT * FROM offers WHERE id=$1 UNION ALL SELECT o.* FROM offers o JOIN up ON o.id = up.parent_offer_id),
          down AS (SELECT * FROM offers WHERE id=$1 UNION ALL SELECT o.* FROM offers o JOIN down ON o.parent_offer_id = down.id)
     SELECT id, proposer_id, amount_cents, status, message, created_at FROM (SELECT * FROM up UNION SELECT * FROM down) x ORDER BY created_at`, [id])).rows;
  const events = (await pool.query(`SELECT e.offer_id, e.kind, e.note, e.created_at, u.username AS actor FROM offer_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.offer_id = ANY($1::uuid[]) ORDER BY e.id`, [chain.map((c) => c.id)])).rows;
  const view = await offerView(id, me);
  res.json({ offer: view, history: chain.map((c) => ({ id: c.id, by: c.proposer_id === me ? 'you' : 'them', amount_cents: c.amount_cents, status: c.status, message: c.message, created_at: c.created_at })), events });
}));

// ------------------------------------------------------------------------------------------ respond
async function guardRespond(c: PoolClient, id: string, me: string) {
  const o = await loadOffer(c, id, me, true);
  const recipient = o.proposer_id === o.customer_id ? o.provider_id : o.customer_id;
  if (recipient !== me) throw new HttpError(403, 'Only the person who received this offer can respond to it', 'forbidden');
  if (o.status !== 'pending') throw conflict(`This offer is already ${o.status}`);
  if (new Date(o.expires_at) <= new Date()) {
    await c.query(`UPDATE offers SET status='expired', responded_at=now() WHERE id=$1`, [id]); await logEvent(c, id, null, 'expired');
    throw new HttpError(409, 'This offer has expired', 'expired');
  }
  return o;
}

export async function rejectOffer(id: string, me: string, reason?: string) {
  let expired = false;
  try {
    await tx(async (c) => {
      const o = await guardRespond(c, id, me);
      await c.query(`UPDATE offers SET status='rejected', responded_at=now() WHERE id=$1`, [id]); await logEvent(c, id, me, 'rejected', reason);
      const conv = await convFor(c, o); if (conv) await postCard(c, conv, me, 'offer', { offer_id: id, event: 'rejected' });
      await notify(c, { userId: o.proposer_id, type: 'offer_rejected', actorId: me, targetType: 'offer', targetId: id, data: { reason } });
    });
  } catch (e) { if (e instanceof HttpError && e.code === 'expired') expired = true; else throw e; }
  if (expired) { await pool.query(`UPDATE offers SET status='expired', responded_at=coalesce(responded_at, now()) WHERE id=$1 AND status='pending'`, [id]); throw new HttpError(409, 'This offer has expired', 'expired'); }
}
offers.post('/offers/:id/reject', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id; const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  await rejectOffer(id, me, reason); res.json(await offerView(id, me));
}));

export async function withdrawOffer(id: string, me: string) {
  await tx(async (c) => {
    const o = await loadOffer(c, id, me, true);
    if (o.proposer_id !== me) throw new HttpError(403, 'Only the person who made this offer can withdraw it', 'forbidden');
    if (o.status !== 'pending') throw conflict(`This offer is already ${o.status}`);
    await c.query(`UPDATE offers SET status='withdrawn', responded_at=now() WHERE id=$1`, [id]); await logEvent(c, id, me, 'withdrawn');
    const conv = await convFor(c, o); if (conv) await postCard(c, conv, me, 'offer', { offer_id: id, event: 'withdrawn' });
  });
}
offers.post('/offers/:id/withdraw', requireAuth, wrap(async (req, res) => { const id = uuid.parse(req.params.id); await withdrawOffer(id, req.user!.id); res.json(await offerView(id, req.user!.id)); }));

// ---- bundles: several shipments offered together. Each offer stays its own offer and becomes its own booking, so PINs, payments and disputes work exactly as before.
async function bundleRows(bundleId: string, me: string, as: 'recipient' | 'proposer') {
  return (await pool.query(
    `SELECT o.id, o.journey_id, r.weight_kg * r.quantity AS kg FROM offers o JOIN transport_requests r ON r.id=o.request_id
     WHERE o.bundle_id=$1 AND o.status='pending' AND o.expires_at > now() AND ${as === 'proposer' ? 'o.proposer_id=$2' : 'o.proposer_id <> $2 AND (o.customer_id=$2 OR o.provider_id=$2)'} ORDER BY o.created_at, o.id`, [bundleId, me])).rows as { id: string; journey_id: string | null; kg: string }[];
}
offers.post('/offers/bundle/:bundleId/accept', requireAuth, wrap(async (req, res) => {
  const bundleId = uuid.parse(req.params.bundleId); const me = req.user!.id; const rows = await bundleRows(bundleId, me, 'recipient');
  if (!rows.length) throw notFound('Bundle');
  const jid = rows[0].journey_id;
  if (jid) { const j = (await pool.query('SELECT remaining_kg FROM journeys WHERE id=$1', [jid])).rows[0]; const need = rows.reduce((a, r) => a + Number(r.kg), 0);
    if (j && need > j.remaining_kg) throw new HttpError(409, `These shipments add up to ${Math.ceil(need)} kg but only ${j.remaining_kg} kg is left on the journey. Accept them one at a time, or decline some.`, 'bundle_capacity'); }
  const accepted: { offer_id: string; booking_id?: string }[] = []; const failed: { offer_id: string; reason: string }[] = [];
  for (const r of rows) { try { const out = await acceptOffer(r.id, me); accepted.push({ offer_id: r.id, booking_id: out.booking_id }); } catch (e) { failed.push({ offer_id: r.id, reason: (e as Error).message }); } }
  res.json({ accepted, failed, partial: failed.length > 0 && accepted.length > 0 });
}));
offers.post('/offers/bundle/:bundleId/reject', requireAuth, wrap(async (req, res) => {
  const bundleId = uuid.parse(req.params.bundleId); const me = req.user!.id; const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {}); const rows = await bundleRows(bundleId, me, 'recipient');
  if (!rows.length) throw notFound('Bundle'); let n = 0; for (const r of rows) { try { await rejectOffer(r.id, me, reason); n++; } catch { /* already handled or expired */ } } res.json({ rejected: n });
}));
offers.post('/offers/bundle/:bundleId/withdraw', requireAuth, wrap(async (req, res) => {
  const bundleId = uuid.parse(req.params.bundleId); const me = req.user!.id; const rows = await bundleRows(bundleId, me, 'proposer');
  if (!rows.length) throw notFound('Bundle'); let n = 0; for (const r of rows) { try { await withdrawOffer(r.id, me); n++; } catch { /* already handled */ } } res.json({ withdrawn: n });
}));

async function fixedPriceOf(c: Db, o: any): Promise<boolean> {
  if (o.kind === 'goods') return (await c.query(`SELECT price_type IN ('fixed','free') AS f FROM listings WHERE id=$1`, [o.listing_id])).rows[0]?.f === true;
  if (o.journey_id) return (await c.query(`SELECT price_type='fixed' AS f FROM journeys WHERE id=$1`, [o.journey_id])).rows[0]?.f === true;
  if (o.service_id) return (await c.query(`SELECT (price_type='fixed' AND pricing_model='flat') AS f FROM transport_services WHERE id=$1`, [o.service_id])).rows[0]?.f === true;
  return (await c.query(`SELECT (price_type='fixed' AND budget_cents IS NOT NULL) AS f FROM transport_requests WHERE id=$1`, [o.request_id])).rows[0]?.f === true;
}

async function convFor(c: Db, o: any): Promise<string | null> {
  const subject = o.kind === 'goods' ? { type: 'listing' as const, id: o.listing_id } : o.journey_id ? { type: 'journey' as const, id: o.journey_id } : o.service_id ? { type: 'service' as const, id: o.service_id } : { type: 'transport_request' as const, id: o.request_id };
  return ensureConversation(c, o.customer_id, o.provider_id, subject);
}

offers.post('/offers/:id/counter', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const b = z.object({ amount_cents: z.number().int().min(1).max(100_000_000), message: z.string().trim().max(1000).optional(), expires_in_hours: z.number().int().min(1).max(720).optional() }).parse(req.body);
  await checkText(b.message);
  const hours = await expiryHours(b.expires_in_hours);
  const newId = await tx(async (c) => {
    const o = await guardRespond(c, id, me);
    if (await fixedPriceOf(c, o)) throw new HttpError(409, 'This has a fixed price, so it can be accepted or declined but not countered', 'fixed_price');
    if (o.kind === 'goods') {
      const l = (await c.query('SELECT price_cents FROM listings WHERE id=$1', [o.listing_id])).rows[0];
      if (b.amount_cents > l.price_cents * o.quantity) throw badRequest('A counteroffer cannot be above the asking price');
    }
    await c.query(`UPDATE offers SET status='countered', responded_at=now() WHERE id=$1`, [id]); await logEvent(c, id, me, 'countered', b.message);
    const n = await c.query(
      `INSERT INTO offers(kind,customer_id,provider_id,proposer_id,listing_id,request_id,journey_id,service_id,amount_cents,quantity,message,parent_offer_id,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + ($13 || ' hours')::interval) RETURNING id`,
      [o.kind, o.customer_id, o.provider_id, me, o.listing_id, o.request_id, o.journey_id, o.service_id, b.amount_cents, o.quantity, b.message ?? null, id, String(hours)]);
    await logEvent(c, n.rows[0].id, me, 'created', b.message);
    const conv = await convFor(c, o); if (conv) await postCard(c, conv, me, 'offer', { offer_id: n.rows[0].id, event: 'countered' });
    await notify(c, { userId: o.proposer_id, type: 'offer_countered', actorId: me, targetType: 'offer', targetId: n.rows[0].id, data: { amount_cents: b.amount_cents } });
    return n.rows[0].id as string;
  });
  res.status(201).json(await offerView(newId, me));
}));

// ------------------------------------------------------------------------------------------ accept → order or booking
const pin = () => crypto.randomInt(0, 10000).toString().padStart(4, '0');
const NIL_UNLESS = <T>(v: T | null | undefined) => v ?? null;

/** Accept an offer as `me` (the recipient). Shared by the accept route and instant book. */
export async function acceptOffer(id: string, me: string) {
  let expired = false;
  let result: { order_id?: string; booking_id?: string } = {};
  try {
    result = await tx(async (c) => {
      // Lock order is always: shared subject (listing / request) → offer → carrier (journey / service).
      // Taking the offer first would deadlock two accepts that each try to auto-reject the other's offer.
      const pre = (await c.query('SELECT kind, listing_id, request_id FROM offers WHERE id=$1', [id])).rows[0];
      if (!pre) throw notFound('Offer');
      if (pre.kind === 'goods') await c.query('SELECT 1 FROM listings WHERE id=$1 FOR NO KEY UPDATE', [pre.listing_id]);
      else await c.query('SELECT 1 FROM transport_requests WHERE id=$1 FOR NO KEY UPDATE', [pre.request_id]);
      const o = await guardRespond(c, id, me);
      const conv = await convFor(c, o);
      if (o.kind === 'goods') {
        const l = (await c.query('SELECT * FROM listings WHERE id=$1 FOR NO KEY UPDATE', [o.listing_id])).rows[0];
        if (!l || l.status !== 'active') throw conflict('This listing is no longer available');
        if (l.quantity < o.quantity) throw conflict(`Only ${l.quantity} left, which is fewer than this offer needs`);
        if ((await c.query(`SELECT status FROM users WHERE id=$1`, [l.seller_id])).rows[0].status !== 'active') throw conflict('This seller is not available');
        const ord = await c.query(`INSERT INTO orders(offer_id,listing_id,buyer_id,seller_id,quantity,total_cents) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [id, l.id, o.customer_id, o.provider_id, o.quantity, o.amount_cents]);
        const left = l.quantity - o.quantity;
        await c.query(`UPDATE listings SET quantity=$2, status = CASE WHEN $2 = 0 THEN 'sold' ELSE status END, updated_at=now() WHERE id=$1`, [l.id, left]);
        if (left === 0) await c.query(`UPDATE feed_items SET status='pending' WHERE item_type='listing' AND item_id=$1`, [l.id]);
        await c.query(`UPDATE offers SET status='accepted', responded_at=now() WHERE id=$1`, [id]); await logEvent(c, id, me, 'accepted');
        await rejectOpenOffers(c, { listingId: l.id }, me, left === 0 ? 'The item was sold' : 'Not enough left', id, left === 0 ? undefined : left);
        if (conv) await postCard(c, conv, me, 'offer', { offer_id: id, event: 'accepted', order_id: ord.rows[0].id });
        await notify(c, { userId: o.proposer_id, type: 'offer_accepted', actorId: me, targetType: 'order', targetId: ord.rows[0].id, data: { amount_cents: o.amount_cents } });
        return { order_id: ord.rows[0].id as string };
      }
      // ---- transport
      const r = (await c.query('SELECT * FROM transport_requests WHERE id=$1 FOR NO KEY UPDATE', [o.request_id])).rows[0];
      if (!r || r.status !== 'open') throw conflict('This request is no longer open');
      const need = Number(r.weight_kg) * r.quantity; const vol = volumeM3(r.length_cm, r.width_cm, r.height_cm, r.quantity);
      if (o.journey_id) {
        const j = (await c.query('SELECT * FROM journeys WHERE id=$1 FOR NO KEY UPDATE', [o.journey_id])).rows[0];
        if (!j || j.status !== 'open') throw conflict('This journey is no longer available');
        if (j.remaining_kg < need) throw conflict(`This journey now only has ${j.remaining_kg} kg of space left`);
        if (vol !== null && j.remaining_m3 !== null && Number(j.remaining_m3) < vol) throw conflict('This journey no longer has enough room');
        await c.query(`UPDATE journeys SET remaining_kg = remaining_kg - $2, remaining_m3 = CASE WHEN remaining_m3 IS NULL OR $3::numeric IS NULL THEN remaining_m3 ELSE remaining_m3 - $3 END,
           status = CASE WHEN remaining_kg - $2 <= 0 THEN 'full' ELSE status END WHERE id=$1`, [j.id, Math.ceil(need), vol]);
        if (j.remaining_kg - Math.ceil(need) <= 0) await c.query(`UPDATE feed_items SET status='pending' WHERE item_type='journey' AND item_id=$1`, [j.id]);
      }
      if (o.service_id) {
        const s = (await c.query('SELECT status, capacity_kg FROM transport_services WHERE id=$1 FOR NO KEY UPDATE', [o.service_id])).rows[0];
        if (!s || s.status !== 'active' || s.capacity_kg < need) throw conflict('This service is no longer available for this item');
      }
      const bk = await c.query(
        `INSERT INTO bookings(offer_id,request_id,journey_id,service_id,shipper_id,transporter_id,agreed_cents,reserved_kg,reserved_m3,pickup_pin,delivery_pin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [id, r.id, NIL_UNLESS(o.journey_id), NIL_UNLESS(o.service_id), o.customer_id, o.provider_id, o.amount_cents, o.journey_id ? need : 0, o.journey_id ? vol ?? 0 : 0, pin(), pin()])
        .catch((e) => { if (e.code === '23505') throw conflict('This shipment was just booked by someone else'); throw e; });
      await c.query(`UPDATE transport_requests SET status='booked' WHERE id=$1`, [r.id]);
      await c.query(`UPDATE feed_items SET status='pending' WHERE item_type='transport_request' AND item_id=$1`, [r.id]);
      await c.query(`UPDATE offers SET status='accepted', responded_at=now() WHERE id=$1`, [id]); await logEvent(c, id, me, 'accepted');
      await rejectOpenOffers(c, { requestId: r.id }, me, 'Another offer was accepted', id);
      await c.query(`INSERT INTO delivery_events(booking_id,actor_id,kind,note) VALUES ($1,$2,'booked','Booking confirmed')`, [bk.rows[0].id, me]);
      if (conv) await postCard(c, conv, me, 'offer', { offer_id: id, event: 'accepted', booking_id: bk.rows[0].id });
      await notify(c, { userId: o.proposer_id, type: 'offer_accepted', actorId: me, targetType: 'booking', targetId: bk.rows[0].id, data: { amount_cents: o.amount_cents } });
      return { booking_id: bk.rows[0].id as string };
    });
  } catch (e) { if (e instanceof HttpError && e.code === 'expired') expired = true; else throw e; }
  if (expired) { await pool.query(`UPDATE offers SET status='expired' WHERE id=$1 AND status='pending'`, [id]); throw new HttpError(409, 'This offer has expired', 'expired'); }
  await track(pool, { name: 'order_created', userId: me, targetType: result.order_id ? 'order' : 'booking', targetId: (result.order_id ?? result.booking_id) as string });
  return result;
}
offers.post('/offers/:id/accept', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const result = await acceptOffer(id, me);
  res.json({ offer: await offerView(id, me), ...result });
}));
