import { pool, tx } from '../db/pool.js';
import { setting } from './policy.js';
import { expireOffers, rejectOpenOffers } from '../modules/offers.js';
import { completeBooking } from '../modules/bookings.js';
import { notify } from './notify.js';
import { enqueue, registerJob, runQueue } from './queue.js';
import './email.js';
import './delivery.js';
import { sendDigests } from './delivery.js';
import { refundPayment } from '../modules/payments.js';
import { paymentProvider } from './payments.js';

/** Idempotent housekeeping. Runs on an interval today; move to a queue worker when one exists. */
export async function runHousekeeping() {
  const out = { offers: 0, listings: 0, journeys: 0, requests: 0, bookings: 0, stories: 0, reminders: 0, boosts: 0, abandoned_payments: 0, retried_refunds: 0, pruned_events: 0, digests: 0 };
  out.offers = await expireOffers();

  const l = await pool.query(`UPDATE listings SET status='expired' WHERE status='active' AND expires_at < now() RETURNING id`);
  if (l.rowCount) await pool.query(`UPDATE feed_items SET status='pending' WHERE item_type='listing' AND item_id = ANY($1::uuid[])`, [l.rows.map((x) => x.id)]);
  out.listings = l.rowCount ?? 0;

  const js = await pool.query(`SELECT id FROM journeys WHERE status IN ('open','full') AND departure_at < now()`);
  for (const j of js.rows) await tx(async (c) => {
    await c.query(`UPDATE journeys SET status='departed' WHERE id=$1 AND status IN ('open','full')`, [j.id]);
    await c.query(`UPDATE feed_items SET status='pending' WHERE item_type='journey' AND item_id=$1`, [j.id]);
    await rejectOpenOffers(c, { journeyId: j.id }, null, 'The journey has departed');
  });
  out.journeys = js.rowCount ?? 0;

  const grace = Number(await setting('transport.request_expiry_grace_days', 1));
  const rs = await pool.query(`SELECT id FROM transport_requests WHERE status='open' AND pickup_to + ($1::int) < current_date`, [grace]);
  for (const r of rs.rows) await tx(async (c) => {
    await c.query(`UPDATE transport_requests SET status='expired' WHERE id=$1 AND status='open'`, [r.id]);
    await c.query(`UPDATE feed_items SET status='pending' WHERE item_type='transport_request' AND item_id=$1`, [r.id]);
    await rejectOpenOffers(c, { requestId: r.id }, null, 'The request expired');
  });
  out.requests = rs.rowCount ?? 0;

  const hours = Number(await setting('booking.auto_complete_hours', 72));
  const bs = await pool.query(`SELECT id FROM bookings WHERE status='delivered' AND delivered_at < now() - ($1::int || ' hours')::interval AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id=bookings.id AND d.status='open')`, [hours]);
  for (const b of bs.rows) await tx((c) => completeBooking(c, b.id, null).then(() => undefined));
  out.bookings = bs.rowCount ?? 0;

  out.stories = (await pool.query(`UPDATE stories SET status='expired' WHERE status='active' AND expires_at < now()`)).rowCount ?? 0;

  const remindH = Number(await setting('event.reminder_hours', 24));
  const evs = (await pool.query(`SELECT e.id, e.title FROM events e WHERE e.status='scheduled' AND e.starts_at > now() AND e.starts_at < now() + ($1::int || ' hours')::interval`, [remindH])).rows;
  for (const e of evs) for (const r of (await pool.query(`SELECT user_id FROM event_rsvps WHERE event_id=$1`, [e.id])).rows)
    if (await notify(pool, { userId: r.user_id, type: 'event_reminder', targetType: 'event', targetId: e.id, data: { title: e.title }, dedupeKey: e.id })) out.reminders++;

  // boosts: expire finished ones; unpaid ones are abandoned after a day
  out.boosts = (await pool.query(`UPDATE boosts SET status='expired' WHERE status='active' AND ends_at < now()`)).rowCount ?? 0;
  const stale = (await pool.query(`UPDATE payments SET status='canceled' WHERE status='requires_payment' AND created_at < now() - interval '24 hours' RETURNING id, provider_payment_id, boost_id`)).rows;
  for (const p of stale) {
    if (p.provider_payment_id) await paymentProvider().cancelPayment(p.provider_payment_id).catch(() => undefined);
    if (p.boost_id) await pool.query(`UPDATE boosts SET status='canceled' WHERE id=$1 AND status='pending_payment'`, [p.boost_id]);
  }
  out.abandoned_payments = stale.length;

  // paid but the order/booking was cancelled and the automatic refund failed: try again
  const owed = (await pool.query(`SELECT p.id FROM payments p WHERE p.status IN ('succeeded','partially_refunded') AND p.refunded_cents < p.amount_cents AND p.kind <> 'boost'
    AND ((p.order_id IS NOT NULL AND EXISTS (SELECT 1 FROM orders o WHERE o.id=p.order_id AND o.status='cancelled')) OR (p.booking_id IS NOT NULL AND EXISTS (SELECT 1 FROM bookings b WHERE b.id=p.booking_id AND b.status='cancelled')))
    AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id=p.id AND r.status='pending') LIMIT 25`)).rows;
  for (const p of owed) { try { await refundPayment(p.id, { reason: 'Cancelled before completion', source: 'cancellation', initiatedBy: null }); out.retried_refunds++; } catch (e) { console.error('refund retry failed', (e as Error).message); } }
  out.digests = await sendDigests();
  out.pruned_events = (await pool.query(`DELETE FROM analytics_events WHERE created_at < now() - interval '180 days'`)).rowCount ?? 0;
  return out;
}

/** Housekeeping runs as a queued job that schedules its own next run, so with several API servers only one runs it at a time. */
registerJob('housekeeping', async () => {
  try { await runHousekeeping(); } finally { await enqueue(pool, 'housekeeping', {}, { runAt: new Date(Date.now() + 5 * 60_000), dedupeKey: 'housekeeping' }); }
});
export async function startWorker() {
  await enqueue(pool, 'housekeeping', {}, { dedupeKey: 'housekeeping' });
  setInterval(() => { runQueue().catch((e) => console.error('queue worker failed', e)); }, 3000).unref();
}
