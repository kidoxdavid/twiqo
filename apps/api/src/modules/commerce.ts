import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError, badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';
import { optionalAuth, requireAuth, requirePermission } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { hydrateListings, hydrateRequests } from '../lib/hydrate.js';
import { requirePlace } from '../lib/geo.js';
import { checkText, setting } from '../lib/policy.js';
import { paymentProvider } from '../lib/payments.js';
import { recordRisk, scanText } from '../lib/risk.js';
import { can } from './business.js';

export const commerce = Router();
const uuid = z.string().uuid();
const pct = (sorted: number[], p: number) => { const i = (sorted.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i); return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)); };
const MIN_SAMPLES = 5;

// ---------------------------------------------------------------------------------------------- price guidance (from real completed deals, never invented)
commerce.get('/transport/price-guidance', optionalAuth, wrap(async (req, res) => {
  const q = z.object({ from: z.string().min(2), to: z.string().min(2), weight_kg: z.coerce.number().min(0.1).max(30000).optional() }).parse(req.query);
  const f = await requirePlace(q.from); const t = await requirePlace(q.to);
  const { rows } = await pool.query(
    `SELECT b.agreed_cents FROM bookings b JOIN transport_requests r ON r.id=b.request_id
     WHERE b.status='completed' AND b.completed_at > now() - interval '12 months' AND b.agreed_cents > 0
       AND ST_DWithin(r.origin, ST_SetSRID(ST_MakePoint($1::float8,$2::float8),4326)::geography, 100000) AND ST_DWithin(r.dest, ST_SetSRID(ST_MakePoint($3::float8,$4::float8),4326)::geography, 100000)
       AND ($5::float8 IS NULL OR (r.weight_kg * r.quantity) BETWEEN $5::float8 * 0.5 AND $5::float8 * 2)`, [f.lng, f.lat, t.lng, t.lat, q.weight_kg ?? null]);
  const v = rows.map((r) => r.agreed_cents as number).sort((a, b) => a - b);
  if (v.length < MIN_SAMPLES) return void res.json({ enough_data: false, samples: v.length, message: `Not enough completed moves on this route yet to suggest a price (we need ${MIN_SAMPLES}). Check what other drivers charge for similar trips.` });
  res.json({ enough_data: true, samples: v.length, low_cents: pct(v, 0.25), typical_cents: pct(v, 0.5), high_cents: pct(v, 0.75), basis: 'Completed moves in the last 12 months within 100 km of both ends' + (q.weight_kg ? ' and a similar weight' : ''), currency: 'CAD' });
}));
commerce.get('/listings/price-guidance', wrap(async (req, res) => {
  const q = z.object({ category_id: uuid, condition: z.enum(['new', 'like_new', 'good', 'fair', 'for_parts']).optional() }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT price_cents FROM listings WHERE category_id IN (SELECT id FROM categories WHERE id=$1 OR parent_id=$1) AND status IN ('active','sold') AND price_type <> 'free' AND price_cents > 0 AND created_at > now() - interval '90 days' AND ($2::text IS NULL OR condition=$2)`, [q.category_id, q.condition ?? null]);
  const v = rows.map((r) => r.price_cents as number).sort((a, b) => a - b);
  if (v.length < MIN_SAMPLES * 2) return void res.json({ enough_data: false, samples: v.length, message: 'Not enough similar listings yet to suggest a price.' });
  res.json({ enough_data: true, samples: v.length, low_cents: pct(v, 0.25), typical_cents: pct(v, 0.5), high_cents: pct(v, 0.75), basis: 'Listings in this category over the last 90 days' + (q.condition ? ' in the same condition' : ''), currency: 'CAD' });
}));

// ---------------------------------------------------------------------------------------------- return-trip suggestions for drivers
commerce.get('/transport/journeys/:id/return-suggestions', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const j = (await pool.query(`SELECT driver_id, origin_city, origin_province, dest_city, dest_province, departure_at, arrival_at, distance_km FROM journeys WHERE id=$1`, [id])).rows[0];
  if (!j || j.driver_id !== me) throw notFound('Journey');
  const ready = new Date(j.arrival_at ? new Date(j.arrival_at).getTime() : new Date(j.departure_at).getTime() + (j.distance_km / 70) * 3600_000);
  const { rows } = await pool.query(
    `SELECT r.id FROM transport_requests r, journeys j WHERE j.id=$1 AND r.status='open' AND r.visibility='public' AND r.requester_id <> $2 AND r.pickup_to >= $3::date
       AND ST_DWithin(r.origin, j.dest, 75000) AND ST_DWithin(r.dest, j.origin, 75000)
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$2 AND b.blocked_id=r.requester_id) OR (b.blocker_id=r.requester_id AND b.blocked_id=$2))
     ORDER BY r.pickup_from LIMIT 10`, [id, me, ready.toISOString().slice(0, 10)]);
  const map = await hydrateRequests(rows.map((r) => r.id), me);
  res.json({ requests: rows.map((r) => map.get(r.id)).filter(Boolean),
    suggested_journey: { origin_city: j.dest_city, origin_province: j.dest_province, dest_city: j.origin_city, dest_province: j.origin_province, earliest_departure: ready.toISOString() },
    note: 'Open shipments going back the way you came, picked up after you would arrive.' });
}));

// ---------------------------------------------------------------------------------------------- renew / relist
commerce.post('/listings/:id/renew', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const days = Number(await setting('listing.renew_days', 30));
  await tx(async (c) => {
    const l = (await c.query('SELECT seller_id, business_id, status, renewed_at, expires_at FROM listings WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!l) throw notFound('Listing');
    if (!(l.seller_id === req.user!.id || (l.business_id && (await can(l.business_id, req.user!.id, 'manage_listings'))))) throw forbidden();
    if (!['active', 'expired'].includes(l.status)) throw conflict(`A ${l.status.replace('_', ' ')} listing can't be renewed`);
    if (l.renewed_at && Date.now() - new Date(l.renewed_at).getTime() < 24 * 3600_000) throw conflict('You can renew a listing once a day');
    await c.query(`UPDATE listings SET status='active', expires_at = greatest(expires_at, now()) + ($2 || ' days')::interval, renewed_at=now(), created_at = CASE WHEN status='expired' THEN now() ELSE created_at END WHERE id=$1`, [id, String(days)]);
    await c.query(`UPDATE feed_items SET status='active' WHERE item_type='listing' AND item_id=$1`, [id]);
  });
  res.json((await hydrateListings([id], req.user!.id)).get(id));
}));

