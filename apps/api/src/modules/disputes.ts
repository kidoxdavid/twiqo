import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { notify } from '../lib/notify.js';
import { setting } from '../lib/policy.js';
import { audit } from '../lib/audit.js';
import { mediaUrl } from '../lib/views.js';
import { assertOwnsMedia } from './content.js';
import { completeBooking } from './bookings.js';
import { refundPayment } from './payments.js';

export const disputes = Router();
const uuid = z.string().uuid();
const REASONS = ['not_delivered', 'damaged', 'not_as_described', 'late', 'no_show', 'overcharged', 'other'] as const;

export const hasOpenDispute = async (db: Db, subject: { bookingId?: string; orderId?: string }) =>
  !!(await db.query(`SELECT 1 FROM disputes WHERE status='open' AND ${subject.bookingId ? 'booking_id' : 'order_id'}=$1`, [subject.bookingId ?? subject.orderId])).rowCount;

async function staffIds(db: Db) {
  return (await db.query(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_key=ur.role_key WHERE rp.permission_key='manage.payments'`)).rows.map((r) => r.user_id as string);
}

export async function disputeView(id: string, viewer: string, staff: boolean) {
  const d = (await pool.query(
    `SELECT d.*, ou.username AS opener, op.display_name AS opener_name, tu.username AS other, tp.display_name AS other_name,
            rq.title AS booking_title, l.title AS order_title,
            (SELECT p.id FROM payments p WHERE (p.booking_id=d.booking_id OR p.order_id=d.order_id) AND p.status IN ('succeeded','partially_refunded','refunded') LIMIT 1) AS payment_id
     FROM disputes d JOIN users ou ON ou.id=d.opened_by JOIN user_profiles op ON op.user_id=ou.id JOIN users tu ON tu.id=d.other_party_id JOIN user_profiles tp ON tp.user_id=tu.id
     LEFT JOIN bookings b ON b.id=d.booking_id LEFT JOIN transport_requests rq ON rq.id=b.request_id LEFT JOIN orders o ON o.id=d.order_id LEFT JOIN listings l ON l.id=o.listing_id WHERE d.id=$1`, [id])).rows[0];
  if (!d || (!staff && d.opened_by !== viewer && d.other_party_id !== viewer)) return null;
  const msgs = (await pool.query(`SELECT m.id, m.body, m.staff, m.created_at, u.username, p.display_name, (SELECT storage_key FROM media_assets WHERE id=m.media_id) AS media_key FROM dispute_messages m JOIN users u ON u.id=m.author_id JOIN user_profiles p ON p.user_id=u.id WHERE m.dispute_id=$1 ORDER BY m.created_at`, [id])).rows;
  return {
    id: d.id, status: d.status, reason: d.reason, description: d.description, created_at: d.created_at, resolved_at: d.resolved_at,
    resolution: d.resolution, refund_cents: d.refund_cents, resolution_note: d.resolution_note,
    subject: d.booking_id ? { type: 'booking', id: d.booking_id, title: d.booking_title } : { type: 'order', id: d.order_id, title: d.order_title },
    opened_by: { username: d.opener, display_name: d.opener_name, is_me: d.opened_by === viewer }, other_party: { username: d.other, display_name: d.other_name },
    payment_id: staff || d.opened_by === viewer || d.other_party_id === viewer ? d.payment_id : undefined,
    messages: msgs.map((m) => ({ id: m.id, body: m.body, staff: m.staff, author: { username: m.username, display_name: m.display_name }, photo_url: m.media_key ? mediaUrl(m.media_key) : null, created_at: m.created_at })),
  };
}

disputes.post('/disputes', requireAuth, wrap(async (req, res) => {
  const b = z.object({ booking_id: uuid.optional(), order_id: uuid.optional(), reason: z.enum(REASONS), description: z.string().trim().min(10).max(3000) }).refine((v) => !!v.booking_id !== !!v.order_id, 'Choose a booking or an order').parse(req.body);
  const me = req.user!.id; const windowDays = Number(await setting('payments.dispute_window_days', 14));
  const id = await tx(async (c) => {
    let other: string;
    if (b.booking_id) {
      const bk = (await c.query('SELECT * FROM bookings WHERE id=$1 FOR NO KEY UPDATE', [b.booking_id])).rows[0];
      if (!bk || (bk.shipper_id !== me && bk.transporter_id !== me)) throw notFound('Booking');
      if (bk.status === 'cancelled' || bk.status === 'confirmed') throw conflict(bk.status === 'cancelled' ? 'This booking was cancelled' : 'You can open a dispute once pickup has happened. Before that, cancel the booking.');
      if (bk.status === 'completed' && new Date(bk.completed_at).getTime() < Date.now() - windowDays * 864e5) throw conflict(`Disputes must be opened within ${windowDays} days of completion`);
      other = bk.shipper_id === me ? bk.transporter_id : bk.shipper_id;
    } else {
      const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR NO KEY UPDATE', [b.order_id])).rows[0];
      if (!o || (o.buyer_id !== me && o.seller_id !== me)) throw notFound('Order');
      if (o.status === 'cancelled') throw conflict('This order was cancelled');
      if (o.status === 'completed' && new Date(o.completed_at).getTime() < Date.now() - windowDays * 864e5) throw conflict(`Disputes must be opened within ${windowDays} days of completion`);
      other = o.buyer_id === me ? o.seller_id : o.buyer_id;
    }
    const d = await c.query(`INSERT INTO disputes(booking_id,order_id,opened_by,other_party_id,reason,description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [b.booking_id ?? null, b.order_id ?? null, me, other, b.reason, b.description])
      .catch((e) => { if (e.code === '23505') throw conflict('There is already an open dispute for this'); throw e; });
    await notify(c, { userId: other, type: 'dispute_update', actorId: me, targetType: 'dispute', targetId: d.rows[0].id, data: { event: 'opened', reason: b.reason } });
    for (const s of await staffIds(c)) await notify(c, { userId: s, type: 'dispute_update', actorId: me, targetType: 'dispute', targetId: d.rows[0].id, data: { event: 'opened', reason: b.reason } });
    return d.rows[0].id as string;
  });
  res.status(201).json(await disputeView(id, me, false));
}));

