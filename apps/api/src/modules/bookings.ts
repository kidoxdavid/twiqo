import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, tx } from '../db/pool.js';
import { HttpError, badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';
import { requireAuth, optionalAuth } from '../lib/auth.js';
import { checkText, setting } from '../lib/policy.js';
import { notify, NOTIFICATION_TYPES } from '../lib/notify.js';
import { ensureConversation, postCard } from '../lib/conversations.js';
import { mediaUrl, thumbUrl } from '../lib/views.js';
import { assertOwnsMedia } from './content.js';
import { setFeedStatus } from './transport.js';
import { settleCancelled } from './payments.js';
import { hasOpenDispute } from './disputes.js';

export const bookings = Router();
const uuid = z.string().uuid();

const who = (r: any, p: string) => ({ id: r[`${p}_id`], username: r[`${p}_username`], display_name: r[`${p}_name`], avatar_url: r[`${p}_avatar`] ? thumbUrl(r[`${p}_avatar`]) : null });
const dateStr = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

async function bookingCard(c: PoolClient, b: any, actor: string, event: string) {
  const other = actor === b.shipper_id ? b.transporter_id : b.shipper_id;
  const subject = b.journey_id ? { type: 'journey' as const, id: b.journey_id } : b.service_id ? { type: 'service' as const, id: b.service_id } : { type: 'transport_request' as const, id: b.request_id };
  const cid = await ensureConversation(c, b.shipper_id, b.transporter_id, subject);
  await postCard(c, cid, actor, 'booking', { booking_id: b.id, event });
  await notify(c, { userId: other, type: 'booking_update', actorId: actor, targetType: 'booking', targetId: b.id, data: { event } });
}
const addEvent = (c: PoolClient, bookingId: string, actor: string | null, kind: string, note?: string | null, label?: string | null, media?: string | null) =>
  c.query('INSERT INTO delivery_events(booking_id,actor_id,kind,note,location_label,media_id) VALUES ($1,$2,$3,$4,$5,$6)', [bookingId, actor, kind, note ?? null, label ?? null, media ?? null]);

// ------------------------------------------------------------------------------------------ read
export async function bookingView(id: string, me: string) {
  const { rows } = await pool.query(
    `SELECT b.*, su.username AS s_username, sp.display_name AS s_name, (SELECT storage_key FROM media_assets WHERE id=sp.avatar_media_id) AS s_avatar,
            tu.username AS t_username, tp.display_name AS t_name, (SELECT storage_key FROM media_assets WHERE id=tp.avatar_media_id) AS t_avatar,
            r.title AS r_title, r.item_category, r.quantity AS r_qty, r.weight_kg, r.fragile, r.origin_city, r.origin_province, r.dest_city, r.dest_province, r.pickup_area, r.delivery_area, r.special_handling,
            r.pickup_from::text AS pickup_from, r.pickup_to::text AS pickup_to, r.deliver_by::text AS deliver_by, r.needs_loading_help, r.needs_unloading_help,
            j.departure_at AS j_dep, j.vehicle_type AS j_vehicle, s.title AS svc_title, s.vehicle_type AS svc_vehicle,
            ad.pickup_address, ad.pickup_notes, ad.delivery_address, ad.delivery_notes, ad.contact_phone
     FROM bookings b JOIN users su ON su.id=b.shipper_id JOIN user_profiles sp ON sp.user_id=su.id JOIN users tu ON tu.id=b.transporter_id JOIN user_profiles tp ON tp.user_id=tu.id
     JOIN transport_requests r ON r.id=b.request_id LEFT JOIN journeys j ON j.id=b.journey_id LEFT JOIN transport_services s ON s.id=b.service_id LEFT JOIN booking_addresses ad ON ad.booking_id=b.id
     WHERE b.id=$1 AND (b.shipper_id=$2 OR b.transporter_id=$2)`, [id, me]);
  const b = rows[0];
  if (!b) return null;
  const isShipper = b.shipper_id === me;
  const events = (await pool.query(
    `SELECT e.id, e.kind, e.note, e.location_label, e.created_at, u.username AS actor, (SELECT storage_key FROM media_assets WHERE id=e.media_id) AS media_key
     FROM delivery_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.booking_id=$1 ORDER BY e.id`, [id])).rows;
  const reviews = (await pool.query(`SELECT reviewer_id, rating, comment, created_at FROM reviews WHERE booking_id=$1 AND status='active'`, [id])).rows;
  const mine = reviews.find((x) => x.reviewer_id === me); const theirs = reviews.find((x) => x.reviewer_id !== me);
  const locked = b.pin_locked_until && new Date(b.pin_locked_until) > new Date();
  const actions: string[] = [];
  if (!['cancelled', 'completed'].includes(b.status) && isShipper) actions.push('set_address');
  if (b.status === 'confirmed') { actions.push('cancel'); if (!isShipper) actions.push('confirm_pickup'); }
  if (!isShipper && ['pickup_confirmed', 'in_transit'].includes(b.status)) actions.push('post_update', 'confirm_delivery');
  if (isShipper && b.status === 'delivered') actions.push('confirm_receipt');
  if (b.status === 'completed' && !mine) actions.push('review');
  if (isShipper && b.payment_status === 'unpaid' && !['cancelled', 'completed'].includes(b.status)) actions.push('pay');
  const openDispute = (await pool.query(`SELECT id FROM disputes WHERE booking_id=$1 AND status='open'`, [id])).rows[0];
  return {
    id: b.id, status: b.status, payment_status: b.payment_status, dispute_id: openDispute?.id ?? null, agreed_cents: b.agreed_cents, currency: b.currency, created_at: b.created_at, my_role: isShipper ? 'shipper' : 'transporter',
    shipper: who(b, 's'), transporter: who(b, 't'), counterparty: isShipper ? who(b, 't') : who(b, 's'),
    shipment: { request_id: b.request_id, title: b.r_title, category: b.item_category, quantity: b.r_qty, weight_kg: Number(b.weight_kg), fragile: b.fragile, special_handling: b.special_handling,
      from: { city: b.origin_city, province: b.origin_province, area: b.pickup_area }, to: { city: b.dest_city, province: b.dest_province, area: b.delivery_area },
      pickup_from: b.pickup_from, pickup_to: b.pickup_to, deliver_by: b.deliver_by, needs_loading_help: b.needs_loading_help, needs_unloading_help: b.needs_unloading_help },
    carrier: b.journey_id ? { type: 'journey', id: b.journey_id, departure_at: b.j_dep, vehicle: b.j_vehicle } : b.service_id ? { type: 'service', id: b.service_id, title: b.svc_title, vehicle: b.svc_vehicle } : null,
    // exact addresses are visible to the two parties only, never in feeds or listings
    address: { pickup_address: b.pickup_address, pickup_notes: b.pickup_notes, delivery_address: b.delivery_address, delivery_notes: b.delivery_notes, contact_phone: b.contact_phone },
    // the shipper holds the PINs and reads them out; the transporter must enter them
    pins: isShipper ? { pickup: b.pickup_pin, delivery: b.delivery_pin } : null,
    pin_locked_until: locked ? b.pin_locked_until : null,
    timeline: events.map((e) => ({ id: e.id, kind: e.kind, note: e.note, location_label: e.location_label, actor: e.actor, created_at: e.created_at, photo_url: e.media_key ? mediaUrl(e.media_key) : null })),
    cancel: b.status === 'cancelled' ? { by: b.cancelled_by === me ? 'you' : 'them', reason: b.cancel_reason, at: b.cancelled_at } : null,
    review: { mine: mine ?? null, theirs: theirs ?? null }, actions,
  };
}

bookings.get('/bookings', requireAuth, wrap(async (req, res) => {
  const q = z.object({ role: z.enum(['shipper', 'transporter', 'all']).default('all'), state: z.enum(['active', 'done', 'all']).default('all') }).parse(req.query);
  const me = req.user!.id;
  const where = [q.role === 'shipper' ? 'b.shipper_id=$1' : q.role === 'transporter' ? 'b.transporter_id=$1' : '(b.shipper_id=$1 OR b.transporter_id=$1)'];
  if (q.state === 'active') where.push(`b.status IN ('confirmed','pickup_confirmed','in_transit','delivered')`);
  if (q.state === 'done') where.push(`b.status IN ('completed','cancelled')`);
  const { rows } = await pool.query(`SELECT b.id FROM bookings b WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC LIMIT 100`, [me]);
  const items = (await Promise.all(rows.map((r) => bookingView(r.id, me)))).filter(Boolean).map((b: any) => ({ ...b, address: undefined, pins: undefined, timeline: undefined }));
  res.json({ items });
}));

bookings.get('/bookings/:id', requireAuth, wrap(async (req, res) => {
  const v = await bookingView(uuid.parse(req.params.id), req.user!.id);
  if (!v) throw notFound('Booking');
  res.json(v);
}));

async function mine(c: PoolClient | typeof pool, id: string, me: string, lock = false) {
  const b = (await c.query(`SELECT * FROM bookings WHERE id=$1 ${lock ? 'FOR NO KEY UPDATE' : ''}`, [id])).rows[0];
  if (!b || (b.shipper_id !== me && b.transporter_id !== me)) throw notFound('Booking');
  return b;
}

// ------------------------------------------------------------------------------------------ address (shipper)
bookings.put('/bookings/:id/address', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const b = z.object({ pickup_address: z.string().trim().max(300).optional(), pickup_notes: z.string().trim().max(500).optional(), delivery_address: z.string().trim().max(300).optional(), delivery_notes: z.string().trim().max(500).optional(), contact_phone: z.string().trim().max(30).optional() }).parse(req.body);
  await tx(async (c) => {
    const bk = await mine(c, id, me, true);
    if (bk.shipper_id !== me) throw forbidden('Only the shipper can set the addresses');
    if (['completed', 'cancelled'].includes(bk.status)) throw conflict('This booking is closed');
    await c.query(`INSERT INTO booking_addresses(booking_id,pickup_address,pickup_notes,delivery_address,delivery_notes,contact_phone) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (booking_id) DO UPDATE SET pickup_address=EXCLUDED.pickup_address, pickup_notes=EXCLUDED.pickup_notes, delivery_address=EXCLUDED.delivery_address, delivery_notes=EXCLUDED.delivery_notes, contact_phone=EXCLUDED.contact_phone, updated_at=now()`,
      [id, b.pickup_address ?? null, b.pickup_notes ?? null, b.delivery_address ?? null, b.delivery_notes ?? null, b.contact_phone ?? null]);
    await addEvent(c, id, me, 'address_set', 'Addresses shared with your transporter');
    await notify(c, { userId: bk.transporter_id, type: 'booking_update', actorId: me, targetType: 'booking', targetId: id, data: { event: 'address_set' } });
  });
  res.json(await bookingView(id, me));
}));

