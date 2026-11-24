import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError, forbidden } from './errors.js';

export interface AuthUser { id: string; roles: string[]; permissions: string[]; sid?: string }
declare module 'express-serve-static-core' { interface Request { user?: AuthUser } }

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await new Promise<Buffer>((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384 }, (e, k) => (e ? rej(e) : res(k))));
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, s, k] = stored.split('$');
  const key = await new Promise<Buffer>((res, rej) => crypto.scrypt(pw, Buffer.from(s, 'base64'), 64, { N: 16384 }, (e, kk) => (e ? rej(e) : res(kk))));
  return crypto.timingSafeEqual(key, Buffer.from(k, 'base64'));
}

export const signAccess = (userId: string, sid?: string) =>
  jwt.sign({ sub: userId, ...(sid ? { sid } : {}) }, config.JWT_SECRET, { expiresIn: `${config.ACCESS_TOKEN_TTL_MIN}m` });
export const newRefreshToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

async function loadUser(id: string, sid?: string): Promise<AuthUser | null> {
  const { rows } = await pool.query(
    `SELECT u.status, u.suspended_until,
            coalesce(array_agg(DISTINCT ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles,
            coalesce(array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS perms,
            ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = $2::uuid AND s.user_id = u.id AND s.revoked_at IS NULL)) AS session_ok
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN role_permissions rp ON rp.role_key = ur.role_key
     WHERE u.id = $1 GROUP BY u.id`, [id, sid ?? null]);
  const r = rows[0];
  if (!r) return null;
  if (r.status === 'deleted') throw new HttpError(401, 'This account no longer exists', 'unauthorized');
  const suspended = r.status === 'suspended' && (!r.suspended_until || new Date(r.suspended_until) > new Date());
  if (r.status === 'banned' || r.status === 'deleted' || suspended) throw new HttpError(403, 'This account is suspended', 'suspended');
  if (!r.session_ok) throw new HttpError(401, 'This session was signed out', 'unauthorized');   // revoked from Settings or by a password change
  return { id, roles: r.roles, permissions: r.perms, sid };
}

async function authenticate(req: Request): Promise<void> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return;
  try {
    const p = jwt.verify(h.slice(7), config.JWT_SECRET) as { sub: string; sid?: string };
    const u = await loadUser(p.sub, p.sid);
    if (u) req.user = u;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, 'Invalid or expired token', 'unauthorized');
  }
}

export const optionalAuth = (req: Request, _res: Response, next: NextFunction) => { authenticate(req).then(() => next(), next); };
export const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
  authenticate(req).then(() => (req.user ? next() : next(new HttpError(401, 'Sign in required', 'unauthorized'))), next);
};
export const requirePermission = (perm: string) => (req: Request, res: Response, next: NextFunction) =>
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.user!.permissions.includes(perm)) return next(forbidden());
    next();
  });
