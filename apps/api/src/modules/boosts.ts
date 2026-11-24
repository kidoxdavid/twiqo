import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError, badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { setting } from '../lib/policy.js';
import { hydrateListings, hydratePosts } from '../lib/hydrate.js';
import { visibleTo } from '../lib/views.js';
import { paymentProvider } from '../lib/payments.js';
import { feeRule, paymentView, refundPayment } from './payments.js';
import { requireAuthStaff } from './disputes.js';
import { creditBalance } from './growth.js';

export const boosts = Router();
const uuid = z.string().uuid();

/** Which fee rule prices a boost. Prices are data: edit them in Admin → Config → Fees. */
const scopeFor = (target: string, placement: string) => (placement === 'sponsored' ? 'sponsored' : target === 'transport_service' ? 'featured_service' : 'premium_listing');

async function priceFor(target: string, placement: string) {
  const rule = await feeRule(pool, scopeFor(target, placement));
  return { price_cents: rule?.fixed_cents ?? 0, days: Number(await setting('boost.days', 7)) };
}

boosts.get('/boosts/pricing', wrap(async (_req, res) => {
  const options: { target_type: string; placement: string; label: string; price_cents: number; days: number }[] = [];
  for (const [t, p, label] of [['listing', 'featured', 'Feature this listing'], ['transport_service', 'featured', 'Feature this service'], ['listing', 'sponsored', 'Sponsor this listing in feeds'], ['post', 'sponsored', 'Sponsor this post in feeds']] as const) {
    const price = await priceFor(t, p); if (price.price_cents > 0) options.push({ target_type: t, placement: p, label, ...price });
  }
  res.json({ options, currency: 'CAD', note: 'Sponsored items are always labelled "Sponsored". Featured items rank higher in search and browse.' });
}));

async function ownedTarget(c: typeof pool | import('pg').PoolClient, type: string, id: string, me: string) {
  const q: Record<string, string> = {
    listing: `SELECT seller_id AS owner, status = 'active' AS ok FROM listings WHERE id=$1`,
    transport_service: `SELECT provider_id AS owner, status = 'active' AS ok FROM transport_services WHERE id=$1`,
    post: `SELECT author_id AS owner, (status = 'active' AND visibility = 'public' AND group_id IS NULL) AS ok FROM posts WHERE id=$1`,
  };
  const r = (await c.query(q[type], [id])).rows[0];
  if (!r || r.owner !== me) throw notFound('Item');
  if (!r.ok) throw conflict('Only live public items can be boosted');
}