// ------------------------------------------------------------------------------------------ PIN handshakes
const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** PIN failures are recorded outside the main transaction so the counter survives the error that rolls it back. */
async function verifyPin(id: string, which: 'pickup_pin' | 'delivery_pin', input: string) {
  const b = (await pool.query('SELECT pickup_pin, delivery_pin, pin_locked_until FROM bookings WHERE id=$1', [id])).rows[0];
  if (b.pin_locked_until && new Date(b.pin_locked_until) > new Date()) throw new HttpError(429, 'Too many wrong PINs. Try again in a few minutes.', 'pin_locked');
  if (safeEq(b[which], input)) { await pool.query('UPDATE bookings SET pin_attempts=0 WHERE id=$1', [id]); return; }
  const max = Number(await setting('booking.pin_max_attempts', 5));
  const r = (await pool.query(
    `UPDATE bookings SET pin_attempts = CASE WHEN pin_attempts+1 >= $2 THEN 0 ELSE pin_attempts+1 END,
        pin_locked_until = CASE WHEN pin_attempts+1 >= $2 THEN now() + interval '15 minutes' ELSE pin_locked_until END WHERE id=$1 RETURNING pin_attempts, pin_locked_until`, [id, max])).rows[0];
  if (r.pin_locked_until && new Date(r.pin_locked_until) > new Date()) {
    await pool.query(`INSERT INTO delivery_events(booking_id,kind,note) VALUES ($1,'pin_locked','Too many wrong PIN attempts')`, [id]);
    throw new HttpError(429, 'Too many wrong PINs. Try again in 15 minutes.', 'pin_locked');
  }
  throw new HttpError(403, `That PIN is not correct. ${max - r.pin_attempts} attempt${max - r.pin_attempts === 1 ? '' : 's'} left.`, 'bad_pin');
}

