import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { HttpError, badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import { setting } from '../lib/policy.js';
import { proDiscountBps } from './subscriptions.js';
import { computeFee, paymentProvider, StripePaymentProvider, type NormalizedEvent } from '../lib/payments.js';

export const payments = Router();
const uuid = z.string().uuid();
const LIVE = ['requires_payment', 'processing', 'succeeded', 'partially_refunded'];

// ---------------------------------------------------------------------------------------------- helpers
export async function feeRule(db: Db, scope: string) {
  const r = (await db.query(`SELECT percent_bps, fixed_cents, min_cents, max_cents FROM fee_rules WHERE scope=$1 AND active AND effective_from <= now() ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [scope])).rows[0];
  return r ?? null;
}
const webOrigin = () => config.WEB_ORIGIN.split(',')[0];

async function syncSubject(c: Db, p: { order_id: string | null; booking_id: string | null; status: string }) {
  const ps = p.status === 'refunded' ? 'refunded' : p.status === 'partially_refunded' ? 'partially_refunded' : p.status === 'succeeded' ? 'paid' : null;
  if (!ps) return;
  if (p.order_id) await c.query('UPDATE orders SET payment_status=$2 WHERE id=$1', [p.order_id, ps]);
  if (p.booking_id) await c.query('UPDATE bookings SET payment_status=$2 WHERE id=$1', [p.booking_id, ps]);
}

export async function paymentView(id: string, viewer: string, staff = false) {
  const r = (await pool.query(
    `SELECT p.*, o.id AS oid, lo.title AS order_title, b.id AS bid, rq.title AS booking_title, bo.target_type AS boost_type, bo.placement AS boost_placement
     FROM payments p LEFT JOIN orders o ON o.id=p.order_id LEFT JOIN listings lo ON lo.id=o.listing_id LEFT JOIN bookings b ON b.id=p.booking_id
     LEFT JOIN transport_requests rq ON rq.id=b.request_id LEFT JOIN boosts bo ON bo.id=p.boost_id WHERE p.id=$1`, [id])).rows[0];
  if (!r || (!staff && r.payer_id !== viewer && r.payee_id !== viewer)) return null;
  const payee = r.payee_id === viewer; const payer = r.payer_id === viewer;
  const showFee = staff || payee || r.kind === 'boost';
  const keep = Number(r.refunded_cents);
  return {
    id: r.id, kind: r.kind, status: r.status, amount_cents: r.amount_cents, currency: r.currency, refunded_cents: keep, created_at: r.created_at, succeeded_at: r.succeeded_at, failure_reason: r.failure_reason ?? undefined,
    subject: r.kind === 'order' ? { type: 'order', id: r.order_id, title: r.order_title } : r.kind === 'booking' ? { type: 'booking', id: r.booking_id, title: r.booking_title } : { type: 'boost', id: r.boost_id, title: `${r.boost_placement === 'featured' ? 'Featured' : 'Sponsored'} ${String(r.boost_type).replace('_', ' ')}` },
    my_role: staff && !payer && !payee ? 'staff' : payer ? 'payer' : 'payee',
    ...(showFee ? { fee_cents: r.fee_cents, net_cents: r.kind === 'boost' ? 0 : r.amount_cents - r.fee_cents } : {}),
    can_pay: payer && ['requires_payment'].includes(r.status), can_refund: (payee || staff) && ['succeeded', 'partially_refunded'].includes(r.status) && keep < r.amount_cents,
  };
}

// ---------------------------------------------------------------------------------------------- connected account (sellers and drivers)
async function accountView(userId: string) {
  const a = (await pool.query('SELECT * FROM payment_accounts WHERE user_id=$1', [userId])).rows[0];
  const prov = paymentProvider();
  const status = !a ? 'not_started' : a.charges_enabled && a.payouts_enabled ? 'active' : 'incomplete';
  return { provider: prov.name, test_mode: prov.name === 'fake', status, charges_enabled: a?.charges_enabled ?? false, payouts_enabled: a?.payouts_enabled ?? false, details_submitted: a?.details_submitted ?? false, requirements_due: a?.requirements_due ?? [] };
}
export async function syncAccount(accountId: string) {
  const a = (await pool.query('SELECT user_id FROM payment_accounts WHERE provider_account_id=$1', [accountId])).rows[0]; if (!a) return;
  const pa = await paymentProvider().getAccount(accountId);
  await pool.query(`UPDATE payment_accounts SET charges_enabled=$2, payouts_enabled=$3, details_submitted=$4, requirements_due=$5, updated_at=now() WHERE provider_account_id=$1`, [accountId, pa.chargesEnabled, pa.payoutsEnabled, pa.detailsSubmitted, pa.requirementsDue]);
  if (pa.chargesEnabled && pa.payoutsEnabled) await notify(pool, { userId: a.user_id, type: 'payment_update', targetType: 'account', targetId: a.user_id, data: { event: 'payouts_ready' }, dedupeKey: `payouts-ready:${a.user_id}` });
}

payments.get('/payments/account', requireAuth, wrap(async (req, res) => {
  const a = (await pool.query('SELECT provider_account_id, charges_enabled, payouts_enabled FROM payment_accounts WHERE user_id=$1', [req.user!.id])).rows[0];
  if (a && !(a.charges_enabled && a.payouts_enabled) && paymentProvider().name !== 'fake') await syncAccount(a.provider_account_id).catch((e) => console.error('account sync failed', e.message));
  res.json(await accountView(req.user!.id));
}));

payments.post('/payments/account/onboarding', requireAuth, wrap(async (req, res) => {
  if ((await setting('payments.enabled', true)) !== true) throw new HttpError(503, 'Payments are switched off right now', 'payments_disabled');
  const me = req.user!.id; const prov = paymentProvider();
  let a = (await pool.query('SELECT provider_account_id FROM payment_accounts WHERE user_id=$1', [me])).rows[0];
  if (!a) {
    const email = (await pool.query('SELECT email FROM users WHERE id=$1', [me])).rows[0].email as string;
    const created = await prov.createAccount({ userId: me, email });
    await pool.query(`INSERT INTO payment_accounts(user_id, provider, provider_account_id) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING`, [me, prov.name, created.accountId]);
    a = (await pool.query('SELECT provider_account_id FROM payment_accounts WHERE user_id=$1', [me])).rows[0];
    if (prov instanceof StripePaymentProvider) await prov.setPayoutDelay(a.provider_account_id, Number(await setting('payments.payout_delay_days', 7))).catch((e) => console.error('payout delay not applied', e.message));
  }
  const url = await prov.accountLink(a.provider_account_id, `${webOrigin()}/settings/payments?onboarded=1`, `${webOrigin()}/settings/payments?refresh=1`);
  res.json({ url });
}));

payments.post('/payments/account/dashboard', requireAuth, wrap(async (req, res) => {
  const a = (await pool.query('SELECT provider_account_id FROM payment_accounts WHERE user_id=$1', [req.user!.id])).rows[0]; if (!a) throw notFound('Payout account');
  const url = await paymentProvider().dashboardLink(a.provider_account_id);
  if (!url) throw badRequest('No payout dashboard is available in test mode'); res.json({ url });
}));

// ---------------------------------------------------------------------------------------------- checkout
payments.post('/payments/checkout', requireAuth, wrap(async (req, res) => {
  const b = z.object({ order_id: uuid.optional(), booking_id: uuid.optional() }).refine((v) => !!v.order_id !== !!v.booking_id, 'Choose an order or a booking').parse(req.body);
  const me = req.user!.id; const prov = paymentProvider();
  if ((await setting('payments.enabled', true)) !== true) throw new HttpError(503, 'Card payments are switched off right now', 'payments_disabled');
  const created = await tx(async (c) => {
    const kind = b.order_id ? 'order' : 'booking';
    const s = kind === 'order'
      ? (await c.query(`SELECT o.id, o.buyer_id AS payer, o.seller_id AS payee, o.total_cents AS amount, o.status, l.title FROM orders o JOIN listings l ON l.id=o.listing_id WHERE o.id=$1 FOR NO KEY UPDATE OF o`, [b.order_id])).rows[0]
      : (await c.query(`SELECT b.id, b.shipper_id AS payer, b.transporter_id AS payee, b.agreed_cents AS amount, b.status, r.title FROM bookings b JOIN transport_requests r ON r.id=b.request_id WHERE b.id=$1 FOR NO KEY UPDATE OF b`, [b.booking_id])).rows[0];
    if (!s || s.payer !== me) throw notFound(kind === 'order' ? 'Order' : 'Booking');
    if (kind === 'order' ? s.status !== 'agreed' : ['cancelled', 'completed'].includes(s.status)) throw conflict(`This ${kind} is ${s.status}, so it can no longer be paid`);
    if (!(s.amount > 0)) throw badRequest('There is nothing to pay');
    if ((await c.query(`SELECT 1 FROM disputes WHERE ${kind}_id=$1 AND status='open'`, [s.id])).rowCount) throw conflict('Payment is paused while a dispute is open');
    const live = (await c.query(`SELECT * FROM payments WHERE ${kind}_id=$1 AND status = ANY($2)`, [s.id, LIVE])).rows[0];
    if (live && live.status !== 'requires_payment') throw conflict('This has already been paid');
    if (live) return { row: live, reuse: true };
    const acct = (await c.query('SELECT charges_enabled FROM payment_accounts WHERE user_id=$1', [s.payee])).rows[0];
    if (!acct?.charges_enabled) throw new HttpError(409, kind === 'order' ? "The seller hasn't set up card payments yet. You can still pay them directly." : "The driver hasn't set up card payments yet. You can still pay them directly.", 'payee_not_ready');
    const scope = kind === 'order' ? 'product_sale' : 'transport_booking'; const base = await feeRule(c, scope);
    const disc = await proDiscountBps(s.payee, c as any); const rule = base && disc > 0 ? { ...base, percent_bps: Math.max(0, base.percent_bps - disc) } : base; const fee = computeFee(rule, s.amount);
    const row = (await c.query(
      `INSERT INTO payments(kind,${kind}_id,payer_id,payee_id,amount_cents,fee_cents,fee_scope,fee_percent_bps,fee_fixed_cents,provider,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [kind, s.id, s.payer, s.payee, s.amount, fee, scope, rule?.percent_bps ?? 0, rule?.fixed_cents ?? 0, prov.name, `twiqo ${kind}: ${s.title}`.slice(0, 200)])).rows[0];
    return { row, reuse: false };
  });
  let row = created.row;
  if (!row.provider_payment_id) {
    // The provider call happens after the row is committed. The idempotency key makes a retry safe.
    try {
      const dest = (await pool.query('SELECT provider_account_id FROM payment_accounts WHERE user_id=$1', [row.payee_id])).rows[0].provider_account_id as string;
      const pi = await prov.createPayment({ amountCents: row.amount_cents, currency: row.currency, feeCents: row.fee_cents, destinationAccountId: dest, idempotencyKey: `pay:${row.id}`, description: row.description,
        metadata: { twiqo_payment_id: row.id, kind: row.kind, ...(row.order_id ? { order_id: row.order_id } : { booking_id: row.booking_id }) } });
      row = (await pool.query('UPDATE payments SET provider_payment_id=$2 WHERE id=$1 RETURNING *', [row.id, pi.id])).rows[0];
      return void res.status(201).json({ payment: await paymentView(row.id, me), client_secret: pi.clientSecret, publishable_key: prov.publishableKey(), provider: prov.name });
    } catch (e) {
      await pool.query(`UPDATE payments SET status='failed', failure_reason='Could not start the payment' WHERE id=$1 AND provider_payment_id IS NULL`, [row.id]);
      console.error('create payment failed', (e as Error).message);
      throw new HttpError(502, 'We could not start the payment. Please try again.', 'provider_error');
    }
  }
  const pi = await prov.retrievePayment(row.provider_payment_id);
  res.status(created.reuse ? 200 : 201).json({ payment: await paymentView(row.id, me), client_secret: pi.clientSecret, publishable_key: prov.publishableKey(), provider: prov.name });
}));

