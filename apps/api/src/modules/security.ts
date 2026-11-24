import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { HttpError, badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { hashPassword, hashToken, requireAuth, verifyPassword } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { emailUser } from '../lib/email.js';
import { decryptField, encryptField, randomToken, sha256 } from '../lib/secrets.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';

export const security = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, skip: () => config.RATE_LIMIT_DISABLED === 'true' });
const webOrigin = () => config.WEB_ORIGIN.split(',')[0];

// ---------------------------------------------------------------------------------------------- tokens (email verification, password reset)
async function makeToken(userId: string, kind: 'verify_email' | 'reset_password', hours: number, data: Record<string, unknown> = {}) {
  await pool.query(`UPDATE user_tokens SET used_at = now() WHERE user_id=$1 AND kind=$2 AND used_at IS NULL`, [userId, kind]);   // only the newest link works
  const token = randomToken();
  await pool.query(`INSERT INTO user_tokens(user_id,kind,token_hash,data,expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval)`, [userId, kind, sha256(token), JSON.stringify(data), String(hours)]);
  return token;
}
async function useToken(token: string, kind: string) {
  const r = (await pool.query(`UPDATE user_tokens SET used_at = now() WHERE token_hash=$1 AND kind=$2 AND used_at IS NULL AND expires_at > now() RETURNING user_id, data`, [sha256(token), kind])).rows[0];
  if (!r) throw new HttpError(400, 'This link is invalid or has expired. Request a new one.', 'invalid_token');
  return r as { user_id: string; data: Record<string, unknown> };
}

export async function issueVerifyEmail(userId: string) {
  const u = (await pool.query('SELECT email_verified_at FROM users WHERE id=$1', [userId])).rows[0]; if (!u || u.email_verified_at) return false;
  const token = await makeToken(userId, 'verify_email', 24);
  await emailUser(pool, userId, 'verify_email', { url: `${webOrigin()}/verify-email?token=${token}` }); return true;
}
security.post('/auth/verify-email/request', requireAuth, limiter, wrap(async (req, res) => {
  const sent = await issueVerifyEmail(req.user!.id); res.json({ sent, already_verified: !sent });
}));
security.post('/auth/verify-email', limiter, wrap(async (req, res) => {
  const { token } = z.object({ token: z.string().min(10).max(100) }).parse(req.body);
  const t = await useToken(token, 'verify_email');
  await pool.query(`UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id=$1`, [t.user_id]);
  await pool.query(`UPDATE user_profiles SET verification_level = CASE WHEN verification_level = 'none' THEN 'email' ELSE verification_level END WHERE user_id=$1`, [t.user_id]);
  res.json({ verified: true });
}));