const evidence = { photo_media_id: uuid.optional() };

bookings.post('/bookings/:id/pickup', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const b = z.object({ pin: z.string().regex(/^\d{4}$/), ...evidence }).parse(req.body);
  const bk = await mine(pool, id, me);
  if (bk.transporter_id !== me) throw forbidden('Only the transporter confirms pickup');
  if (bk.status !== 'confirmed') throw conflict(`Pickup can't be confirmed while the booking is ${bk.status.replace('_', ' ')}`);
  if (bk.payment_status === 'unpaid' && (await setting('payments.required_for_pickup', false)) === true) throw conflict('This booking has to be paid on twiqo before pickup can be confirmed', 'payment_required');
  await verifyPin(id, 'pickup_pin', b.pin);
  await tx(async (c) => {
    const cur = await mine(c, id, me, true);
    if (cur.status !== 'confirmed') throw conflict('This booking just changed');
    if (b.photo_media_id) await assertOwnsMedia(c, me, [b.photo_media_id]);
    await c.query(`UPDATE bookings SET status='pickup_confirmed', pickup_confirmed_at=now() WHERE id=$1`, [id]);
    await addEvent(c, id, me, 'pickup_confirmed', 'Pickup confirmed with PIN', null, b.photo_media_id);
    await bookingCard(c, cur, me, 'pickup_confirmed');
  });
  res.json(await bookingView(id, me));
}));