boosts.post('/boosts', requireAuth, wrap(async (req, res) => {
  const b = z.object({ target_type: z.enum(['listing', 'transport_service', 'post']), target_id: uuid, placement: z.enum(['featured', 'sponsored']), use_credit: z.boolean().default(true) })
    .refine((v) => v.placement === 'sponsored' || v.target_type !== 'post', 'Posts can only be sponsored').parse(req.body);
  const me = req.user!.id; const prov = paymentProvider();
  if ((await setting('payments.enabled', true)) !== true) throw new HttpError(503, 'Card payments are switched off right now', 'payments_disabled');
  const price = await priceFor(b.target_type, b.placement);
  if (price.price_cents <= 0) throw badRequest('This boost is not available right now');
  const made = await tx(async (c) => {
    await ownedTarget(c, b.target_type, b.target_id, me);
    const live = (await c.query(`SELECT id, status FROM boosts WHERE target_type=$1 AND target_id=$2 AND placement=$3 AND status IN ('pending_payment','active')`, [b.target_type, b.target_id, b.placement])).rows[0];
    if (live?.status === 'active') throw conflict('This is already boosted');
    if (live) { const p = (await c.query(`SELECT * FROM payments WHERE boost_id=$1 AND status='requires_payment'`, [live.id])).rows[0]; if (p) return { boostId: live.id, payment: p, credit: false }; }
    if (b.use_credit && !live) {   // twiqo credit pays only when it covers the whole price; otherwise the card does
      await c.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [me]);
      if ((await creditBalance(c, me)) >= price.price_cents) {
        const bid = (await c.query(`INSERT INTO boosts(owner_id,target_type,target_id,placement,days,price_cents,credit_cents,status,starts_at,ends_at) VALUES ($1,$2,$3,$4,$5,$6,$6,'active',now(), now() + make_interval(days => $5)) RETURNING id`, [me, b.target_type, b.target_id, b.placement, price.days, price.price_cents])).rows[0].id as string;
        await c.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,ref_type,ref_id) VALUES ($1,$2,'boost_purchase','boost',$3)`, [me, -price.price_cents, bid]);
        return { boostId: bid, payment: null as any, credit: true };
      }
    }
    const boost = (await c.query(`INSERT INTO boosts(owner_id,target_type,target_id,placement,days,price_cents) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [me, b.target_type, b.target_id, b.placement, price.days, price.price_cents])).rows[0];
    const rule = await feeRule(c, scopeFor(b.target_type, b.placement));
    const p = (await c.query(`INSERT INTO payments(kind,boost_id,payer_id,amount_cents,fee_cents,fee_scope,fee_percent_bps,fee_fixed_cents,provider,description) VALUES ('boost',$1,$2,$3,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [boost.id, me, price.price_cents, scopeFor(b.target_type, b.placement), rule?.percent_bps ?? 0, rule?.fixed_cents ?? 0, prov.name, `twiqo ${b.placement} boost (${price.days} days)`])).rows[0];
    return { boostId: boost.id as string, payment: p, credit: false };
  });
  if (made.credit) return void res.status(201).json({ boost_id: made.boostId, paid_with_credit: true, payment: null, provider: prov.name });
  let payment = made.payment; let clientSecret: string | null;
  if (!payment.provider_payment_id) {
    try {
      const pi = await prov.createPayment({ amountCents: payment.amount_cents, currency: payment.currency, feeCents: 0, destinationAccountId: null, idempotencyKey: `pay:${payment.id}`, description: payment.description, metadata: { twiqo_payment_id: payment.id, kind: 'boost', boost_id: made.boostId } });
      payment = (await pool.query('UPDATE payments SET provider_payment_id=$2 WHERE id=$1 RETURNING *', [payment.id, pi.id])).rows[0]; clientSecret = pi.clientSecret;
    } catch (e) {
      await pool.query(`UPDATE payments SET status='failed', failure_reason='Could not start the payment' WHERE id=$1 AND provider_payment_id IS NULL`, [payment.id]);
      await pool.query(`UPDATE boosts SET status='canceled' WHERE id=$1 AND status='pending_payment'`, [made.boostId]);
      console.error('boost payment failed', (e as Error).message); throw new HttpError(502, 'We could not start the payment. Please try again.', 'provider_error');
    }
  } else clientSecret = (await prov.retrievePayment(payment.provider_payment_id)).clientSecret;
  res.status(201).json({ boost_id: made.boostId, payment: await paymentView(payment.id, me), client_secret: clientSecret, publishable_key: prov.publishableKey(), provider: prov.name });
}));

boosts.get('/boosts', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.target_type, b.target_id, b.placement, b.status, b.days, b.price_cents, b.impressions, b.starts_at, b.ends_at, b.created_at,
            coalesce(l.title, s.title, left(po.body, 60)) AS title
     FROM boosts b LEFT JOIN listings l ON b.target_type='listing' AND l.id=b.target_id LEFT JOIN transport_services s ON b.target_type='transport_service' AND s.id=b.target_id LEFT JOIN posts po ON b.target_type='post' AND po.id=b.target_id
     WHERE b.owner_id=$1 ORDER BY b.created_at DESC LIMIT 50`, [req.user!.id]);
  res.json({ items: rows });
}));

boosts.delete('/boosts/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  await tx(async (c) => {
    const b = (await c.query('SELECT * FROM boosts WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!b || b.owner_id !== me) throw notFound('Boost');
    if (b.status !== 'pending_payment') throw conflict('Only unpaid boosts can be cancelled here. Contact support to cancel an active boost.');
    await c.query(`UPDATE boosts SET status='canceled' WHERE id=$1`, [id]);
    const p = (await c.query(`UPDATE payments SET status='canceled' WHERE boost_id=$1 AND status='requires_payment' RETURNING provider_payment_id`, [id])).rows[0];
    if (p?.provider_payment_id) await paymentProvider().cancelPayment(p.provider_payment_id).catch(() => undefined);
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------------------------------------- sponsored items in feeds
/** One clearly-labelled sponsored item for a feed page, or null. Never the viewer's own, never blocked, never a duplicate. */
export async function pickSponsored(viewer: string | null, exclude: string[], pageSize: number) {
  const every = Number(await setting('ads.every_n', 8));
  if (!every || pageSize < every) return null;
  const { rows } = await pool.query(
    `SELECT b.id, b.target_type, b.target_id FROM boosts b
     WHERE b.status='active' AND b.placement='sponsored' AND b.ends_at > now() AND b.owner_id <> coalesce($1::uuid, '00000000-0000-0000-0000-000000000000') AND NOT (b.target_id = ANY($2::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id=$1::uuid AND bl.blocked_id=b.owner_id) OR (bl.blocker_id=b.owner_id AND bl.blocked_id=$1::uuid))
       AND (b.target_type <> 'listing' OR EXISTS (SELECT 1 FROM listings l WHERE l.id=b.target_id AND l.status='active' AND l.visibility='public' AND l.expires_at > now()))
       AND (b.target_type <> 'post' OR EXISTS (SELECT 1 FROM posts p WHERE p.id=b.target_id AND ${visibleTo('p', '$1')}))
     ORDER BY random() LIMIT 1`, [viewer, exclude]);
  const b = rows[0]; if (!b) return null;
  const item = b.target_type === 'listing' ? (await hydrateListings([b.target_id], viewer)).get(b.target_id) : (await hydratePosts([b.target_id], viewer)).get(b.target_id);
  if (!item) return null;
  await pool.query('UPDATE boosts SET impressions = impressions + 1 WHERE id=$1', [b.id]);
  return { ...item, sponsored: true };
}

// ---------------------------------------------------------------------------------------------- admin
boosts.get('/admin/boosts', requireAuthStaff(), wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT b.id, b.target_type, b.target_id, b.placement, b.status, b.price_cents, b.impressions, b.starts_at, b.ends_at, u.username FROM boosts b JOIN users u ON u.id=b.owner_id ORDER BY b.created_at DESC LIMIT 100`);
  res.json({ items: rows });
}));
boosts.post('/admin/boosts/:id/cancel', requireAuthStaff(), wrap(async (req, res) => {
  const b = z.object({ refund: z.boolean().default(false), reason: z.string().trim().min(3).max(300) }).parse(req.body); const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const x = (await c.query(`UPDATE boosts SET status='canceled' WHERE id=$1 AND status IN ('pending_payment','active') RETURNING id`, [id])).rows[0]; if (!x) throw notFound('Boost');
    await audit(c, req.user!.id, 'boost.cancel', 'boost', id, null, { reason: b.reason, refund: b.refund }, req.ip ?? null);
    const cr = (await c.query('SELECT owner_id, credit_cents FROM boosts WHERE id=$1', [id])).rows[0];
    if (b.refund && cr.credit_cents > 0) await c.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,ref_type,ref_id,note) VALUES ($1,$2,'boost_refund','boost',$3,$4)`, [cr.owner_id, cr.credit_cents, id, b.reason]);
  });
  if (b.refund) { const p = (await pool.query(`SELECT id FROM payments WHERE boost_id=$1 AND status IN ('succeeded','partially_refunded')`, [id])).rows[0]; if (p) await refundPayment(p.id, { reason: b.reason, source: 'admin', initiatedBy: req.user!.id, ip: req.ip ?? null }); }
  res.status(204).end();
}));
void forbidden;