// ---------------------------------------------------------------------------------------------- bulk upload for businesses
const bulkRow = z.object({
  title: z.string().trim().min(3).max(120), description: z.string().trim().max(8000).default(''), price: z.coerce.number().min(0).max(1_000_000),
  category_slug: z.string().trim().min(1).max(80), condition: z.enum(['new', 'like_new', 'good', 'fair', 'for_parts']).default('new'), quantity: z.coerce.number().int().min(1).max(10000).default(1),
  city: z.string().trim().max(80).optional(), tags: z.string().max(200).optional(),
});
commerce.post('/businesses/:id/listings/bulk', requireAuth, wrap(async (req, res) => {
  const bid = uuid.parse(req.params.id); const me = req.user!.id;
  if (!(await can(bid, me, 'manage_listings'))) throw forbidden('You cannot list for this business');
  const b = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200), dry_run: z.boolean().default(false) }).parse(req.body);
  const cats = new Map((await pool.query(`SELECT slug::text, id, is_restricted FROM categories WHERE is_active`)).rows.map((r) => [r.slug, r]));
  const threshold = Number(await setting('risk.flag_threshold', 3)); const maxRows = Number(await setting('listing.bulk_max_active', 500));
  const active = Number((await pool.query(`SELECT count(*)::int n FROM listings WHERE business_id=$1 AND status IN ('active','pending_review')`, [bid])).rows[0].n);
  if (!b.dry_run && active + b.rows.length > maxRows) throw conflict(`A business can have up to ${maxRows} live listings. Remove some first.`);
  const results: { row: number; ok: boolean; errors: string[]; title?: string; status?: string; id?: string }[] = [];
  const prepared: { i: number; r: z.infer<typeof bulkRow>; cat: any; held: boolean; reasons: string[]; score: number; tags: string[] }[] = [];
  for (const [i, raw] of b.rows.entries()) {
    const p = bulkRow.safeParse(raw); const errs: string[] = [];
    if (!p.success) { for (const is of p.error.issues) errs.push(`${is.path.join('.') || 'row'}: ${is.message}`); results.push({ row: i + 1, ok: false, errors: errs }); continue; }
    const cat = cats.get(p.data.category_slug); if (!cat) errs.push(`category_slug: "${p.data.category_slug}" is not a category`);
    try { await checkText(p.data.title); await checkText(p.data.description); } catch { errs.push('Text breaks our community guidelines'); }
    if (errs.length) { results.push({ row: i + 1, ok: false, errors: errs, title: p.data.title }); continue; }
    const sc = scanText(p.data.title, p.data.description); const held = sc.score >= threshold || cat.is_restricted;
    prepared.push({ i, r: p.data, cat, held, reasons: sc.reasons, score: sc.score, tags: (p.data.tags ?? '').split(/[;,|]/).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 10) });
    results.push({ row: i + 1, ok: true, errors: [], title: p.data.title, status: held ? 'pending_review' : 'active' });
  }
  if (!b.dry_run && prepared.length) {
    await tx(async (c) => {
      for (const p of prepared) {
        const place = p.r.city ? await requirePlace(p.r.city, undefined, c).catch(() => null) : null;
        const cents = Math.round(p.r.price * 100); const status = p.held ? 'pending_review' : 'active';
        const l = (await c.query(
          `INSERT INTO listings(seller_id,business_id,category_id,title,description,price_cents,price_type,condition,quantity,status,city,province,location,tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($11,(SELECT city FROM businesses WHERE id=$2),(SELECT city FROM user_profiles WHERE user_id=$1)), coalesce($12,(SELECT province FROM businesses WHERE id=$2),(SELECT province FROM user_profiles WHERE user_id=$1)),
             CASE WHEN $13::float8 IS NULL THEN (SELECT location FROM user_profiles WHERE user_id=$1) ELSE ST_SetSRID(ST_MakePoint($13,$14),4326)::geography END, $15) RETURNING id, location`,
          [me, bid, p.cat.id, p.r.title, p.r.description, cents, cents === 0 ? 'free' : 'fixed', p.r.condition, p.r.quantity, status, place?.city ?? null, place?.province ?? null, place?.lng ?? null, place?.lat ?? null, p.tags])).rows[0];
        await c.query(`INSERT INTO feed_items(item_type,item_id,author_id,business_id,visibility,status,location) VALUES ('listing',$1,$2,$3,'public',$4,$5)`, [l.id, me, bid, status === 'active' ? 'active' : 'pending', l.location]);
        if (p.held && p.score >= threshold) await recordRisk(c, { entityType: 'listing', entityId: l.id, userId: me, score: p.score, reasons: p.reasons });
        results[p.i].id = l.id;
      }
      await audit(c, me, 'listing.bulk_upload', 'business', bid, null, { created: prepared.length, rows: b.rows.length }, req.ip ?? null);
    });
  }
  res.status(b.dry_run ? 200 : 201).json({ dry_run: b.dry_run, created: b.dry_run ? 0 : prepared.length, valid: prepared.length, invalid: results.filter((r) => !r.ok).length, results });
}));