bookings.post('/bookings/:id/transit', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const b = z.object({ note: z.string().trim().max(500).optional(), location_label: z.string().trim().max(80).optional(), ...evidence }).parse(req.body ?? {});
  await checkText(b.note);
  await tx(async (c) => {
    const bk = await mine(c, id, me, true);
    if (bk.transporter_id !== me) throw forbidden('Only the transporter posts transit updates');
    if (!['pickup_confirmed', 'in_transit'].includes(bk.status)) throw conflict('Updates can be posted after pickup and before delivery');
    if (b.photo_media_id) await assertOwnsMedia(c, me, [b.photo_media_id]);
    const first = bk.status === 'pickup_confirmed';
    await c.query(`UPDATE bookings SET status='in_transit' WHERE id=$1`, [id]);
    await addEvent(c, id, me, 'in_transit', b.note ?? (first ? 'On the way' : null), b.location_label, b.photo_media_id);
    await bookingCard(c, bk, me, first ? 'in_transit' : 'update');
  });
  res.json(await bookingView(id, me));
}));

bookings.post('/bookings/:id/deliver', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const b = z.object({ pin: z.string().regex(/^\d{4}$/), ...evidence }).parse(req.body);
  const bk = await mine(pool, id, me);
  if (bk.transporter_id !== me) throw forbidden('Only the transporter confirms delivery');
  if (!['pickup_confirmed', 'in_transit'].includes(bk.status)) throw conflict(`Delivery can't be confirmed while the booking is ${bk.status.replace('_', ' ')}`);
  await verifyPin(id, 'delivery_pin', b.pin);
  await tx(async (c) => {
    const cur = await mine(c, id, me, true);
    if (!['pickup_confirmed', 'in_transit'].includes(cur.status)) throw conflict('This booking just changed');
    if (b.photo_media_id) await assertOwnsMedia(c, me, [b.photo_media_id]);
    await c.query(`UPDATE bookings SET status='delivered', delivered_at=now() WHERE id=$1`, [id]);
    await addEvent(c, id, me, 'delivered', 'Delivery confirmed with PIN', null, b.photo_media_id);
    await bookingCard(c, cur, me, 'delivered');
  });
  res.json(await bookingView(id, me));
}));

export async function completeBooking(c: PoolClient, id: string, actor: string | null) {
  const b = (await c.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!b || b.status !== 'delivered') return false;
  await c.query(`UPDATE bookings SET status='completed', completed_at=now() WHERE id=$1`, [id]);
  await c.query(`UPDATE transport_requests SET status='completed' WHERE id=$1`, [b.request_id]);
  await addEvent(c, id, actor, 'completed', actor ? 'Receipt confirmed' : 'Completed automatically');
  for (const u of [b.shipper_id, b.transporter_id]) await notify(c, { userId: u, type: 'booking_update', actorId: actor, targetType: 'booking', targetId: id, data: { event: 'completed' } });
  return true;
}
bookings.post('/bookings/:id/complete', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  await tx(async (c) => {
    const bk = await mine(c, id, me, true);
    if (bk.shipper_id !== me) throw forbidden('Only the shipper confirms receipt');
    if (bk.status !== 'delivered') throw conflict('The transporter has not confirmed delivery yet');
    if (await hasOpenDispute(c, { bookingId: id })) throw conflict('There is an open dispute on this booking. It can be completed once the dispute is resolved.', 'dispute_open');
    await completeBooking(c, id, me);
  });
  res.json(await bookingView(id, me));
}));