security.post('/auth/password/forgot', limiter, wrap(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const u = (await pool.query(`SELECT id FROM users WHERE email=$1 AND status IN ('active','suspended')`, [email])).rows[0];
  if (u) { const token = await makeToken(u.id, 'reset_password', 1); await emailUser(pool, u.id, 'reset_password', { url: `${webOrigin()}/reset-password?token=${token}` }); }
  res.json({ sent: true });   // same answer whether or not the address exists
}));
const passwordRule = z.string().min(8).max(128);
async function revokeSessions(userId: string, exceptSid?: string) {
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`, [userId, exceptSid ?? null]);
}
security.post('/auth/password/reset', limiter, wrap(async (req, res) => {
  const b = z.object({ token: z.string().min(10).max(100), password: passwordRule }).parse(req.body);
  const t = await useToken(b.token, 'reset_password');
  await pool.query(`UPDATE users SET password_hash=$2, password_changed_at=now(), failed_logins=0, locked_until=NULL WHERE id=$1`, [t.user_id, await hashPassword(b.password)]);
  await revokeSessions(t.user_id); await emailUser(pool, t.user_id, 'password_changed');
  res.json({ reset: true });
}));
security.post('/me/password', requireAuth, limiter, wrap(async (req, res) => {
  const b = z.object({ current_password: z.string().min(1), new_password: passwordRule }).parse(req.body); const me = req.user!.id;
  const u = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [me])).rows[0];
  if (!(await verifyPassword(b.current_password, u.password_hash))) throw new HttpError(403, 'Your current password is not correct', 'invalid_credentials');
  await pool.query(`UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1`, [me, await hashPassword(b.new_password)]);
  await revokeSessions(me, req.user!.sid); await emailUser(pool, me, 'password_changed');
  res.json({ changed: true });
}));

// ---------------------------------------------------------------------------------------------- sessions and devices
const deviceLabel = (ua: string) => { const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown device'; const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser'; return `${br} on ${os}`; };
/** Remember the device; on a sign-in from a device we haven't seen (and the person has used others), email a heads-up. */
export async function noteDevice(userId: string, req: Pick<Request, 'headers'>, alert: boolean) {
  try {
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 200); const h = sha256(ua || 'unknown'); const label = deviceLabel(ua);
    const had = (await pool.query('SELECT 1 FROM known_devices WHERE user_id=$1 LIMIT 1', [userId])).rowCount;
    const ins = await pool.query(`INSERT INTO known_devices(user_id,device_hash,label) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`, [userId, h, label]);
    if (alert && had && ins.rowCount) await emailUser(pool, userId, 'login_alert', { device: label, time: new Date().toUTCString() });
  } catch (e) { console.error('device check failed', (e as Error).message); }
}
security.get('/me/sessions', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, user_agent, created_at, last_used_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC, created_at DESC LIMIT 50`, [req.user!.id]);
  res.json({ items: rows.map((s) => ({ id: s.id, device: deviceLabel(s.user_agent ?? ''), created_at: s.created_at, last_used_at: s.last_used_at, current: s.id === req.user!.sid })) });
}));
security.delete('/me/sessions/:id', requireAuth, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE sessions SET revoked_at = now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, [z.string().uuid().parse(req.params.id), req.user!.id]);
  if (!r.rowCount) throw notFound('Session'); res.status(204).end();
}));
security.post('/me/sessions/revoke-others', requireAuth, wrap(async (req, res) => { await revokeSessions(req.user!.id, req.user!.sid); res.status(204).end(); }));

// ---------------------------------------------------------------------------------------------- two-step verification (TOTP + recovery codes)
/** Accepts a current authenticator code (each 30-second code works once) or an unused recovery code. */
export async function checkOtp(userId: string, input: string): Promise<boolean> {
  const u = (await pool.query('SELECT totp_secret_enc, totp_last_step FROM users WHERE id=$1', [userId])).rows[0]; if (!u?.totp_secret_enc) return false;
  const code = input.replace(/\s/g, '');
  const step = verifyTotp(decryptField(u.totp_secret_enc), code);
  if (step !== null) {
    const r = await pool.query(`UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2)`, [userId, step]);
    return !!r.rowCount;   // a code that was already used is rejected (replay)
  }
  const r = await pool.query(`UPDATE recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL`, [userId, sha256(code.toLowerCase())]);
  return !!r.rowCount;
}
security.get('/me/security', requireAuth, wrap(async (req, res) => {
  const u = (await pool.query(`SELECT email, email_verified_at, totp_enabled_at, password_changed_at, terms_version, terms_accepted_at, (SELECT count(*)::int FROM sessions s WHERE s.user_id=users.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS sessions, (SELECT count(*)::int FROM recovery_codes r WHERE r.user_id=users.id AND r.used_at IS NULL) AS recovery_left FROM users WHERE id=$1`, [req.user!.id])).rows[0];
  res.json({ email: u.email, email_verified: !!u.email_verified_at, two_factor: !!u.totp_enabled_at, recovery_codes_left: u.recovery_left, active_sessions: u.sessions, password_changed_at: u.password_changed_at, terms: { version: u.terms_version, accepted_at: u.terms_accepted_at } });
}));
security.post('/me/2fa/setup', requireAuth, limiter, wrap(async (req, res) => {
  const me = req.user!.id; const u = (await pool.query('SELECT email, totp_enabled_at FROM users WHERE id=$1', [me])).rows[0];
  if (u.totp_enabled_at) throw conflict('Two-step verification is already on');
  const secret = newTotpSecret(); await pool.query('UPDATE users SET totp_secret_enc=$2 WHERE id=$1', [me, encryptField(secret)]);
  res.json({ secret, otpauth_url: otpauthUrl(secret, u.email) });
}));
security.post('/me/2fa/enable', requireAuth, limiter, wrap(async (req, res) => {
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body); const me = req.user!.id;
  const u = (await pool.query('SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id=$1', [me])).rows[0];
  if (u.totp_enabled_at) throw conflict('Two-step verification is already on'); if (!u.totp_secret_enc) throw badRequest('Start setup first');
  const step = verifyTotp(decryptField(u.totp_secret_enc), code); if (step === null) throw new HttpError(400, 'That code is not correct. Check the time on your phone and try again.', 'otp_invalid');
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
  await tx(async (c) => {
    await c.query('UPDATE users SET totp_enabled_at=now(), totp_last_step=$2 WHERE id=$1', [me, step]);
    await c.query('DELETE FROM recovery_codes WHERE user_id=$1', [me]);
    for (const k of codes) await c.query('INSERT INTO recovery_codes(user_id,code_hash) VALUES ($1,$2)', [me, sha256(k)]);
    await audit(c, me, 'security.2fa_enabled', 'user', me);
  });
  await emailUser(pool, me, 'two_factor_changed', { state: 'on' });
  res.json({ enabled: true, recovery_codes: codes, note: 'Save these recovery codes somewhere safe. Each works once and they will not be shown again.' });
}));
security.post('/me/2fa/disable', requireAuth, limiter, wrap(async (req, res) => {
  const b = z.object({ password: z.string().min(1), code: z.string().min(6).max(20) }).parse(req.body); const me = req.user!.id;
  const u = (await pool.query('SELECT password_hash, totp_enabled_at FROM users WHERE id=$1', [me])).rows[0];
  if (!u.totp_enabled_at) throw conflict('Two-step verification is not on');
  if (!(await verifyPassword(b.password, u.password_hash))) throw new HttpError(403, 'Your password is not correct', 'invalid_credentials');
  if (!(await checkOtp(me, b.code))) throw new HttpError(400, 'That code is not correct', 'otp_invalid');
  await pool.query('UPDATE users SET totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE id=$1', [me]); await pool.query('DELETE FROM recovery_codes WHERE user_id=$1', [me]);
  await audit(pool, me, 'security.2fa_disabled', 'user', me); await emailUser(pool, me, 'two_factor_changed', { state: 'off' });
  res.json({ enabled: false });
}));