// ---------------------------------------------------------------------------------------------- receipts and tax estimates
commerce.get('/payments/:id/receipt', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const staff = req.user!.permissions.includes('manage.payments');
  const p = (await pool.query(`SELECT p.*, pu.username AS payer_username, eu.username AS payee_username, pp.display_name AS payer_name, ep.display_name AS payee_name, ep.province AS payee_province FROM payments p JOIN users pu ON pu.id=p.payer_id JOIN user_profiles pp ON pp.user_id=p.payer_id LEFT JOIN users eu ON eu.id=p.payee_id LEFT JOIN user_profiles ep ON ep.user_id=p.payee_id WHERE p.id=$1`, [req.params.id])).rows[0];
  if (!p || (!staff && p.payer_id !== me && p.payee_id !== me)) throw notFound('Payment');
  if (!['succeeded', 'partially_refunded', 'refunded'].includes(p.status)) throw conflict('A receipt is available once a payment has gone through');
  const rate = p.payee_province ? (await pool.query('SELECT gst_bps, hst_bps, pst_bps FROM tax_rates WHERE province=$1', [p.payee_province])).rows[0] : null;
  const seller = p.payee_id === me || staff;
  const taxOnFee = p.kind === 'boost' ? null : Math.round((p.fee_cents * ((rate?.gst_bps ?? 0) + (rate?.hst_bps ?? 0))) / 10000);
  res.json({
    receipt_number: `TW-${p.id.slice(0, 8).toUpperCase()}`, issued_at: p.succeeded_at, kind: p.kind, description: p.description, currency: p.currency, status: p.status,
    paid_by: p.payer_name, paid_to: p.kind === 'boost' ? 'twiqo' : p.payee_name, amount_cents: p.amount_cents, refunded_cents: p.refunded_cents, card_payment_reference: p.provider_payment_id,
    ...(seller && p.kind !== 'boost' ? { twiqo_fee_cents: p.fee_cents, net_to_you_cents: p.amount_cents - p.fee_cents, estimated_gst_hst_on_fee_cents: taxOnFee } : {}),
    notes: ['This is a record of a card payment made through twiqo. It is not a tax invoice for the item or service itself; the seller or driver is responsible for any sales tax and invoicing on what they sold.',
      ...(seller && p.kind !== 'boost' ? ['The GST/HST figure is an estimate of tax on twiqo\'s fee for your records. twiqo does not collect or remit it on your behalf.'] : [])] });
}));
commerce.get('/admin/tax-rates', requirePermission('manage.payments'), wrap(async (_req, res) => { res.json({ items: (await pool.query('SELECT * FROM tax_rates ORDER BY province')).rows, note: 'Defaults for estimating tax on twiqo fees. Confirm with your accountant.' }); }));
commerce.put('/admin/tax-rates/:province', requirePermission('manage.payments'), wrap(async (req, res) => {
  const b = z.object({ gst_bps: z.number().int().min(0).max(3000), pst_bps: z.number().int().min(0).max(3000), hst_bps: z.number().int().min(0).max(3000), note: z.string().max(100).optional() }).parse(req.body);
  const r = await pool.query(`UPDATE tax_rates SET gst_bps=$2, pst_bps=$3, hst_bps=$4, note=coalesce($5, note), updated_at=now() WHERE province=upper($1)`, [req.params.province, b.gst_bps, b.pst_bps, b.hst_bps, b.note ?? null]);
  if (!r.rowCount) throw notFound('Province'); await audit(pool, req.user!.id, 'tax_rate.update', 'tax_rate', null, null, { province: req.params.province, ...b }); res.status(204).end();
}));
commerce.get('/admin/tax-summary', requirePermission('manage.payments'), wrap(async (req, res) => {
  const days = z.coerce.number().int().min(1).max(366).default(90).parse(req.query.days ?? 90);
  const { rows } = await pool.query(
    `SELECT coalesce(ep.province, 'unknown') AS province, count(*)::int AS payments, sum(p.fee_cents - round(p.fee_cents::numeric * p.refunded_cents / p.amount_cents))::bigint AS net_fees,
            sum(round((p.fee_cents - round(p.fee_cents::numeric * p.refunded_cents / p.amount_cents)) * (coalesce(t.gst_bps,0) + coalesce(t.hst_bps,0)) / 10000.0))::bigint AS est_gst_hst
     FROM payments p LEFT JOIN user_profiles ep ON ep.user_id=p.payee_id LEFT JOIN tax_rates t ON t.province=ep.province
     WHERE p.kind <> 'boost' AND p.status IN ('succeeded','partially_refunded','refunded') AND p.succeeded_at > now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 3 DESC`, [String(days)]);
  res.json({ days, items: rows.map((r) => ({ province: r.province, payments: r.payments, net_fees_cents: Number(r.net_fees), estimated_gst_hst_cents: Number(r.est_gst_hst) })),
    note: 'Estimates for your accountant. twiqo does not charge, collect or remit sales tax on its fees yet, and boost purchases are not included.' });
}));