bookings.post('/bookings/:id/cancel', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
  await checkText(reason);
  await tx(async (c) => {
    const bk = await mine(c, id, me, true);
    if (bk.status !== 'confirmed') throw conflict(bk.status === 'cancelled' ? 'Already cancelled' : 'Once pickup is confirmed a booking can no longer be cancelled here. Message your counterpart or report an issue.');
    await c.query(`UPDATE bookings SET status='cancelled', cancelled_at=now(), cancelled_by=$2, cancel_reason=$3 WHERE id=$1`, [id, me, reason]);
    await c.query(`SELECT 1 FROM transport_requests WHERE id=$1 FOR NO KEY UPDATE`, [bk.request_id]);   // same lock order as accept: request first
    await c.query(`UPDATE transport_requests SET status='open' WHERE id=$1 AND status='booked'`, [bk.request_id]);
    const vis = (await c.query('SELECT visibility FROM transport_requests WHERE id=$1', [bk.request_id])).rows[0];
    if (vis?.visibility === 'public') await setFeedStatus(c, 'transport_request', bk.request_id, true);
    if (bk.journey_id) {   // give the space back and make the journey bookable again
      await c.query(`SELECT 1 FROM journeys WHERE id=$1 FOR NO KEY UPDATE`, [bk.journey_id]);
      await c.query(`UPDATE journeys SET remaining_kg = least(capacity_kg, remaining_kg + $2), remaining_m3 = CASE WHEN remaining_m3 IS NULL THEN NULL ELSE least(capacity_m3, remaining_m3 + $3) END,
         status = CASE WHEN status='full' THEN 'open' ELSE status END WHERE id=$1`, [bk.journey_id, Math.ceil(Number(bk.reserved_kg)), Number(bk.reserved_m3)]);
      await c.query(`UPDATE feed_items SET status='active' WHERE item_type='journey' AND item_id=$1 AND EXISTS (SELECT 1 FROM journeys WHERE id=$1 AND status='open')`, [bk.journey_id]);
    }
    await addEvent(c, id, me, 'cancelled', reason);
    await bookingCard(c, bk, me, 'cancelled');
  });
  await settleCancelled({ bookingId: id }, me);
  res.json(await bookingView(id, me));
}));

// ------------------------------------------------------------------------------------------ orders (goods)
const orderSelect = `SELECT od.*, l.title, (SELECT m.storage_key FROM listing_media lm JOIN media_assets m ON m.id=lm.media_id WHERE lm.listing_id=l.id ORDER BY lm.position LIMIT 1) AS img, l.city,
    bu.username AS b_username, bp.display_name AS b_name, (SELECT storage_key FROM media_assets WHERE id=bp.avatar_media_id) AS b_avatar,
    su.username AS s_username, sp.display_name AS s_name, (SELECT storage_key FROM media_assets WHERE id=sp.avatar_media_id) AS s_avatar
  FROM orders od JOIN listings l ON l.id=od.listing_id JOIN users bu ON bu.id=od.buyer_id JOIN user_profiles bp ON bp.user_id=bu.id JOIN users su ON su.id=od.seller_id JOIN user_profiles sp ON sp.user_id=su.id`;