payments.get('/payments', requireAuth, wrap(async (req, res) => {
  const role = z.enum(['payer', 'payee', 'all']).default('all').parse(req.query.role ?? 'all'); const me = req.user!.id;
  const { rows } = await pool.query(`SELECT id FROM payments WHERE ${role === 'payer' ? 'payer_id=$1' : role === 'payee' ? 'payee_id=$1' : '(payer_id=$1 OR payee_id=$1)'} AND status <> 'canceled' ORDER BY created_at DESC LIMIT 100`, [me]);
  res.json({ items: (await Promise.all(rows.map((r) => paymentView(r.id, me)))).filter(Boolean) });
}));
payments.get('/payments/earnings', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  const t = (await pool.query(
    `SELECT coalesce(sum(amount_cents),0)::int AS gross, coalesce(sum(fee_cents),0)::int AS fees, coalesce(sum(refunded_cents),0)::int AS refunded,
            coalesce(sum((amount_cents - fee_cents) - round(refunded_cents::numeric * (amount_cents - fee_cents) / amount_cents)),0)::int AS net
     FROM payments WHERE payee_id=$1 AND status IN ('succeeded','partially_refunded','refunded')`, [me])).rows[0];
  const payouts = (await pool.query('SELECT provider_payout_id AS id, amount_cents, currency, status, arrival_date, created_at FROM payouts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [me])).rows;
  res.json({ gross_cents: t.gross, fee_cents: t.fees, refunded_cents: t.refunded, net_cents: t.net, payouts, note: 'Payouts are made by Stripe to your bank account on the schedule shown in your Stripe dashboard.' });
}));
payments.get('/payments/:id', requireAuth, wrap(async (req, res) => {
  const v = await paymentView(uuid.parse(req.params.id), req.user!.id, req.user!.permissions.includes('manage.payments'));
  if (!v) throw notFound('Payment'); res.json(v);
}));

