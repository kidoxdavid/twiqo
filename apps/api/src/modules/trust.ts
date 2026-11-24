import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { HttpError, badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';
import { requireAuth, requirePermission } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { queueEmail } from '../lib/email.js';
import { notify } from '../lib/notify.js';
import { paymentProvider } from '../lib/payments.js';
import { setting } from '../lib/policy.js';
import { readPrivate, savePrivate } from '../lib/privateFiles.js';
import { handleEvent } from './payments.js';

export const trust = Router();
const uuid = z.string().uuid();
const webOrigin = () => config.WEB_ORIGIN.split(',')[0];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

// ---------------------------------------------------------------------------------------------- identity verification
trust.get('/identity/status', requireAuth, wrap(async (req, res) => {
  const p = (await pool.query('SELECT verification_level, identity_verified_at FROM user_profiles WHERE user_id=$1', [req.user!.id])).rows[0];
  const last = (await pool.query('SELECT status, created_at FROM identity_verifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user!.id])).rows[0];
  res.json({ verified: !!p.identity_verified_at, verified_at: p.identity_verified_at, latest: last ?? null, test_mode: paymentProvider().name === 'fake',
    note: 'Identity checks are run by Stripe Identity: a photo of your government ID and a selfie. twiqo does not store the images; it keeps only the result.' });
}));
trust.post('/identity/start', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const p = (await pool.query('SELECT identity_verified_at FROM user_profiles WHERE user_id=$1', [me])).rows[0];
  if (p.identity_verified_at) throw conflict('Your identity is already verified');
  const recent = (await pool.query(`SELECT count(*)::int n FROM identity_verifications WHERE user_id=$1 AND created_at > now() - interval '1 day'`, [me])).rows[0].n; if (recent >= 5) throw new HttpError(429, 'Too many attempts today. Please try again tomorrow.', 'rate_limited');
  try {
    const s = await paymentProvider().createIdentitySession({ userId: me, returnUrl: `${webOrigin()}/settings/verification?returned=1` });
    await pool.query(`INSERT INTO identity_verifications(user_id,provider,provider_session_id) VALUES ($1,$2,$3)`, [me, paymentProvider().name, s.id]);
    res.json({ url: s.url });
  } catch (e) { console.error('identity session failed', (e as Error).message); throw new HttpError(502, 'We could not start verification. Please try again.', 'provider_error'); }
}));
const fakeOnly = () => { if (config.PAYMENT_PROVIDER !== 'fake' || config.NODE_ENV === 'production') throw notFound('Route'); };
trust.post('/identity/fake/complete', requireAuth, wrap(async (req, res) => {
  fakeOnly(); const b = z.object({ outcome: z.enum(['verified', 'requires_input']).default('verified') }).parse(req.body ?? {});
  const v = (await pool.query(`SELECT provider_session_id FROM identity_verifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [req.user!.id])).rows[0]; if (!v) throw badRequest('Start verification first');
  await handleEvent({ id: `evt_fake_idv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type: 'identity.updated', identity: { sessionId: v.provider_session_id, userId: req.user!.id, status: b.outcome } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------------------------- driver documents
const KINDS = ['drivers_licence', 'vehicle_registration', 'insurance'] as const;
export type DocKind = typeof KINDS[number];
const today = () => new Date().toISOString().slice(0, 10);

/** Approved, unexpired documents and identity: what other people see as badges (never the files). */
export async function driverTrust(userId: string, db: Db = pool) {
  const docs = (await db.query(`SELECT DISTINCT kind FROM driver_documents WHERE user_id=$1 AND status='approved' AND expires_on >= current_date`, [userId])).rows.map((r) => r.kind as string);
  const idv = (await db.query('SELECT identity_verified_at FROM user_profiles WHERE user_id=$1', [userId])).rows[0]?.identity_verified_at;
  return { identity: !!idv, licence: docs.includes('drivers_licence'), registration: docs.includes('vehicle_registration'), insurance: docs.includes('insurance') };
}
export async function missingDriverRequirements(userId: string, db: Db = pool) {
  const t = await driverTrust(userId, db); const need = (await setting<string[]>('transport.required_documents', ['drivers_licence'], db));
  const miss: string[] = []; if (!t.identity) miss.push('identity');
  const map: Record<string, boolean> = { drivers_licence: t.licence, vehicle_registration: t.registration, insurance: t.insurance };
  for (const k of need) if (!map[k]) miss.push(k);
  return miss;
}
/** Applied when posting a journey or delivery service, if the platform requires verified drivers. */
export async function assertDriverAllowed(userId: string, db: Db = pool, enforce?: boolean) {
  if (!(enforce ?? (await setting('transport.require_verified_driver', false, db)) === true)) return;
  const miss = await missingDriverRequirements(userId, db);
  if (miss.length) throw new HttpError(403, 'To offer transport you need to finish driver verification first.', 'driver_verification_required');
}
/** Instant book is for drivers other people can rely on: identity-verified, or enough completed deliveries with good ratings. */
export async function isTrustedDriver(userId: string, db: Db = pool) {
  if ((await driverTrust(userId, db)).identity) return true;
  const min = Number(await setting('instant_book.min_completed', 3, db));
  const r = (await db.query(`SELECT (SELECT count(*) FROM bookings WHERE transporter_id=$1 AND status='completed')::int AS done, (SELECT avg(rating) FROM reviews WHERE reviewee_id=$1 AND role='transporter' AND status='active' AND revealed_at IS NOT NULL) AS avg`, [userId])).rows[0];
  return r.done >= min && Number(r.avg ?? 0) >= 4;
}

trust.get('/driver/documents', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  const items = (await pool.query(`SELECT id, kind, mime, expires_on, status, review_note, created_at FROM driver_documents WHERE user_id=$1 AND status <> 'replaced' ORDER BY created_at DESC`, [me])).rows;
  res.json({ items, trust: await driverTrust(me), required: ['identity', ...(await setting<string[]>('transport.required_documents', ['drivers_licence']))], missing: await missingDriverRequirements(me),
    enforced: (await setting('transport.require_verified_driver', false)) === true,
    note: 'Documents are private. Only you and twiqo reviewers can see them; other people only see a badge. twiqo checks that a document looks genuine and is current. It does not verify insurance coverage with your insurer.' });
}));
trust.post('/driver/documents', requireAuth, upload.single('file'), wrap(async (req, res) => {
  const b = z.object({ kind: z.enum(KINDS), expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body); const me = req.user!.id;
  if (!req.file) throw badRequest('Choose a file to upload'); if (b.expires_on <= today()) throw badRequest('This document has already expired. Upload a current one.');
  if (Number((await pool.query(`SELECT count(*)::int n FROM driver_documents WHERE user_id=$1 AND status='pending'`, [me])).rows[0].n) >= 6) throw conflict('You have several documents waiting for review already');
  const f = await savePrivate(req.file.buffer);
  const row = (await pool.query(`INSERT INTO driver_documents(user_id,kind,file_key,mime,expires_on) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, status, expires_on, created_at`, [me, b.kind, f.key, f.mime, b.expires_on])).rows[0];
  res.status(201).json(row);
}));
trust.get('/driver/documents/:id/file', requireAuth, wrap(async (req, res) => {
  const d = (await pool.query('SELECT user_id, file_key, mime FROM driver_documents WHERE id=$1', [uuid.parse(req.params.id)])).rows[0];
  if (!d || (d.user_id !== req.user!.id && !req.user!.permissions.includes('review.documents'))) throw notFound('Document');
  if (d.user_id !== req.user!.id) await audit(pool, req.user!.id, 'document.viewed', 'driver_document', req.params.id as string);
  res.set({ 'Content-Type': d.mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' }).send(await readPrivate(d.file_key));
}));
trust.delete('/driver/documents/:id', requireAuth, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE driver_documents SET status='replaced' WHERE id=$1 AND user_id=$2 AND status IN ('pending','rejected')`, [uuid.parse(req.params.id), req.user!.id]);
  if (!r.rowCount) throw notFound('Document'); res.status(204).end();
}));
trust.get('/admin/driver-documents', requirePermission('review.documents'), wrap(async (req, res) => {
  const status = z.enum(['pending', 'approved', 'rejected', 'expired']).default('pending').parse(req.query.status ?? 'pending');
  const { rows } = await pool.query(`SELECT d.id, d.kind, d.expires_on, d.status, d.created_at, d.review_note, u.username, p.display_name, p.verification_level FROM driver_documents d JOIN users u ON u.id=d.user_id JOIN user_profiles p ON p.user_id=u.id WHERE d.status=$1 ORDER BY d.created_at LIMIT 100`, [status]);
  res.json({ items: rows });
}));
trust.post('/admin/driver-documents/:id/review', requirePermission('review.documents'), wrap(async (req, res) => {
  const b = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(300).optional() }).refine((v) => v.decision === 'approve' || !!v.note, 'Say why it was rejected').parse(req.body); const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const d = (await c.query(`SELECT * FROM driver_documents WHERE id=$1 FOR UPDATE`, [id])).rows[0]; if (!d) throw notFound('Document'); if (d.status !== 'pending') throw conflict(`This document is already ${d.status}`);
    if (b.decision === 'approve' && d.expires_on <= new Date().toISOString().slice(0, 10)) throw badRequest('This document has expired');
    await c.query(`UPDATE driver_documents SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4 WHERE id=$1`, [id, b.decision === 'approve' ? 'approved' : 'rejected', req.user!.id, b.note ?? null]);
    if (b.decision === 'approve') await c.query(`UPDATE driver_documents SET status='replaced' WHERE user_id=$1 AND kind=$2 AND id <> $3 AND status='approved'`, [d.user_id, d.kind, id]);
    await audit(c, req.user!.id, `document.${b.decision}`, 'driver_document', id, null, { kind: d.kind, note: b.note ?? null }, req.ip ?? null);
    await notify(c, { userId: d.user_id, type: 'document_review', targetType: 'account', targetId: d.user_id, data: { decision: b.decision === 'approve' ? 'approved' : 'rejected', kind: d.kind, note: b.note } });
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------------------------------------- risk review queue
trust.get('/admin/risk', requirePermission('moderate.content'), wrap(async (req, res) => {
  const status = z.enum(['open', 'dismissed', 'actioned']).default('open').parse(req.query.status ?? 'open');
  const { rows } = await pool.query(`SELECT r.id, r.entity_type, r.entity_id, r.score, r.reasons, r.status, r.created_at, r.note, u.username FROM risk_events r LEFT JOIN users u ON u.id=r.user_id WHERE r.status=$1 ORDER BY r.score DESC, r.created_at DESC LIMIT 100`, [status]);
  res.json({ items: rows });
}));
trust.post('/admin/risk/:id/resolve', requirePermission('moderate.content'), wrap(async (req, res) => {
  const b = z.object({ status: z.enum(['dismissed', 'actioned']), note: z.string().trim().max(300).optional() }).parse(req.body);
  const r = await pool.query(`UPDATE risk_events SET status=$2, reviewed_by=$3, reviewed_at=now(), note=$4 WHERE id=$1 AND status='open'`, [req.params.id, b.status, req.user!.id, b.note ?? null]);
  if (!r.rowCount) throw notFound('Risk event'); await audit(pool, req.user!.id, 'risk.resolve', 'risk_event', null, null, { id: req.params.id, ...b }); res.status(204).end();
}));

// ---------------------------------------------------------------------------------------------- safety: emergency contacts, trip sharing, live location, SOS
trust.get('/me/emergency-contacts', requireAuth, wrap(async (req, res) => { res.json({ items: (await pool.query('SELECT id, name, email, phone FROM emergency_contacts WHERE user_id=$1 ORDER BY created_at', [req.user!.id])).rows }); }));
trust.post('/me/emergency-contacts', requireAuth, wrap(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(80), email: z.string().email().optional(), phone: z.string().trim().max(30).optional() }).refine((v) => v.email || v.phone, 'Add an email or a phone number').parse(req.body);
  if (Number((await pool.query('SELECT count(*)::int n FROM emergency_contacts WHERE user_id=$1', [req.user!.id])).rows[0].n) >= 3) throw conflict('You can add up to 3 emergency contacts');
  res.status(201).json((await pool.query(`INSERT INTO emergency_contacts(user_id,name,email,phone) VALUES ($1,$2,$3,$4) RETURNING id, name, email, phone`, [req.user!.id, b.name, b.email ?? null, b.phone ?? null])).rows[0]);
}));
trust.delete('/me/emergency-contacts/:id', requireAuth, wrap(async (req, res) => { const r = await pool.query('DELETE FROM emergency_contacts WHERE id=$1 AND user_id=$2', [uuid.parse(req.params.id), req.user!.id]); if (!r.rowCount) throw notFound('Contact'); res.status(204).end(); }));

async function partyBooking(id: string, me: string, db: Db = pool) {
  const b = (await db.query('SELECT * FROM bookings WHERE id=$1 AND (shipper_id=$2 OR transporter_id=$2)', [id, me])).rows[0]; if (!b) throw notFound('Booking'); return b;
}
trust.post('/bookings/:id/share', requireAuth, wrap(async (req, res) => {
  const b = await partyBooking(uuid.parse(req.params.id), req.user!.id); if (b.status === 'cancelled') throw conflict('This booking was cancelled');
  if (Number((await pool.query(`SELECT count(*)::int n FROM trip_shares WHERE booking_id=$1 AND created_by=$2 AND revoked_at IS NULL AND expires_at > now()`, [b.id, req.user!.id])).rows[0].n) >= 5) throw conflict('You already have several active links. Revoke one first.');
  const token = crypto.randomBytes(18).toString('base64url');
  const row = (await pool.query(`INSERT INTO trip_shares(token,booking_id,created_by,expires_at) VALUES ($1,$2,$3, now() + interval '3 days') RETURNING expires_at`, [token, b.id, req.user!.id])).rows[0];
  res.status(201).json({ token, url: `${webOrigin()}/trip/${token}`, expires_at: row.expires_at });
}));
trust.get('/bookings/:id/shares', requireAuth, wrap(async (req, res) => {
  const b = await partyBooking(uuid.parse(req.params.id), req.user!.id);
  res.json({ items: (await pool.query(`SELECT token, created_at, expires_at FROM trip_shares WHERE booking_id=$1 AND created_by=$2 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [b.id, req.user!.id])).rows.map((r) => ({ ...r, url: `${webOrigin()}/trip/${r.token}` })) });
}));
trust.delete('/bookings/:id/shares/:token', requireAuth, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE trip_shares SET revoked_at=now() WHERE token=$1 AND booking_id=$2 AND created_by=$3 AND revoked_at IS NULL`, [req.params.token, uuid.parse(req.params.id), req.user!.id]); if (!r.rowCount) throw notFound('Link'); res.status(204).end();
}));
/** Public, no sign-in: whoever holds the link sees progress only. Never addresses, PINs, phone numbers or the other person's full name. */
trust.get('/trip/:token', wrap(async (req, res) => {
  const t = (await pool.query(`SELECT booking_id FROM trip_shares WHERE token=$1 AND revoked_at IS NULL AND expires_at > now()`, [String(req.params.token).slice(0, 60)])).rows[0];
  if (!t) throw notFound('This trip link is no longer active');
  const b = (await pool.query(
    `SELECT b.status, b.share_location, b.pickup_confirmed_at, b.delivered_at, r.origin_city, r.dest_city, r.title, split_part(p.display_name, ' ', 1) AS driver_first, j.vehicle_type AS jv, s.vehicle_type AS sv
     FROM bookings b JOIN transport_requests r ON r.id=b.request_id JOIN user_profiles p ON p.user_id=b.transporter_id LEFT JOIN journeys j ON j.id=b.journey_id LEFT JOIN transport_services s ON s.id=b.service_id WHERE b.id=$1`, [t.booking_id])).rows[0];
  const loc = b.share_location && ['pickup_confirmed', 'in_transit'].includes(b.status) ? (await pool.query('SELECT lat, lng, recorded_at FROM booking_locations WHERE booking_id=$1 ORDER BY id DESC LIMIT 1', [t.booking_id])).rows[0] : null;
  res.set('Cache-Control', 'no-store').json({ route: { from: b.origin_city, to: b.dest_city }, item: b.title, status: b.status, driver_first_name: b.driver_first, vehicle: b.jv ?? b.sv ?? null, picked_up_at: b.pickup_confirmed_at, delivered_at: b.delivered_at, location: loc ? { lat: loc.lat, lng: loc.lng, at: loc.recorded_at } : null, note: 'Shared by a twiqo member. Exact addresses are never shown here.' });
}));

trust.put('/bookings/:id/location/consent', requireAuth, wrap(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body); const b = await partyBooking(uuid.parse(req.params.id), req.user!.id);
  if (b.transporter_id !== req.user!.id) throw forbidden('Only the driver can share their location'); if (['cancelled', 'completed'].includes(b.status)) throw conflict('This booking is finished');
  await pool.query('UPDATE bookings SET share_location=$2 WHERE id=$1', [b.id, enabled]); if (!enabled) await pool.query('DELETE FROM booking_locations WHERE booking_id=$1', [b.id]); res.json({ enabled });
}));
trust.post('/bookings/:id/location', requireAuth, wrap(async (req, res) => {
  const p = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy_m: z.number().int().min(0).max(100000).optional() }).parse(req.body);
  const b = await partyBooking(uuid.parse(req.params.id), req.user!.id); if (b.transporter_id !== req.user!.id) throw forbidden('Only the driver can share their location');
  if (!b.share_location) throw conflict('Turn on location sharing for this booking first'); if (!['pickup_confirmed', 'in_transit'].includes(b.status)) throw conflict('Location can be shared between pickup and delivery');
  const last = (await pool.query('SELECT recorded_at FROM booking_locations WHERE booking_id=$1 ORDER BY id DESC LIMIT 1', [b.id])).rows[0]; if (last && Date.now() - new Date(last.recorded_at).getTime() < 5000) return void res.status(202).json({ recorded: false });
  await pool.query('INSERT INTO booking_locations(booking_id,lat,lng,accuracy_m) VALUES ($1,$2,$3,$4)', [b.id, p.lat, p.lng, p.accuracy_m ?? null]);
  await pool.query(`DELETE FROM booking_locations WHERE booking_id=$1 AND id < (SELECT id FROM booking_locations WHERE booking_id=$1 ORDER BY id DESC OFFSET 199 LIMIT 1)`, [b.id]);
  res.status(201).json({ recorded: true });
}));
trust.get('/bookings/:id/location', requireAuth, wrap(async (req, res) => {
  const b = await partyBooking(uuid.parse(req.params.id), req.user!.id);
  const live = b.share_location && ['pickup_confirmed', 'in_transit'].includes(b.status);
  const trail = live ? (await pool.query('SELECT lat, lng, recorded_at FROM booking_locations WHERE booking_id=$1 ORDER BY id DESC LIMIT 20', [b.id])).rows : [];
  res.json({ sharing: !!b.share_location, live, latest: trail[0] ?? null, trail: trail.reverse() });
}));

trust.post('/bookings/:id/sos', requireAuth, wrap(async (req, res) => {
  const p = z.object({ message: z.string().trim().max(500).optional(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() }).parse(req.body ?? {});
  const me = req.user!.id; const b = await partyBooking(uuid.parse(req.params.id), me);
  const cap = Number(await setting('safety.sos_per_hour', 3)); if (Number((await pool.query(`SELECT count(*)::int n FROM safety_incidents WHERE user_id=$1 AND created_at > now() - interval '1 hour'`, [me])).rows[0].n) >= cap) throw new HttpError(429, 'You have already sent several alerts. If you are in danger, call 911.', 'rate_limited');
  const who = (await pool.query('SELECT display_name FROM user_profiles WHERE user_id=$1', [me])).rows[0].display_name as string;
  const other = b.shipper_id === me ? b.transporter_id : b.shipper_id;
  const inc = await tx(async (c) => {
    const i = (await c.query(`INSERT INTO safety_incidents(booking_id,user_id,message,lat,lng) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`, [b.id, me, p.message ?? null, p.lat ?? null, p.lng ?? null])).rows[0];
    await notify(c, { userId: other, type: 'safety_alert', actorId: me, targetType: 'booking', targetId: b.id, data: { message: p.message ?? 'They pressed the safety alert. Please check in with them.' } });
    for (const s of (await c.query(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_key=ur.role_key WHERE rp.permission_key='review.documents'`)).rows) await notify(c, { userId: s.user_id, type: 'safety_alert', actorId: me, targetType: 'booking', targetId: b.id, data: { message: `SOS on a booking: ${p.message ?? 'no message'}` } });
    const where = p.lat !== undefined && p.lng !== undefined ? ` Last known location: https://www.google.com/maps?q=${p.lat},${p.lng}` : '';
    const contacts = (await c.query('SELECT name, email FROM emergency_contacts WHERE user_id=$1 AND email IS NOT NULL', [me])).rows;
    for (const e of contacts) await queueEmail(c, { to: e.email, template: 'notification', vars: { subject: `${who} sent a safety alert from twiqo`, body: `${who} listed you as an emergency contact and pressed the safety alert during a delivery. ${p.message ? `They wrote: "${p.message}". ` : ''}Please try to reach them.${where} If you think they are in danger, call 911.` } });
    await audit(c, me, 'safety.sos', 'booking', b.id);
    return { id: i.id as string, contacts_emailed: contacts.length };
  });
  res.status(201).json({ ...inc, note: 'twiqo staff and the other person were alerted. twiqo is not an emergency service: if you are in danger, call 911 now.' });
}));
trust.get('/admin/safety-incidents', requirePermission('review.documents'), wrap(async (req, res) => {
  const status = z.enum(['open', 'resolved']).default('open').parse(req.query.status ?? 'open');
  res.json({ items: (await pool.query(`SELECT i.id, i.booking_id, i.message, i.lat, i.lng, i.status, i.created_at, i.resolution_note, u.username FROM safety_incidents i JOIN users u ON u.id=i.user_id WHERE i.status=$1 ORDER BY i.created_at DESC LIMIT 100`, [status])).rows });
}));
trust.post('/admin/safety-incidents/:id/resolve', requirePermission('review.documents'), wrap(async (req, res) => {
  const b = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body);
  const r = await pool.query(`UPDATE safety_incidents SET status='resolved', resolved_by=$2, resolved_at=now(), resolution_note=$3 WHERE id=$1 AND status='open'`, [uuid.parse(req.params.id), req.user!.id, b.note]); if (!r.rowCount) throw notFound('Incident');
  await audit(pool, req.user!.id, 'safety.resolve', 'safety_incident', req.params.id as string, null, { note: b.note }); res.status(204).end();
}));

void sleepNoop;
function sleepNoop() { /* keeps the import list stable */ }