async function orderView(id: string, me: string) {
  const o = (await pool.query(`${orderSelect} WHERE od.id=$1 AND (od.buyer_id=$2 OR od.seller_id=$2)`, [id, me])).rows[0];
  if (!o) return null;
  const reviews = (await pool.query(`SELECT reviewer_id, rating, comment FROM reviews WHERE order_id=$1 AND status='active'`, [id])).rows;
  const buyer = o.buyer_id === me; const mineR = reviews.find((r) => r.reviewer_id === me);
  const tr = (await pool.query(`SELECT id, status FROM transport_requests WHERE linked_listing_id=$1 AND requester_id=$2 ORDER BY created_at DESC LIMIT 1`, [o.listing_id, o.buyer_id])).rows[0];
  return {
    id: o.id, status: o.status, payment_status: o.payment_status, quantity: o.quantity, total_cents: o.total_cents, currency: o.currency, created_at: o.created_at, completed_at: o.completed_at, my_role: buyer ? 'buyer' : 'seller',
    listing: { id: o.listing_id, title: o.title, image_url: o.img ? thumbUrl(o.img) : null, city: o.city }, buyer: who(o, 'b'), seller: who(o, 's'), counterparty: buyer ? who(o, 's') : who(o, 'b'),
    transport_request: buyer && tr ? { id: tr.id, status: tr.status } : null, review: { mine: mineR ?? null, theirs: reviews.find((r) => r.reviewer_id !== me) ?? null },
    actions: [...(o.status === 'agreed' ? ['complete', 'cancel'] : []), ...(o.status === 'completed' && !mineR ? ['review'] : []), ...(buyer && o.status === 'agreed' && !tr ? ['arrange_transport'] : []), ...(buyer && o.status === 'agreed' && o.payment_status === 'unpaid' ? ['pay'] : [])],
  };
}
bookings.get('/orders', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const role = z.enum(['buyer', 'seller', 'all']).default('all').parse(req.query.role ?? 'all');
  const { rows } = await pool.query(`SELECT id FROM orders WHERE ${role === 'buyer' ? 'buyer_id=$1' : role === 'seller' ? 'seller_id=$1' : '(buyer_id=$1 OR seller_id=$1)'} ORDER BY created_at DESC LIMIT 100`, [me]);
  res.json({ items: await Promise.all(rows.map((r) => orderView(r.id, me))) });
}));
bookings.get('/orders/:id', requireAuth, wrap(async (req, res) => { const v = await orderView(uuid.parse(req.params.id), req.user!.id); if (!v) throw notFound('Order'); res.json(v); }));

bookings.post('/orders/:id/complete', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  await tx(async (c) => {
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!o || (o.buyer_id !== me && o.seller_id !== me)) throw notFound('Order');
    if (o.status !== 'agreed') throw conflict(`This order is already ${o.status}`);
    if (await hasOpenDispute(c, { orderId: id })) throw conflict('There is an open dispute on this order. It can be completed once the dispute is resolved.', 'dispute_open');
    await c.query(`UPDATE orders SET status='completed', completed_at=now() WHERE id=$1`, [id]);
    await notify(c, { userId: me === o.buyer_id ? o.seller_id : o.buyer_id, type: 'booking_update', actorId: me, targetType: 'order', targetId: id, data: { event: 'completed' } });
  });
  res.json(await orderView(id, me));
}));
bookings.post('/orders/:id/cancel', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  await tx(async (c) => {
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!o || (o.buyer_id !== me && o.seller_id !== me)) throw notFound('Order');
    if (o.status !== 'agreed') throw conflict(`This order is already ${o.status}`);
    await c.query(`UPDATE orders SET status='cancelled', cancelled_at=now(), cancelled_by=$2 WHERE id=$1`, [id, me]);
    const l = (await c.query('SELECT status FROM listings WHERE id=$1 FOR NO KEY UPDATE', [o.listing_id])).rows[0];
    await c.query(`UPDATE listings SET quantity = quantity + $2, status = CASE WHEN status='sold' THEN 'active' ELSE status END WHERE id=$1`, [o.listing_id, o.quantity]);
    if (l.status === 'sold') await c.query(`UPDATE feed_items SET status='active' WHERE item_type='listing' AND item_id=$1`, [o.listing_id]);
    await notify(c, { userId: me === o.buyer_id ? o.seller_id : o.buyer_id, type: 'booking_update', actorId: me, targetType: 'order', targetId: id, data: { event: 'cancelled' } });
  });
  await settleCancelled({ orderId: id }, me);
  res.json(await orderView(id, me));
}));