// ---------------------------------------------------------------------------------------------- card disputes (chargebacks): track and answer with our own records
commerce.get('/admin/card-disputes', requirePermission('manage.payments'), wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT d.id, d.provider_dispute_id, d.amount_cents, d.reason, d.status, d.due_by, d.evidence_submitted_at, d.created_at, p.kind, p.id AS payment_id FROM card_disputes d LEFT JOIN payments p ON p.id=d.payment_id ORDER BY (d.status IN ('needs_response','warning_needs_response')) DESC, d.due_by NULLS LAST, d.created_at DESC LIMIT 100`);
  res.json({ items: rows });
}));
/** Our records of what happened, written as plain facts a card issuer can read. Only facts we hold; nothing is invented. */
export async function buildEvidence(paymentId: string) {
  const p = (await pool.query(`SELECT p.*, pu.email AS payer_email FROM payments p JOIN users pu ON pu.id=p.payer_id WHERE p.id=$1`, [paymentId])).rows[0]; if (!p) throw notFound('Payment');
  const L: string[] = []; const f = (d: unknown) => new Date(d as string).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  L.push(`Payment ${p.id} of ${(p.amount_cents / 100).toFixed(2)} ${p.currency} was made on ${f(p.succeeded_at ?? p.created_at)} by the account holder (${p.payer_email}) through the twiqo marketplace.`);
  let product = 'Marketplace purchase on twiqo';
  if (p.booking_id) {
    const b = (await pool.query(`SELECT b.*, r.title, r.origin_city, r.dest_city FROM bookings b JOIN transport_requests r ON r.id=b.request_id WHERE b.id=$1`, [p.booking_id])).rows[0];
    product = `Delivery service: ${b.title} (${b.origin_city} to ${b.dest_city})`; L.push(`Service: ${product}. Booking agreed on ${f(b.created_at)}; current status: ${b.status}.`);
    const ev = (await pool.query(`SELECT kind, note, created_at, lat, lng FROM delivery_events WHERE booking_id=$1 ORDER BY id`, [b.id])).rows;
    for (const e of ev) L.push(`- ${f(e.created_at)}: ${e.kind.replace('_', ' ')}${e.note ? ` (${e.note})` : ''}${e.lat !== null ? `, GPS ${Number(e.lat).toFixed(4)},${Number(e.lng).toFixed(4)}` : ''}`);
    if (ev.some((e) => e.kind === 'delivered')) L.push('Delivery was confirmed by the driver entering a one-time 4-digit PIN that only the customer holds and reads out at handover, so the customer was present or authorised the handover.');
  } else if (p.order_id) {
    const o = (await pool.query(`SELECT o.*, l.title FROM orders o JOIN listings l ON l.id=o.listing_id WHERE o.id=$1`, [p.order_id])).rows[0];
    product = `Item: ${o.title}`; L.push(`Item purchased: ${o.title}. Order agreed on ${f(o.created_at)}; status: ${o.status}${o.completed_at ? `, marked completed on ${f(o.completed_at)}` : ''}.`);
    const d = (await pool.query(`SELECT count(*)::int n FROM disputes WHERE order_id=$1`, [o.id])).rows[0].n; L.push(d ? `The buyer opened ${d} problem report(s) with twiqo for this order; see our review notes.` : 'The buyer did not open a problem report with twiqo for this order.');
  }
  const refunds = (await pool.query(`SELECT amount_cents, created_at FROM refunds WHERE payment_id=$1 AND status='succeeded'`, [p.id])).rows;
  L.push(refunds.length ? `Refunds already issued: ${refunds.map((r) => `${(r.amount_cents / 100).toFixed(2)} on ${f(r.created_at)}`).join('; ')}.` : 'No refund had been requested or issued before this dispute.');
  const msgs = p.payee_id ? (await pool.query(`SELECT count(*)::int n FROM messages m WHERE m.sender_id = $1 AND m.conversation_id IN (SELECT a.conversation_id FROM conversation_members a JOIN conversation_members b ON b.conversation_id=a.conversation_id WHERE a.user_id=$1 AND b.user_id=$2)`, [p.payer_id, p.payee_id])).rows[0].n : 0;
  if (msgs) L.push(`The customer sent ${msgs} message(s) to the ${p.booking_id ? 'driver' : 'seller'} through twiqo about this transaction.`);
  return { text: L.join('\n'), productDescription: product };
}
commerce.get('/admin/card-disputes/:id/evidence-preview', requirePermission('manage.payments'), wrap(async (req, res) => {
  const d = (await pool.query('SELECT payment_id FROM card_disputes WHERE id=$1', [uuid.parse(req.params.id)])).rows[0]; if (!d?.payment_id) throw notFound('Dispute');
  res.json(await buildEvidence(d.payment_id));
}));
commerce.post('/admin/card-disputes/:id/submit-evidence', requirePermission('manage.payments'), wrap(async (req, res) => {
  const b = z.object({ extra_note: z.string().trim().max(2000).optional() }).parse(req.body ?? {}); const id = uuid.parse(req.params.id);
  const d = (await pool.query('SELECT * FROM card_disputes WHERE id=$1', [id])).rows[0]; if (!d?.payment_id) throw notFound('Dispute');
  if (!['needs_response', 'warning_needs_response'].includes(d.status)) throw conflict('This dispute no longer needs a response'); if (d.evidence_submitted_at) throw conflict('Evidence was already submitted');
  const e = await buildEvidence(d.payment_id); const text = b.extra_note ? `${e.text}\n\nAdditional note from twiqo staff: ${b.extra_note}` : e.text;
  try { await paymentProvider().submitDisputeEvidence(d.provider_dispute_id, { text, productDescription: e.productDescription }); } catch (err) { console.error('evidence submit failed', (err as Error).message); throw new HttpError(502, 'We could not send the evidence. Please try again before the deadline.', 'provider_error'); }
  await pool.query(`UPDATE card_disputes SET evidence_submitted_at=now(), evidence_submitted_by=$2, status='under_review', updated_at=now() WHERE id=$1`, [id, req.user!.id]);
  await audit(pool, req.user!.id, 'card_dispute.evidence_submitted', 'card_dispute', id, null, { provider_dispute_id: d.provider_dispute_id }, req.ip ?? null);
  res.json({ submitted: true });
}));
void badRequest;