// ---------------------------------------------------------------------------------------------- data export and deletion (PIPEDA)
security.get('/me/export', requireAuth, limiter, wrap(async (req, res) => {
  const me = req.user!.id; const q = async (sql: string) => (await pool.query(sql, [me])).rows;
  const data = {
    exported_at: new Date().toISOString(), note: 'Your personal data held by twiqo. Other people\'s content and private details are not included.',
    account: (await q(`SELECT u.id, u.email, u.username, u.account_type, u.created_at, u.email_verified_at, u.locale, u.terms_version, u.terms_accepted_at, p.display_name, p.bio, p.city, p.province, p.privacy FROM users u JOIN user_profiles p ON p.user_id=u.id WHERE u.id=$1`))[0],
    listings: await q(`SELECT id, title, description, price_cents, status, city, tags, created_at FROM listings WHERE seller_id=$1`),
    posts: await q(`SELECT id, body, visibility, created_at FROM posts WHERE author_id=$1 AND status <> 'removed'`),
    comments: await q(`SELECT id, target_type, target_id, body, created_at FROM comments WHERE author_id=$1`),
    messages: await q(`SELECT m.id, m.conversation_id, m.body, m.created_at FROM messages m WHERE m.sender_id=$1 ORDER BY m.created_at`),
    offers: await q(`SELECT id, kind, amount_cents, status, message, created_at FROM offers WHERE proposer_id=$1`),
    orders: await q(`SELECT id, listing_id, total_cents, status, payment_status, created_at FROM orders WHERE buyer_id=$1 OR seller_id=$1`),
    bookings: await q(`SELECT id, request_id, agreed_cents, status, payment_status, created_at FROM bookings WHERE shipper_id=$1 OR transporter_id=$1`),
    payments: await q(`SELECT id, kind, amount_cents, fee_cents, status, created_at FROM payments WHERE payer_id=$1 OR payee_id=$1`),
    reviews_written: await q(`SELECT booking_id, order_id, rating, comment, created_at FROM reviews WHERE reviewer_id=$1`),
    follows: await q(`SELECT target_type, target_id, created_at FROM follows WHERE follower_id=$1`),
    saved: await q(`SELECT target_type, target_id, created_at FROM saved_items WHERE user_id=$1`),
    credit_ledger: await q(`SELECT amount_cents, reason, created_at FROM credit_ledger WHERE user_id=$1`),
    sessions: await q(`SELECT user_agent, created_at, last_used_at FROM sessions WHERE user_id=$1`),
  };
  await audit(pool, me, 'privacy.export', 'user', me);
  res.setHeader('Content-Disposition', 'attachment; filename="twiqo-my-data.json"').json(data);
}));