disputes.get('/disputes', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  const { rows } = await pool.query(`SELECT id FROM disputes WHERE opened_by=$1 OR other_party_id=$1 ORDER BY created_at DESC LIMIT 50`, [me]);
  res.json({ items: (await Promise.all(rows.map((r) => disputeView(r.id, me, false)))).map((d: any) => ({ ...d, messages: undefined })) });
}));
disputes.get('/disputes/:id', requireAuth, wrap(async (req, res) => {
  const v = await disputeView(uuid.parse(req.params.id), req.user!.id, req.user!.permissions.includes('manage.payments'));
  if (!v) throw notFound('Dispute'); res.json(v);
}));

disputes.post('/disputes/:id/messages', requireAuth, wrap(async (req, res) => {
  const b = z.object({ body: z.string().trim().min(1).max(3000), media_id: uuid.optional() }).parse(req.body);
  const id = uuid.parse(req.params.id); const me = req.user!.id; const staff = req.user!.permissions.includes('manage.payments');
  await tx(async (c) => {
    const d = (await c.query('SELECT * FROM disputes WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    const party = d && (d.opened_by === me || d.other_party_id === me);
    if (!d || (!party && !staff)) throw notFound('Dispute');
    if (d.status !== 'open') throw conflict('This dispute is closed');
    if (b.media_id) await assertOwnsMedia(c, me, [b.media_id]);
    await c.query(`INSERT INTO dispute_messages(dispute_id,author_id,staff,body,media_id) VALUES ($1,$2,$3,$4,$5)`, [id, me, staff && !party, b.body, b.media_id ?? null]);
    for (const u of new Set([d.opened_by, d.other_party_id])) if (u !== me) await notify(c, { userId: u, type: 'dispute_update', actorId: me, targetType: 'dispute', targetId: id, data: { event: 'message' } });
  });
  res.status(201).json(await disputeView(id, me, staff));
}));

disputes.post('/disputes/:id/withdraw', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  await tx(async (c) => {
    const d = (await c.query('SELECT * FROM disputes WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!d || d.opened_by !== me) throw notFound('Dispute');
    if (d.status !== 'open') throw conflict('This dispute is already closed');
    await c.query(`UPDATE disputes SET status='withdrawn', resolved_at=now() WHERE id=$1`, [id]);
    await notify(c, { userId: d.other_party_id, type: 'dispute_update', actorId: me, targetType: 'dispute', targetId: id, data: { event: 'withdrawn' } });
  });
  res.json(await disputeView(id, me, false));
}));

// ---------------------------------------------------------------------------------------------- staff resolution
disputes.get('/admin/disputes', requireAuthStaff(), wrap(async (req, res) => {
  const status = z.enum(['open', 'resolved', 'withdrawn']).default('open').parse(req.query.status ?? 'open');
  const { rows } = await pool.query(`SELECT id FROM disputes WHERE status=$1 ORDER BY created_at LIMIT 100`, [status]);
  res.json({ items: (await Promise.all(rows.map((r) => disputeView(r.id, req.user!.id, true)))).map((d: any) => ({ ...d, messages: undefined })) });
}));

disputes.post('/admin/disputes/:id/resolve', requireAuthStaff(), wrap(async (req, res) => {
  const b = z.object({ resolution: z.enum(['refund_full', 'refund_partial', 'no_refund']), refund_cents: z.number().int().min(1).optional(), note: z.string().trim().min(5).max(1000) })
    .refine((v) => v.resolution !== 'refund_partial' || !!v.refund_cents, 'Enter the refund amount').parse(req.body);
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const d = (await pool.query('SELECT * FROM disputes WHERE id=$1', [id])).rows[0]; if (!d) throw notFound('Dispute');
  if (d.status !== 'open') throw conflict('This dispute is already resolved');
  const pay = (await pool.query(`SELECT id, amount_cents, refunded_cents FROM payments WHERE ${d.booking_id ? 'booking_id' : 'order_id'}=$1 AND status IN ('succeeded','partially_refunded')`, [d.booking_id ?? d.order_id])).rows[0];
  let refunded = 0; let paymentFound = !!pay;
  if (b.resolution !== 'no_refund' && pay) {
    const out = await refundPayment(pay.id, { amountCents: b.resolution === 'refund_full' ? undefined : b.refund_cents, reason: `Dispute: ${b.note}`.slice(0, 280), source: 'dispute', initiatedBy: me, ip: req.ip ?? null });
    refunded = out.amount_cents;
  }
  await tx(async (c) => {
    const cur = (await c.query('SELECT status FROM disputes WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (cur.status !== 'open') throw conflict('This dispute was just resolved by someone else');
    await c.query(`UPDATE disputes SET status='resolved', resolution=$2, refund_cents=$3, resolution_note=$4, resolved_by=$5, resolved_at=now() WHERE id=$1`, [id, b.resolution, refunded || b.refund_cents || 0, b.note, me]);
    if (d.booking_id) await completeBooking(c, d.booking_id, null);   // a delivered booking can now finish normally (no-op otherwise)
    await audit(c, me, 'dispute.resolve', 'dispute', id, null, { resolution: b.resolution, refunded_cents: refunded, note: b.note }, req.ip ?? null);
    for (const u of new Set([d.opened_by, d.other_party_id])) await notify(c, { userId: u, type: 'dispute_update', actorId: me, targetType: 'dispute', targetId: id, data: { event: 'resolved', resolution: b.resolution } });
  });
  res.json({ ...(await disputeView(id, me, true)), payment_found: paymentFound });
}));

function requireAuthStaff() {
  return (req: any, res: any, next: any) => requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.user.permissions.includes('manage.payments')) return next(forbidden());
    next();
  });
}
export { requireAuthStaff };
void badRequest;
