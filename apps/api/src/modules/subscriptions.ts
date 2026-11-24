import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError, badRequest, notFound, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { setting } from '../lib/policy.js';
import { paymentProvider } from '../lib/payments.js';
import { handleEvent } from './payments.js';

export const subscriptions = Router();
const origin = () => config.WEB_ORIGIN.split(',')[0];

/** A subscription counts while active, or briefly past due (Stripe is still retrying the card). */
export async function isPro(userId: string, db = pool) {
  return !!(await db.query(`SELECT 1 FROM subscriptions WHERE user_id=$1 AND status IN ('active','past_due') AND (current_period_end IS NULL OR current_period_end > now() - interval '3 days')`, [userId])).rowCount;
}
/** Percentage points (basis points) taken off the commission for this payee. */
export async function proDiscountBps(userId: string, db = pool) { return (await isPro(userId, db)) ? Math.max(0, Number(await setting('subscription.fee_discount_bps', 100, db))) : 0; }

async function view(userId: string) {
  const s = (await pool.query('SELECT status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id=$1', [userId])).rows[0];
  const discount = Number(await setting('subscription.fee_discount_bps', 100));
  return { plan: 'business_pro', name: 'Business Pro', price_cents: Number(await setting('subscription.business_pro_cents', 2900)), currency: 'CAD', interval: 'month', test_mode: paymentProvider().name === 'fake',
    enabled: (await setting('subscription.enabled', true)) === true, active: await isPro(userId), status: s?.status ?? 'none', current_period_end: s?.current_period_end ?? null, cancel_at_period_end: s?.cancel_at_period_end ?? false,
    benefits: [`${(discount / 100).toFixed(discount % 100 ? 2 : 0)} percentage points off twiqo's commission on your card sales and bookings`, 'Daily trends and conversion in your insights', 'Cancel any time; benefits continue to the end of the paid period'],
    note: 'Billed monthly through Stripe. No taxes are added by twiqo yet.' };
}

subscriptions.get('/subscriptions/me', requireAuth, wrap(async (req, res) => { res.json(await view(req.user!.id)); }));

subscriptions.post('/subscriptions/checkout', requireAuth, wrap(async (req, res) => {
  if ((await setting('subscription.enabled', true)) !== true) throw new HttpError(503, 'Subscriptions are switched off right now', 'disabled');
  const me = req.user!.id; if (await isPro(me)) throw new HttpError(409, 'You already have Business Pro', 'conflict');
  const u = (await pool.query('SELECT email, (SELECT provider_customer_id FROM subscriptions WHERE user_id=$1) AS customer FROM users WHERE id=$1', [me])).rows[0];
  try {
    const r = await paymentProvider().createSubscriptionCheckout({ userId: me, email: u.email, customerId: u.customer, successUrl: `${origin()}/settings/pro?subscribed=1`, cancelUrl: `${origin()}/settings/pro` });
    res.json({ url: r.url });
  } catch (e) { console.error('subscription checkout failed', (e as Error).message); throw new HttpError(502, 'We could not start checkout. Please try again.', 'provider_error'); }
}));

subscriptions.post('/subscriptions/portal', requireAuth, wrap(async (req, res) => {
  const s = (await pool.query('SELECT provider_customer_id FROM subscriptions WHERE user_id=$1', [req.user!.id])).rows[0];
  if (!s?.provider_customer_id) throw notFound('Subscription');
  const url = await paymentProvider().subscriptionPortal(s.provider_customer_id, `${origin()}/settings/pro`);
  if (!url) throw badRequest('The billing portal is not available in test mode');
  res.json({ url });
}));

// test-mode helpers (fake provider only, never in production)
const fakeOnly = () => { if (config.PAYMENT_PROVIDER !== 'fake' || config.NODE_ENV === 'production') throw notFound('Route'); };
subscriptions.post('/subscriptions/fake/activate', requireAuth, wrap(async (req, res) => {
  fakeOnly(); const me = req.user!.id; const id = `evt_fake_sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await handleEvent({ id, type: 'subscription.updated', subscription: { id: `sub_fake_${me.slice(0, 8)}`, customerId: `cus_fake_${me.slice(0, 8)}`, userId: me, status: 'active', periodEnd: new Date(Date.now() + 30 * 864e5).toISOString(), cancelAtPeriodEnd: false } });
  res.json(await view(me));
}));
subscriptions.post('/subscriptions/fake/cancel', requireAuth, wrap(async (req, res) => {
  fakeOnly(); const me = req.user!.id; const s = (await pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [me])).rows[0]; if (!s) throw notFound('Subscription');
  const b = z.object({ immediately: z.boolean().default(false) }).parse(req.body ?? {});
  await handleEvent({ id: `evt_fake_sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, type: 'subscription.updated', subscription: { id: s.provider_subscription_id, customerId: s.provider_customer_id, userId: me, status: b.immediately ? 'canceled' : 'active', periodEnd: s.current_period_end?.toISOString(), cancelAtPeriodEnd: !b.immediately } });
  res.json(await view(me));
}));
