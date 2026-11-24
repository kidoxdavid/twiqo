import { pool, tx } from '../db/pool.js';
import { setting } from './policy.js';
import { expireOffers, rejectOpenOffers } from '../modules/offers.js';
import { completeBooking } from '../modules/bookings.js';
import { notify } from './notify.js';

/** Idempotent housekeeping. Runs on an interval today; move to a queue worker when one exists. */
export async function runHousekeeping() {
  const out = { offers: 0, listings: 0, journeys: 0, requests: 0, bookings: 0, stories: 0, reminders: 0 };
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
  const bs = await pool.query(`SELECT id FROM bookings WHERE status='delivered' AND delivered_at < now() - ($1::int || ' hours')::interval`, [hours]);
  for (const b of bs.rows) await tx((c) => completeBooking(c, b.id, null).then(() => undefined));
  out.bookings = bs.rowCount ?? 0;

  out.stories = (await pool.query(`UPDATE stories SET status='expired' WHERE status='active' AND expires_at < now()`)).rowCount ?? 0;

  const remindH = Number(await setting('event.reminder_hours', 24));
  const evs = (await pool.query(`SELECT e.id, e.title FROM events e WHERE e.status='scheduled' AND e.starts_at > now() AND e.starts_at < now() + ($1::int || ' hours')::interval`, [remindH])).rows;
  for (const e of evs) for (const r of (await pool.query(`SELECT user_id FROM event_rsvps WHERE event_id=$1`, [e.id])).rows)
    if (await notify(pool, { userId: r.user_id, type: 'event_reminder', targetType: 'event', targetId: e.id, data: { title: e.title }, dedupeKey: e.id })) out.reminders++;
  return out;
}