// ---------------------------------------------------------------------------------------------- refunds
export interface RefundOpts { amountCents?: number; reason: string; source: 'seller' | 'admin' | 'dispute' | 'cancellation'; initiatedBy: string | null; ip?: string | null }

/** Refund part or all of a payment. Over-refunding is impossible: pending refunds count against the remainder under a row lock. */
export async function refundPayment(paymentId: string, o: RefundOpts) {
  const prov = paymentProvider();
  const claim = await tx(async (c) => {
    const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR NO KEY UPDATE', [paymentId])).rows[0];
    if (!p) throw notFound('Payment');
    if (!['succeeded', 'partially_refunded'].includes(p.status)) throw conflict('Only paid payments can be refunded');
    const pending = (await c.query(`SELECT coalesce(sum(amount_cents),0)::int n FROM refunds WHERE payment_id=$1 AND status='pending'`, [paymentId])).rows[0].n;
    const remaining = p.amount_cents - p.refunded_cents - pending;
    if (remaining <= 0) throw conflict('This payment has already been fully refunded');
    const amount = o.amountCents ?? remaining;
    if (!Number.isInteger(amount) || amount < 1) throw badRequest('Enter a refund amount');
    if (amount > remaining) throw conflict(`Only ${(remaining / 100).toFixed(2)} is left to refund`);
    const r = (await c.query(`INSERT INTO refunds(payment_id,amount_cents,reason,source,initiated_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [paymentId, amount, o.reason, o.source, o.initiatedBy])).rows[0];
    return { refundId: r.id as string, amount, payment: p };
  });
  let result: { id: string; status: 'pending' | 'succeeded' | 'failed' };
  try {
    result = await prov.refund({ paymentId: claim.payment.provider_payment_id, amountCents: claim.amount, hasTransfer: !!claim.payment.payee_id,
      refundFee: (await setting('payments.refund_platform_fee', true)) === true, reason: o.source === 'cancellation' ? 'requested_by_customer' : undefined, idempotencyKey: `refund:${claim.refundId}`, metadata: { twiqo_payment_id: paymentId, twiqo_refund_id: claim.refundId } });
  } catch (e) {
    await pool.query(`UPDATE refunds SET status='failed' WHERE id=$1 AND status='pending'`, [claim.refundId]);
    console.error('refund failed', (e as Error).message);
    throw new HttpError(502, 'The refund could not be processed. Nothing was changed.', 'provider_error');
  }
  await tx(async (c) => {
    const dupe = (await c.query('SELECT id FROM refunds WHERE provider_refund_id=$1 AND id<>$2', [result.id, claim.refundId])).rows[0];
    if (dupe) { await c.query('DELETE FROM refunds WHERE id=$1', [claim.refundId]); return; }   // a webhook already recorded it
    await c.query('UPDATE refunds SET provider_refund_id=$2 WHERE id=$1 AND provider_refund_id IS NULL', [claim.refundId, result.id]);
    if (result.status === 'succeeded') await applyRefundSuccess(c, claim.refundId);
    await audit(c, o.initiatedBy, 'payment.refund', 'payment', paymentId, null, { amount_cents: claim.amount, source: o.source, reason: o.reason }, o.ip ?? null);
  });
  return { refund_id: claim.refundId, amount_cents: claim.amount, status: result.status };
}

/** Idempotent: a refund row is applied to the payment exactly once. */
async function applyRefundSuccess(c: PoolClient, refundId: string) {
  const r = (await c.query(`UPDATE refunds SET status='succeeded' WHERE id=$1 AND status <> 'succeeded' RETURNING payment_id, amount_cents`, [refundId])).rows[0];
  if (!r) return;
  const p = (await c.query(
    `UPDATE payments SET refunded_cents = least(amount_cents, refunded_cents + $2), status = CASE WHEN refunded_cents + $2 >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END WHERE id=$1 RETURNING *`, [r.payment_id, r.amount_cents])).rows[0];
  await syncSubject(c, p);
  if (p.kind === 'boost' && p.status === 'refunded') await c.query(`UPDATE boosts SET status='canceled' WHERE id=$1 AND status IN ('pending_payment','active')`, [p.boost_id]);
  await notify(c, { userId: p.payer_id, type: 'payment_update', targetType: 'payment', targetId: p.id, data: { event: 'refunded', amount_cents: r.amount_cents } });
}

payments.post('/payments/:id/refund', requireAuth, wrap(async (req, res) => {
  const b = z.object({ amount_cents: z.number().int().min(1).optional(), reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const id = uuid.parse(req.params.id); const me = req.user!.id; const staff = req.user!.permissions.includes('manage.payments');
  const p = (await pool.query('SELECT payee_id, payer_id FROM payments WHERE id=$1', [id])).rows[0];
  if (!p || (p.payee_id !== me && !staff)) throw notFound('Payment');
  const out = await refundPayment(id, { amountCents: b.amount_cents, reason: b.reason, source: p.payee_id === me ? 'seller' : 'admin', initiatedBy: me, ip: req.ip ?? null });
  res.json({ ...out, payment: await paymentView(id, me, staff) });
}));

/** Used when an order or booking is cancelled: undo the charge (cancel it if unpaid, refund it if paid). Never throws. */
export async function settleCancelled(subject: { orderId?: string; bookingId?: string }, initiatedBy: string | null) {
  try {
    const col = subject.orderId ? 'order_id' : 'booking_id'; const id = subject.orderId ?? subject.bookingId;
    const p = (await pool.query(`SELECT * FROM payments WHERE ${col}=$1 AND status = ANY($2)`, [id, LIVE])).rows[0]; if (!p) return;
    if (p.status === 'requires_payment') {
      await pool.query(`UPDATE payments SET status='canceled' WHERE id=$1 AND status='requires_payment'`, [p.id]);
      if (p.provider_payment_id) await paymentProvider().cancelPayment(p.provider_payment_id).catch(() => undefined);
    } else await refundPayment(p.id, { reason: 'Cancelled before completion', source: 'cancellation', initiatedBy });
  } catch (e) { console.error('cancellation settlement failed (will be retried)', (e as Error).message); }
}

// ---------------------------------------------------------------------------------------------- webhook events
/** Apply one provider event. Safe to call repeatedly: the event id is recorded in the same transaction. */
export async function handleEvent(ev: NormalizedEvent, provider = paymentProvider().name): Promise<'applied' | 'duplicate' | 'ignored'> {
  if (ev.type === 'ignored') return 'ignored';
  const followUps: (() => Promise<unknown>)[] = [];
  const outcome = await tx(async (c): Promise<'applied' | 'duplicate'> => {
    const fresh = await c.query(`INSERT INTO webhook_events(id,provider,type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [ev.id, provider, ev.type]);
    if (!fresh.rowCount) return 'duplicate';
    if (ev.type === 'payment.succeeded') {
      const p = (await c.query('SELECT * FROM payments WHERE provider_payment_id=$1 FOR NO KEY UPDATE', [ev.paymentId])).rows[0];
      if (p && !['succeeded', 'partially_refunded', 'refunded'].includes(p.status)) {
        const upd = (await c.query(`UPDATE payments SET status='succeeded', succeeded_at=now(), provider_charge_id=$2, failure_reason=NULL WHERE id=$1 RETURNING *`, [p.id, ev.chargeId ?? null])).rows[0];
        await syncSubject(c, upd);
        if (p.kind === 'boost') await c.query(`UPDATE boosts SET status='active', starts_at=now(), ends_at=now() + (days || ' days')::interval WHERE id=$1 AND status='pending_payment'`, [p.boost_id]);
        const cancelled = p.order_id ? (await c.query(`SELECT status FROM orders WHERE id=$1`, [p.order_id])).rows[0]?.status === 'cancelled' : p.booking_id ? (await c.query(`SELECT status FROM bookings WHERE id=$1`, [p.booking_id])).rows[0]?.status === 'cancelled' : false;
        if (cancelled || (p.kind === 'boost' && (await c.query(`SELECT status FROM boosts WHERE id=$1`, [p.boost_id])).rows[0]?.status === 'canceled')) followUps.push(() => refundPayment(p.id, { reason: 'Paid after it was cancelled', source: 'cancellation', initiatedBy: null }).catch((e) => console.error('late refund failed', e.message)));
        else {
          if (p.payee_id) await notify(c, { userId: p.payee_id, type: 'payment_update', actorId: p.payer_id, targetType: 'payment', targetId: p.id, data: { event: 'received', amount_cents: p.amount_cents - p.fee_cents } });
          await notify(c, { userId: p.payer_id, type: 'payment_update', targetType: 'payment', targetId: p.id, data: { event: 'paid', amount_cents: p.amount_cents } });
        }
      }
    } else if (ev.type === 'payment.failed') {
      await c.query(`UPDATE payments SET status='failed', failure_reason=$2 WHERE provider_payment_id=$1 AND status IN ('requires_payment','processing')`, [ev.paymentId, ev.failureReason ?? 'The payment failed']);
    } else if (ev.type === 'refund.updated' && ev.refundId) {
      const p = (await c.query('SELECT id FROM payments WHERE provider_payment_id=$1 FOR NO KEY UPDATE', [ev.paymentId])).rows[0];
      if (p) {
        let row = (await c.query('SELECT id, status FROM refunds WHERE provider_refund_id=$1', [ev.refundId])).rows[0];
        if (!row) row = (await c.query(`UPDATE refunds SET provider_refund_id=$2 WHERE id = (SELECT id FROM refunds WHERE payment_id=$1 AND provider_refund_id IS NULL AND status='pending' AND amount_cents=$3 ORDER BY created_at LIMIT 1) RETURNING id, status`, [p.id, ev.refundId, ev.refundAmount])).rows[0];
        if (!row) row = (await c.query(`INSERT INTO refunds(payment_id,amount_cents,reason,source,status,provider_refund_id) VALUES ($1,$2,'Issued from the payment provider','provider','pending',$3) RETURNING id, status`, [p.id, ev.refundAmount, ev.refundId])).rows[0];
        if (ev.refundStatus === 'succeeded') await applyRefundSuccess(c, row.id);
        else if (ev.refundStatus === 'failed') await c.query(`UPDATE refunds SET status='failed' WHERE id=$1 AND status='pending'`, [row.id]);
      }
    } else if (ev.type === 'account.updated' && ev.accountId) followUps.push(() => syncAccount(ev.accountId!));
    else if (ev.type === 'payout.updated' && ev.payout && ev.accountId) {
      const a = (await c.query('SELECT user_id FROM payment_accounts WHERE provider_account_id=$1', [ev.accountId])).rows[0];
      if (a) await c.query(`INSERT INTO payouts(user_id,provider_payout_id,amount_cents,currency,status,arrival_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider_payout_id) DO UPDATE SET status=EXCLUDED.status, arrival_date=EXCLUDED.arrival_date`, [a.user_id, ev.payout.id, ev.payout.amount, ev.payout.currency ?? 'CAD', ev.payout.status, ev.payout.arrival ?? null]);
    } else if (ev.type === 'subscription.updated' && ev.subscription) {
      const sub = ev.subscription;
      const known = (await c.query('SELECT user_id, status FROM subscriptions WHERE provider_subscription_id=$1 OR provider_customer_id=$2', [sub.id, sub.customerId])).rows[0];
      const userId = sub.userId ?? known?.user_id;
      if (userId && (await c.query('SELECT 1 FROM users WHERE id=$1', [userId])).rowCount && !(known?.status === 'canceled' && sub.status !== 'canceled' && known?.user_id === userId && (await c.query('SELECT 1 FROM subscriptions WHERE user_id=$1 AND provider_subscription_id=$2', [userId, sub.id])).rowCount)) {
        await c.query(
          `INSERT INTO subscriptions(user_id,status,provider,provider_customer_id,provider_subscription_id,current_period_end,cancel_at_period_end) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (user_id) DO UPDATE SET status=$2, provider_customer_id=$4, provider_subscription_id=$5, current_period_end=$6, cancel_at_period_end=$7, updated_at=now()`,
          [userId, sub.status, provider, sub.customerId, sub.id, sub.periodEnd ?? null, sub.cancelAtPeriodEnd]);
        if (!known || known.status !== sub.status) await notify(c, { userId, type: 'subscription_update', targetType: 'subscription', targetId: userId, data: { status: sub.status }, dedupeKey: `sub:${sub.id}:${sub.status}` });
      }
    } else if (ev.type === 'card_dispute.created') {
      const p = (await c.query('SELECT id FROM payments WHERE provider_payment_id=$1', [ev.paymentId])).rows[0];
      await audit(c, null, 'payment.card_dispute', 'payment', p?.id ?? null, null, { provider_payment_id: ev.paymentId });
      for (const s of (await c.query(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_key=ur.role_key WHERE rp.permission_key='manage.payments'`)).rows)
        await notify(c, { userId: s.user_id, type: 'payment_update', targetType: 'payment', targetId: p?.id, data: { event: 'card_dispute' } });
    }
    await c.query('UPDATE webhook_events SET processed_at=now() WHERE id=$1', [ev.id]);
    return 'applied';
  });
  if (outcome === 'applied') for (const f of followUps) await f();
  return outcome;
}

/** Express handler for the raw-body webhook route (mounted before the JSON parser in app.ts). */
export async function webhookHandler(req: Request, res: Response) {
  let ev: NormalizedEvent;
  try { ev = paymentProvider().parseWebhook(req.body as Buffer, req.headers); } catch { return void res.status(400).json({ error: { code: 'bad_signature', message: 'Invalid webhook signature' } }); }
  try { const outcome = await handleEvent(ev); res.status(200).json({ received: true, outcome }); }
  catch (e) { console.error('webhook processing failed', e); res.status(500).json({ error: { code: 'internal', message: 'Processing failed, please retry' } }); }
}

// ---------------------------------------------------------------------------------------------- test-mode helpers (fake provider, never in production)
const fakeOnly = () => { if (config.PAYMENT_PROVIDER !== 'fake' || config.NODE_ENV === 'production') throw notFound('Route'); };
payments.post('/payments/fake/onboarding/complete', requireAuth, wrap(async (req, res) => {
  fakeOnly();
  const r = await pool.query(`UPDATE payment_accounts SET charges_enabled=true, payouts_enabled=true, details_submitted=true, requirements_due='{}', updated_at=now() WHERE user_id=$1 RETURNING provider_account_id`, [req.user!.id]);
  if (!r.rowCount) throw badRequest('Start payout setup first');
  res.json(await accountView(req.user!.id));
}));
payments.post('/payments/fake/pay', requireAuth, wrap(async (req, res) => {
  fakeOnly();
  const b = z.object({ payment_id: uuid, outcome: z.enum(['succeeded', 'failed']).default('succeeded') }).parse(req.body);
  const p = (await pool.query('SELECT provider_payment_id, payer_id FROM payments WHERE id=$1', [b.payment_id])).rows[0];
  if (!p || p.payer_id !== req.user!.id) throw notFound('Payment');
  const id = `evt_fake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await handleEvent(b.outcome === 'succeeded' ? { id, type: 'payment.succeeded', paymentId: p.provider_payment_id, chargeId: `ch_fake_${id.slice(-6)}` } : { id, type: 'payment.failed', paymentId: p.provider_payment_id, failureReason: 'Your card was declined (test)' });
  res.json(await paymentView(b.payment_id, req.user!.id));
}));

void forbidden;