// ------------------------------------------------------------------------------------------ reviews
const reviewBody = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).optional() });
async function addReview(kind: 'booking' | 'order', id: string, me: string, b: z.infer<typeof reviewBody>) {
  await checkText(b.comment);
  await tx(async (c) => {
    let reviewee: string; let role: string;
    if (kind === 'booking') {
      const bk = await mine(c, id, me); if (bk.status !== 'completed') throw conflict('You can review once the delivery is complete');
      reviewee = me === bk.shipper_id ? bk.transporter_id : bk.shipper_id; role = me === bk.shipper_id ? 'transporter' : 'shipper';
    } else {
      const o = (await c.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
      if (!o || (o.buyer_id !== me && o.seller_id !== me)) throw notFound('Order');
      if (o.status !== 'completed') throw conflict('You can review once the order is complete');
      reviewee = me === o.buyer_id ? o.seller_id : o.buyer_id; role = me === o.buyer_id ? 'seller' : 'buyer';
    }
    await c.query(`INSERT INTO reviews(booking_id,order_id,reviewer_id,reviewee_id,role,rating,comment) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [kind === 'booking' ? id : null, kind === 'order' ? id : null, me, reviewee, role, b.rating, b.comment ?? null])
      .catch((e) => { if (e.code === '23505') throw conflict('You already reviewed this'); throw e; });
    await notify(c, { userId: reviewee, type: 'review_received', actorId: me, targetType: kind, targetId: id, data: { rating: b.rating } });
  });
}
bookings.post('/bookings/:id/reviews', requireAuth, wrap(async (req, res) => { await addReview('booking', uuid.parse(req.params.id), req.user!.id, reviewBody.parse(req.body)); res.status(201).json(await bookingView(String(req.params.id), req.user!.id)); }));
bookings.post('/orders/:id/reviews', requireAuth, wrap(async (req, res) => { await addReview('order', uuid.parse(req.params.id), req.user!.id, reviewBody.parse(req.body)); res.status(201).json(await orderView(String(req.params.id), req.user!.id)); }));

bookings.get('/users/:username/reviews', optionalAuth, wrap(async (req, res) => {
  const u = (await pool.query(`SELECT id FROM users WHERE username=$1 AND status='active'`, [req.params.username])).rows[0];
  if (!u) throw notFound('Profile');
  const role = z.enum(['transporter', 'shipper', 'buyer', 'seller']).optional().parse(req.query.role);
  const { rows } = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.role, r.created_at, ru.username, rp.display_name, (SELECT storage_key FROM media_assets WHERE id=rp.avatar_media_id) AS avatar_key
     FROM reviews r JOIN users ru ON ru.id=r.reviewer_id JOIN user_profiles rp ON rp.user_id=ru.id WHERE r.reviewee_id=$1 AND r.status='active' AND ($2::text IS NULL OR r.role=$2) ORDER BY r.created_at DESC LIMIT 50`, [u.id, role ?? null]);
  const agg = (await pool.query(`SELECT round(avg(rating)::numeric,2) AS avg, count(*)::int AS n FROM reviews WHERE reviewee_id=$1 AND status='active' AND ($2::text IS NULL OR role=$2)`, [u.id, role ?? null])).rows[0];
  res.json({ summary: { average: agg.avg === null ? null : Number(agg.avg), count: agg.n }, items: rows.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, role: r.role, created_at: r.created_at, reviewer: { username: r.username, display_name: r.display_name, avatar_url: r.avatar_key ? thumbUrl(r.avatar_key) : null } })) });
}));

// ------------------------------------------------------------------------------------------ notification preferences
bookings.get('/me/notification-preferences', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT type, enabled FROM notification_preferences WHERE user_id=$1', [req.user!.id]);
  const m = new Map(rows.map((r) => [r.type, r.enabled]));
  res.json({ items: [...NOTIFICATION_TYPES, { type: 'review_received', label: 'New reviews' }].map((t) => ({ ...t, enabled: m.get(t.type) ?? true })) });
}));
bookings.put('/me/notification-preferences', requireAuth, wrap(async (req, res) => {
  const b = z.object({ type: z.string().max(40), enabled: z.boolean() }).parse(req.body);
  if (![...NOTIFICATION_TYPES.map((t) => t.type), 'review_received'].includes(b.type)) throw badRequest('Unknown notification type');
  await pool.query(`INSERT INTO notification_preferences(user_id,type,enabled) VALUES ($1,$2,$3) ON CONFLICT (user_id,type) DO UPDATE SET enabled=EXCLUDED.enabled`, [req.user!.id, b.type, b.enabled]);
  res.status(204).end();
}));
