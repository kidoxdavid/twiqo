import crypto from 'node:crypto';
import { track } from '../lib/analytics.js';
import { attachReferral } from './growth.js';
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { HttpError, wrap } from '../lib/errors.js';
import { hashPassword, verifyPassword, signAccess, newRefreshToken, hashToken, requireAuth } from '../lib/auth.js';
import { resolvePlace } from '../lib/geo.js';
import { checkText, setting } from '../lib/policy.js';
import { sha256 } from '../lib/secrets.js';
import { issueVerifyEmail, checkOtp, noteDevice } from './security.js';

export const identity = Router();

export const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
  skip: () => config.RATE_LIMIT_DISABLED === 'true' });

const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/, 'Use 3–30 letters, numbers, dots or underscores'),
  password: z.string().min(8).max(128),
  ref: z.string().trim().max(20).optional(),
  accept_terms: z.literal(true, { error: 'Please accept the Terms and Privacy Policy' }),
  display_name: z.string().trim().min(1).max(60),
  city: z.string().optional(), province: z.string().length(2).optional(),
  account_type: z.enum(['individual', 'business']).default('individual'),
});

export async function issueSession(userId: string, req: { headers: Record<string, unknown>; ip?: string }) {
  const refresh = newRefreshToken(); const ua = String(req.headers['user-agent'] ?? '').slice(0, 200);
  const sid = (await pool.query(
    `INSERT INTO sessions(user_id, refresh_hash, user_agent, ip, device_hash, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval) RETURNING id`,
    [userId, hashToken(refresh), ua, req.ip ?? null, sha256(ua || 'unknown'), String(config.REFRESH_TOKEN_TTL_DAYS)])).rows[0].id as string;
  return { access_token: signAccess(userId, sid), refresh_token: refresh };
}

export async function meView(userId: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.username, u.account_type, u.status, u.locale, u.referral_code, p.display_name, p.bio, p.city, p.province, p.privacy, p.verification_level,
            p.follower_count, p.following_count, p.avatar_media_id, p.cover_media_id,
            coalesce((SELECT array_agg(role_key) FROM user_roles WHERE user_id = u.id), '{}') AS roles,
            coalesce((SELECT array_agg(DISTINCT rp.permission_key) FROM user_roles ur JOIN role_permissions rp ON rp.role_key = ur.role_key WHERE ur.user_id = u.id), '{}') AS permissions,
            (SELECT m.storage_key FROM media_assets m WHERE m.id = p.avatar_media_id) AS avatar_key
     FROM users u JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1`, [userId]);
  return rows[0];
}

identity.post('/auth/register', limiter, wrap(async (req, res) => {
  const b = registerSchema.parse(req.body);
  await checkText(b.display_name); await checkText(b.username);
  const place = b.city ? await resolvePlace(b.city, b.province) : null;
  const userId = await tx(async (c) => {
    const u = await c.query(`INSERT INTO users(email, username, password_hash, account_type, referral_code, terms_version, terms_accepted_at) VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
      [b.email, b.username, await hashPassword(b.password), b.account_type, crypto.randomBytes(4).toString('hex'), String(await setting('terms.version', 'unversioned', c))]).catch((e) => {
        if (e.code === '23505') throw new HttpError(409, e.constraint?.includes('email') ? 'That email is already registered' : 'That username is taken', 'conflict');
        throw e;
      });
    await c.query(
      `INSERT INTO user_profiles(user_id, display_name, city, province, location)
       VALUES ($1,$2,$3,$4, CASE WHEN $5::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($5,$6),4326)::geography END)`,
      [u.rows[0].id, b.display_name, place?.city ?? null, place?.province ?? null, place?.lng ?? null, place?.lat ?? null]);
    await attachReferral(c, u.rows[0].id, b.ref);
    return u.rows[0].id as string;
  });
  await track(pool, { name: 'signup', userId, props: b.ref ? { referred: true } : {} });
  await issueVerifyEmail(userId).catch((e) => console.error('verification email failed', e.message));
  await noteDevice(userId, req, false);
  res.status(201).json({ user: await meView(userId), ...(await issueSession(userId, req)) });
}));

identity.post('/auth/login', limiter, wrap(async (req, res) => {
  const b = z.object({ identifier: z.string().min(3), password: z.string().min(1), otp: z.string().trim().max(20).optional() }).parse(req.body);
  const { rows } = await pool.query(`SELECT id, password_hash, status, suspended_until, failed_logins, locked_until, totp_enabled_at FROM users WHERE email = $1 OR username = $1`, [b.identifier]);
  const u = rows[0];
  const bad = new HttpError(401, 'Incorrect email/username or password', 'invalid_credentials');
  if (!u) { await hashPassword(b.password); throw bad; }   // equalise timing
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.', 'locked');
  if (!(await verifyPassword(b.password, u.password_hash))) {
    await pool.query(`UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END WHERE id = $1`, [u.id]);
    throw bad;
  }
  if (u.status === 'banned' || u.status === 'deleted') throw new HttpError(403, 'This account is not available', 'suspended');
  if (u.totp_enabled_at) {
    if (!b.otp) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app', 'otp_required');
    if (!(await checkOtp(u.id, b.otp))) {
      await pool.query(`UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END WHERE id = $1`, [u.id]);
      throw new HttpError(401, 'That code is not correct', 'otp_invalid');
    }
  }
  await pool.query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_seen_at = now() WHERE id = $1`, [u.id]);
  await noteDevice(u.id, req, true);
  res.json({ user: await meView(u.id), ...(await issueSession(u.id, req)) });
}));

identity.post('/auth/refresh', wrap(async (req, res) => {
  const { refresh_token } = z.object({ refresh_token: z.string().min(10) }).parse(req.body);
  const out = await tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE sessions SET revoked_at = now() WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`, [hashToken(refresh_token)]);
    if (!rows[0]) throw new HttpError(401, 'Session expired. Please sign in again.', 'unauthorized');
    return rows[0].user_id as string;
  });
  res.json(await issueSession(out, req));
}));

identity.post('/auth/logout', wrap(async (req, res) => {
  const { refresh_token } = z.object({ refresh_token: z.string().optional() }).parse(req.body ?? {});
  if (refresh_token) await pool.query(`UPDATE sessions SET revoked_at = now() WHERE refresh_hash = $1`, [hashToken(refresh_token)]);
  res.status(204).end();
}));

identity.get('/me', requireAuth, wrap(async (req, res) => { res.json({ user: await meView(req.user!.id) }); }));