security.delete('/me', requireAuth, limiter, wrap(async (req, res) => {
  const b = z.object({ password: z.string().min(1) }).parse(req.body); const me = req.user!.id;
  const u = (await pool.query('SELECT password_hash, email, locale FROM users WHERE id=$1', [me])).rows[0];
  if (!(await verifyPassword(b.password, u.password_hash))) throw new HttpError(403, 'Your password is not correct', 'invalid_credentials');
  const open = (await pool.query(
    `SELECT (SELECT count(*) FROM orders WHERE (buyer_id=$1 OR seller_id=$1) AND status='agreed')::int AS orders,
            (SELECT count(*) FROM bookings WHERE (shipper_id=$1 OR transporter_id=$1) AND status NOT IN ('completed','cancelled'))::int AS bookings,
            (SELECT count(*) FROM disputes WHERE (opened_by=$1 OR other_party_id=$1) AND status='open')::int AS disputes,
            (SELECT count(*) FROM payments WHERE payer_id=$1 AND status IN ('requires_payment','processing'))::int AS payments`, [me])).rows[0];
  if (Object.values(open).some((n) => Number(n) > 0)) throw new HttpError(409, 'Finish or cancel your open orders, bookings and disputes first, then you can delete your account.', 'active_deals');
  const tombstone = `deleted_${me.replace(/-/g, "").slice(0, 12)}`;
  await tx(async (c) => {
    await c.query(`UPDATE users SET status='deleted', deleted_at=now(), email=$2, username=$3, password_hash='!', totp_secret_enc=NULL, totp_enabled_at=NULL, referral_code=NULL WHERE id=$1`, [me, `${tombstone}@deleted.invalid`, tombstone]);
    await c.query(`UPDATE user_profiles SET display_name='Deleted user', bio=NULL, avatar_media_id=NULL, cover_media_id=NULL, city=NULL, province=NULL, postal_fsa=NULL, location=NULL WHERE user_id=$1`, [me]);
    await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [me]);
    await c.query(`UPDATE listings SET status='removed' WHERE seller_id=$1 AND status IN ('active','reserved','pending_review','draft')`, [me]);
    await c.query(`UPDATE feed_items SET status='removed' WHERE author_id=$1`, [me]);
    await c.query(`UPDATE posts SET status='removed' WHERE author_id=$1`, [me]);
    await c.query(`UPDATE transport_requests SET status='cancelled' WHERE requester_id=$1 AND status='open'`, [me]);
    await c.query(`UPDATE journeys SET status='cancelled' WHERE driver_id=$1 AND status IN ('open','full')`, [me]);
    await c.query(`UPDATE transport_services SET status='removed' WHERE provider_id=$1`, [me]);
    await c.query(`UPDATE offers SET status='withdrawn' WHERE (customer_id=$1 OR provider_id=$1) AND status IN ('pending','countered')`, [me]);
    await c.query(`DELETE FROM follows WHERE follower_id=$1 OR (target_type='user' AND target_id=$1)`, [me]);
    await c.query(`DELETE FROM saved_items WHERE user_id=$1`, [me]);
    await c.query(`DELETE FROM user_tokens WHERE user_id=$1`, [me]); await c.query(`DELETE FROM recovery_codes WHERE user_id=$1`, [me]); await c.query(`DELETE FROM known_devices WHERE user_id=$1`, [me]);
    await audit(c, me, 'privacy.account_deleted', 'user', me);
  });
  await emailUserAddress(u.email, u.locale, me);
  res.status(204).end();
}));
async function emailUserAddress(email: string, locale: 'en' | 'fr', userId: string) {
  const { queueEmail } = await import('../lib/email.js'); await queueEmail(pool, { userId, to: email, template: 'account_deleted', locale });
}
void hashToken;
