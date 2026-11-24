import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { forbidden, notFound, wrap, conflict } from '../lib/errors.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';
import { checkText } from '../lib/policy.js';
import { mediaUrl } from '../lib/views.js';

export const business = Router();

const ROLES = ['owner', 'manager', 'listing_manager', 'customer_support', 'delivery_coordinator'] as const;
/** Which business roles may do what. Keep in one place so it is easy to audit. */
export const BUSINESS_CAPS: Record<string, string[]> = {
  owner: ['manage_team', 'edit_profile', 'manage_listings', 'support', 'delivery'],
  manager: ['manage_team', 'edit_profile', 'manage_listings', 'support', 'delivery'],
  listing_manager: ['manage_listings'],
  customer_support: ['support'],
  delivery_coordinator: ['delivery'],
};

export async function businessRole(businessId: string, userId: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT role FROM business_members WHERE business_id=$1 AND user_id=$2', [businessId, userId]);
  return rows[0]?.role ?? null;
}
export async function can(businessId: string, userId: string, cap: string) {
  const r = await businessRole(businessId, userId);
  return !!r && BUSINESS_CAPS[r].includes(cap);
}

business.post('/businesses', requireAuth, wrap(async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2).max(80), slug: z.string().toLowerCase().regex(/^[a-z0-9-]{3,40}$/),
    description: z.string().max(2000).optional(), category: z.string().max(60).optional(),
    city: z.string().optional(), province: z.string().length(2).optional(),
    contact_email: z.string().email().optional(), phone: z.string().max(30).optional(), service_radius_km: z.number().int().min(0).max(5000).optional(),
  }).parse(req.body);
  await checkText(b.name); await checkText(b.description);
  const row = await tx(async (c) => {
    const r = await c.query(
      `INSERT INTO businesses(owner_id,name,slug,description,category,city,province,contact_email,phone,service_radius_km) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user!.id, b.name, b.slug, b.description ?? null, b.category ?? null, b.city ?? null, b.province ?? null, b.contact_email ?? null, b.phone ?? null, b.service_radius_km ?? null])
      .catch((e) => { if (e.code === '23505') throw conflict('That business URL is taken'); throw e; });
    await c.query(`INSERT INTO business_members(business_id,user_id,role) VALUES ($1,$2,'owner')`, [r.rows[0].id, req.user!.id]);
    return r.rows[0];
  });
  res.status(201).json(row);
}));

business.get('/businesses/:slug', optionalAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, (SELECT storage_key FROM media_assets WHERE id=b.logo_media_id) AS logo_key, (SELECT storage_key FROM media_assets WHERE id=b.cover_media_id) AS cover_key,
       (SELECT count(*) FROM listings l WHERE l.business_id=b.id AND l.status='active')::int AS listing_count,
       EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=$2 AND f.target_type='business' AND f.target_id=b.id) AS i_follow
     FROM businesses b WHERE b.slug=$1 AND b.status='active'`, [req.params.slug, req.user?.id ?? null]);
  const r = rows[0];
  if (!r) throw notFound('Business');
  const myRole = req.user ? await businessRole(r.id, req.user.id) : null;
  res.json({ id: r.id, name: r.name, slug: r.slug, description: r.description, category: r.category, city: r.city, province: r.province,
    verification_status: r.verification_status, follower_count: r.follower_count, listing_count: r.listing_count,
    contact_email: r.contact_email, phone: r.phone, service_radius_km: r.service_radius_km,
    logo_url: r.logo_key ? mediaUrl(r.logo_key) : null, cover_url: r.cover_key ? mediaUrl(r.cover_key) : null,
    viewer: { following: r.i_follow, role: myRole } });
}));

business.patch('/businesses/:id', requireAuth, wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  if (!(await can(id, req.user!.id, 'edit_profile'))) throw forbidden();
  const b = z.object({ name: z.string().trim().min(2).max(80), description: z.string().max(2000).nullable(), category: z.string().max(60).nullable(),
    contact_email: z.string().email().nullable(), phone: z.string().max(30).nullable(), service_radius_km: z.number().int().min(0).max(5000).nullable(),
    logo_media_id: z.string().uuid().nullable(), cover_media_id: z.string().uuid().nullable() }).partial().parse(req.body);
  await checkText(b.name); await checkText(b.description);
  const sets: string[] = []; const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return res.json({ ok: true });
  await pool.query(`UPDATE businesses SET ${sets.join(', ')} WHERE id = $1`, vals);
  res.json({ ok: true });
}));

business.get('/businesses/:id/members', requireAuth, wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  if (!(await businessRole(id, req.user!.id))) throw forbidden();
  const { rows } = await pool.query(`SELECT u.id, u.username, p.display_name, m.role FROM business_members m JOIN users u ON u.id=m.user_id JOIN user_profiles p ON p.user_id=u.id WHERE m.business_id=$1 ORDER BY m.created_at`, [id]);
  res.json({ items: rows });
}));

business.put('/businesses/:id/members/:username', requireAuth, wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
  if (!(await can(id, req.user!.id, 'manage_team'))) throw forbidden();
  if (role === 'owner') throw forbidden('Ownership cannot be assigned here');
  const u = await pool.query(`SELECT id FROM users WHERE username=$1 AND status='active'`, [req.params.username]);
  if (!u.rows[0]) throw notFound('User');
  const existing = await businessRole(id, u.rows[0].id);
  if (existing === 'owner') throw forbidden('The owner role cannot be changed');
  await pool.query(`INSERT INTO business_members(business_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (business_id,user_id) DO UPDATE SET role = EXCLUDED.role`, [id, u.rows[0].id, role]);
  res.status(204).end();
}));

business.delete('/businesses/:id/members/:username', requireAuth, wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  if (!(await can(id, req.user!.id, 'manage_team'))) throw forbidden();
  const u = await pool.query(`SELECT id FROM users WHERE username=$1`, [req.params.username]);
  if (!u.rows[0]) throw notFound('User');
  if ((await businessRole(id, u.rows[0].id)) === 'owner') throw forbidden('The owner cannot be removed');
  await pool.query(`DELETE FROM business_members WHERE business_id=$1 AND user_id=$2`, [id, u.rows[0].id]);
  res.status(204).end();
}));

business.get('/me/businesses', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT b.id, b.name, b.slug, m.role FROM business_members m JOIN businesses b ON b.id=m.business_id WHERE m.user_id=$1 AND b.status='active'`, [req.user!.id]);
  res.json({ items: rows });
}));
