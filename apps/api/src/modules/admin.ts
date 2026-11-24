import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import type { PoolClient } from 'pg';
import { HttpError, badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';
import { requirePermission, verifyPassword } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

export const admin = Router();
const uuid = z.string().uuid();
const ip = (req: { ip?: string }) => req.ip ?? null;

// ---- dashboard ---------------------------------------------------------------------------------
admin.get('/admin/stats', requirePermission('view.analytics'), wrap(async (_req, res) => {
  const one = async (sql: string) => (await pool.query(sql)).rows[0].n as number;
  res.json({
    users: await one(`SELECT count(*)::int n FROM users WHERE status<>'deleted'`),
    new_users_7d: await one(`SELECT count(*)::int n FROM users WHERE created_at > now() - interval '7 days'`),
    active_listings: await one(`SELECT count(*)::int n FROM listings WHERE status='active'`),
    pending_listings: await one(`SELECT count(*)::int n FROM listings WHERE status='pending_review'`),
    posts_7d: await one(`SELECT count(*)::int n FROM posts WHERE created_at > now() - interval '7 days' AND status='active'`),
    messages_7d: await one(`SELECT count(*)::int n FROM messages WHERE created_at > now() - interval '7 days'`),
    open_reports: await one(`SELECT count(*)::int n FROM reports WHERE status='open'`),
    suspended_users: await one(`SELECT count(*)::int n FROM users WHERE status IN ('suspended','banned')`),
    open_appeals: await one(`SELECT count(*)::int n FROM appeals WHERE status='open'`),
  });
}));

// ---- moderation: one code path removes/restores content on every surface --------------------------------
const TABLES: Record<string, string> = { post: 'posts', comment: 'comments', listing: 'listings', message: 'messages', business: 'businesses', review: 'reviews', transport_request: 'transport_requests', journey: 'journeys', transport_service: 'transport_services', group: 'groups', story: 'stories', event: 'events' };
const RESTORED: Record<string, string> = { transport_request: 'open', journey: 'open', event: 'scheduled' };

export async function setRemoved(c: PoolClient, actor: string, type: string, id: string, removed: boolean, reason: string, reportId: string | null, addr: string | null) {
  const t = TABLES[type];
  if (!t) throw badRequest('Unsupported content type');
  const cur = await c.query(`SELECT status FROM ${t} WHERE id=$1 FOR UPDATE`, [id]);
  if (!cur.rows[0]) throw notFound('Content');
  const next = removed ? 'removed' : (RESTORED[type] ?? 'active');
  await c.query(`UPDATE ${t} SET status=$2 WHERE id=$1`, [id, next]);
  if (['post', 'listing', 'transport_request', 'journey', 'transport_service'].includes(type)) await c.query(`UPDATE feed_items SET status=$3 WHERE item_type=$1 AND item_id=$2`, [type, id, ['removed'].includes(next) ? 'removed' : 'active']);
  await c.query(`INSERT INTO moderation_actions(moderator_id,target_type,target_id,action,reason,report_id) VALUES ($1,$2,$3,$4,$5,$6)`, [actor, type, id, removed ? 'remove' : 'restore', reason, reportId]);
  await audit(c, actor, removed ? 'content.remove' : 'content.restore', type, id, { status: cur.rows[0].status }, { status: next, reason }, addr);
}

const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

admin.post('/admin/content/:type/:id/remove', requirePermission('moderate.content'), wrap(async (req, res) => {
  const { reason } = reasonSchema.parse(req.body);
  await tx((c) => setRemoved(c, req.user!.id, String(req.params.type), uuid.parse(req.params.id), true, reason, null, ip(req)));
  res.status(204).end();
}));
admin.post('/admin/content/:type/:id/restore', requirePermission('moderate.content'), wrap(async (req, res) => {
  const { reason } = reasonSchema.parse(req.body);
  await tx((c) => setRemoved(c, req.user!.id, String(req.params.type), uuid.parse(req.params.id), false, reason, null, ip(req)));
  res.status(204).end();
}));

admin.get('/admin/reports', requirePermission('moderate.content'), wrap(async (req, res) => {
  const status = z.enum(['open', 'actioned', 'dismissed']).default('open').parse(req.query.status ?? 'open');
  const { rows } = await pool.query(
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.created_at, u.username AS reporter,
            count(*) OVER (PARTITION BY r.target_type, r.target_id)::int AS report_count
     FROM reports r JOIN users u ON u.id=r.reporter_id WHERE r.status=$1 ORDER BY r.created_at DESC LIMIT 100`, [status]);
  res.json({ items: rows });
}));

admin.post('/admin/reports/:id/resolve', requirePermission('moderate.content'), wrap(async (req, res) => {
  const b = z.object({ action: z.enum(['remove', 'dismiss', 'suspend_user']), reason: z.string().trim().min(3).max(500), days: z.number().int().min(1).max(3650).optional() }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows } = await c.query('SELECT * FROM reports WHERE id=$1 FOR UPDATE', [id]);
    const r = rows[0];
    if (!r) throw notFound('Report');
    if (r.status !== 'open') throw conflict('This report was already handled');
    if (b.action === 'remove') {
      if (r.target_type === 'user') throw badRequest('Use suspend_user for accounts');
      await setRemoved(c, req.user!.id, r.target_type, r.target_id, true, b.reason, id, ip(req));
    } else if (b.action === 'suspend_user') {
      if (!req.user!.permissions.includes('manage.users')) throw forbidden();
      const uid = await ownerOf(c, r.target_type, r.target_id);
      await restrictUser(c, req.user!.id, uid, 'suspend', b.reason, b.days ?? 7, ip(req));
    } else {
      await c.query(`INSERT INTO moderation_actions(moderator_id,target_type,target_id,action,reason,report_id) VALUES ($1,$2,$3,'dismiss_report',$4,$5)`, [req.user!.id, r.target_type, r.target_id, b.reason, id]);
    }
    // close every open report on the same target
    await c.query(`UPDATE reports SET status=$3, resolved_by=$4, resolved_at=now() WHERE target_type=$1 AND target_id=$2 AND status='open'`,
      [r.target_type, r.target_id, b.action === 'dismiss' ? 'dismissed' : 'actioned', req.user!.id]);
    await audit(c, req.user!.id, 'report.resolve', 'report', id, { status: 'open' }, { action: b.action, reason: b.reason }, ip(req));
  });
  res.status(204).end();
}));

async function ownerOf(c: PoolClient, type: string, id: string): Promise<string> {
  const q: Record<string, string> = { user: 'SELECT id AS u FROM users WHERE id=$1', post: 'SELECT author_id AS u FROM posts WHERE id=$1', comment: 'SELECT author_id AS u FROM comments WHERE id=$1',
    listing: 'SELECT seller_id AS u FROM listings WHERE id=$1', transport_request: 'SELECT requester_id AS u FROM transport_requests WHERE id=$1', journey: 'SELECT driver_id AS u FROM journeys WHERE id=$1', transport_service: 'SELECT provider_id AS u FROM transport_services WHERE id=$1', group: `SELECT user_id AS u FROM group_members WHERE group_id=$1 AND role='owner'`, story: 'SELECT author_id AS u FROM stories WHERE id=$1', event: 'SELECT host_id AS u FROM events WHERE id=$1', business: 'SELECT owner_id AS u FROM businesses WHERE id=$1', message: 'SELECT sender_id AS u FROM messages WHERE id=$1' };
  const r = await c.query(q[type], [id]);
  if (!r.rows[0]) throw notFound('Target');
  return r.rows[0].u;
}

// ---- listings review queue ---------------------------------------------------------------------------------------
admin.get('/admin/listings/pending', requirePermission('moderate.content'), wrap(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.title, l.description, l.price_cents, l.created_at, c.name AS category, c.is_restricted, u.username FROM listings l
     JOIN categories c ON c.id=l.category_id JOIN users u ON u.id=l.seller_id WHERE l.status='pending_review' ORDER BY l.created_at LIMIT 100`);
  res.json({ items: rows });
}));
admin.post('/admin/listings/:id/review', requirePermission('moderate.content'), wrap(async (req, res) => {
  const b = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(3).max(500) }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const cur = await c.query(`SELECT status FROM listings WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur.rows[0]) throw notFound('Listing');
    if (cur.rows[0].status !== 'pending_review') throw conflict('This listing is not waiting for review');
    const next = b.decision === 'approve' ? 'active' : 'removed';
    await c.query(`UPDATE listings SET status=$2 WHERE id=$1`, [id, next]);
    await c.query(`UPDATE feed_items SET status=$2 WHERE item_type='listing' AND item_id=$1`, [id, next]);
    await c.query(`INSERT INTO moderation_actions(moderator_id,target_type,target_id,action,reason) VALUES ($1,'listing',$2,$3,$4)`, [req.user!.id, id, b.decision === 'approve' ? 'restore' : 'remove', b.reason]);
    await audit(c, req.user!.id, `listing.${b.decision}`, 'listing', id, { status: 'pending_review' }, { status: next, reason: b.reason }, ip(req));
  });
  res.status(204).end();
}));

// ---- users -----------------------------------------------------------------------------------------------------------------
admin.get('/admin/users', requirePermission('manage.users'), wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.status, u.suspended_until, u.created_at, p.display_name,
            coalesce((SELECT array_agg(role_key) FROM user_roles WHERE user_id=u.id), '{}') AS roles
     FROM users u JOIN user_profiles p ON p.user_id=u.id
     WHERE $1 = '' OR u.username::text ILIKE '%'||$1||'%' OR u.email::text ILIKE '%'||$1||'%' OR p.display_name ILIKE '%'||$1||'%'
     ORDER BY u.created_at DESC LIMIT 50`, [q]);
  res.json({ items: rows });
}));

async function restrictUser(c: PoolClient, actor: string, userId: string, action: 'suspend' | 'ban' | 'unban', reason: string, days: number | null, addr: string | null) {
  if (userId === actor) throw badRequest('You cannot restrict your own account');
  const target = await c.query(`SELECT status, (SELECT count(*) FROM user_roles WHERE user_id=$1 AND role_key IN ('admin','super_admin'))::int AS is_admin FROM users WHERE id=$1 FOR UPDATE`, [userId]);
  if (!target.rows[0]) throw notFound('User');
  if (target.rows[0].is_admin) throw forbidden('Administrators cannot be restricted here');
  const status = action === 'unban' ? 'active' : action === 'ban' ? 'banned' : 'suspended';
  await c.query(`UPDATE users SET status=$2, suspended_until = CASE WHEN $2='suspended' THEN now() + ($3 || ' days')::interval ELSE NULL END WHERE id=$1`, [userId, status, String(days ?? 7)]);
  if (action !== 'unban') await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
  await c.query(`INSERT INTO moderation_actions(moderator_id,target_type,target_id,action,reason) VALUES ($1,'user',$2,$3,$4)`, [actor, userId, action, reason]);
  await audit(c, actor, `user.${action}`, 'user', userId, { status: target.rows[0].status }, { status, reason, days }, addr);
}

for (const action of ['suspend', 'ban', 'unban'] as const) {
  admin.post(`/admin/users/:id/${action}`, requirePermission('manage.users'), wrap(async (req, res) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500), days: z.number().int().min(1).max(3650).optional() }).parse(req.body);
    await tx((c) => restrictUser(c, req.user!.id, uuid.parse(req.params.id), action, b.reason, b.days ?? null, ip(req)));
    res.status(204).end();
  }));
}

admin.put('/admin/users/:id/roles', requirePermission('manage.admins'), wrap(async (req, res) => {
  const { roles } = z.object({ roles: z.array(z.enum(['moderator', 'admin', 'super_admin'])) }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const before = (await c.query('SELECT role_key FROM user_roles WHERE user_id=$1', [id])).rows.map((r) => r.role_key);
    await c.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
    for (const r of roles) await c.query('INSERT INTO user_roles(user_id, role_key) VALUES ($1,$2)', [id, r]);
    await audit(c, req.user!.id, 'user.roles', 'user', id, { roles: before }, { roles }, ip(req));
  });
  res.status(204).end();
}));

// ---- categories ----------------------------------------------------------------------------------------------------------------
const catSchema = z.object({ name: z.string().trim().min(2).max(60), slug: z.string().toLowerCase().regex(/^[a-z0-9-]{2,50}$/), parent_id: uuid.nullable().optional(),
  icon: z.string().max(30).nullable().optional(), is_restricted: z.boolean().optional(), restriction_note: z.string().max(300).nullable().optional(), is_active: z.boolean().optional(), position: z.number().int().optional() });

admin.get('/admin/categories', requirePermission('manage.categories'), wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT c.*, (SELECT count(*) FROM listings l WHERE l.category_id=c.id)::int AS listing_count FROM categories c ORDER BY position, name`);
  res.json({ items: rows });
}));
admin.post('/admin/categories', requirePermission('manage.categories'), wrap(async (req, res) => {
  const b = catSchema.parse(req.body);
  const row = await tx(async (c) => {
    const r = await c.query(`INSERT INTO categories(name,slug,parent_id,icon,is_restricted,restriction_note,position) VALUES ($1,$2,$3,$4,$5,$6,coalesce($7,(SELECT coalesce(max(position),0)+1 FROM categories))) RETURNING *`,
      [b.name, b.slug, b.parent_id ?? null, b.icon ?? null, b.is_restricted ?? false, b.restriction_note ?? null, b.position ?? null]);
    await audit(c, req.user!.id, 'category.create', 'category', r.rows[0].id, null, r.rows[0], ip(req));
    return r.rows[0];
  });
  res.status(201).json(row);
}));
admin.patch('/admin/categories/:id', requirePermission('manage.categories'), wrap(async (req, res) => {
  const b = catSchema.partial().parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const before = (await c.query('SELECT * FROM categories WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Category');
    if (b.parent_id === id) throw badRequest('A category cannot be its own parent');
    const sets: string[] = []; const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return;
    const after = (await c.query(`UPDATE categories SET ${sets.join(',')} WHERE id=$1 RETURNING *`, vals)).rows[0];
    await audit(c, req.user!.id, 'category.update', 'category', id, before, after, ip(req));
  });
  res.status(204).end();
}));
admin.put('/admin/categories-order', requirePermission('manage.categories'), wrap(async (req, res) => {
  const { order } = z.object({ order: z.array(uuid).min(1).max(500) }).parse(req.body);
  await tx(async (c) => {
    for (const [i, id] of order.entries()) await c.query('UPDATE categories SET position=$2 WHERE id=$1', [id, i]);
    await audit(c, req.user!.id, 'category.reorder', 'category', null, null, { order }, ip(req));
  });
  res.status(204).end();
}));

// ---- platform settings, banned words, fee rules ------------------------------------------------------------------------------
admin.get('/admin/settings', requirePermission('manage.settings'), wrap(async (_req, res) => { res.json({ items: (await pool.query('SELECT key,value,description,updated_at FROM platform_settings ORDER BY key')).rows }); }));
admin.put('/admin/settings/:key', requirePermission('manage.settings'), wrap(async (req, res) => {
  const { value } = z.object({ value: z.unknown() }).parse(req.body);
  if (value === undefined) throw badRequest('Value is required');
  await tx(async (c) => {
    const before = await c.query('SELECT value FROM platform_settings WHERE key=$1 FOR UPDATE', [req.params.key]);
    if (!before.rows[0]) throw notFound('Setting');
    await c.query('UPDATE platform_settings SET value=$2, updated_by=$3, updated_at=now() WHERE key=$1', [req.params.key, JSON.stringify(value), req.user!.id]);
    await audit(c, req.user!.id, 'setting.update', 'setting', String(req.params.key), before.rows[0].value, value, ip(req));
  });
  res.status(204).end();
}));

admin.get('/admin/banned-words', requirePermission('manage.settings'), wrap(async (_req, res) => { res.json({ items: (await pool.query('SELECT id, term, severity FROM banned_words ORDER BY term')).rows }); }));
admin.post('/admin/banned-words', requirePermission('manage.settings'), wrap(async (req, res) => {
  const b = z.object({ term: z.string().trim().min(2).max(60), severity: z.enum(['block', 'flag']).default('block') }).parse(req.body);
  const row = await tx(async (c) => {
    const r = await c.query('INSERT INTO banned_words(term,severity) VALUES ($1,$2) RETURNING id, term, severity', [b.term, b.severity]);
    await audit(c, req.user!.id, 'banned_word.add', 'banned_word', r.rows[0].id, null, r.rows[0], ip(req));
    return r.rows[0];
  });
  res.status(201).json(row);
}));
admin.delete('/admin/banned-words/:id', requirePermission('manage.settings'), wrap(async (req, res) => {
  await tx(async (c) => {
    const r = await c.query('DELETE FROM banned_words WHERE id=$1 RETURNING term', [uuid.parse(req.params.id)]);
    if (!r.rowCount) throw notFound('Word');
    await audit(c, req.user!.id, 'banned_word.remove', 'banned_word', String(req.params.id), r.rows[0], null, ip(req));
  });
  res.status(204).end();
}));

admin.get('/admin/fee-rules', requirePermission('manage.fees'), wrap(async (_req, res) => { res.json({ items: (await pool.query('SELECT * FROM fee_rules ORDER BY scope, effective_from DESC')).rows }); }));
admin.put('/admin/fee-rules/:id', requirePermission('manage.fees'), wrap(async (req, res) => {
  const b = z.object({ percent_bps: z.number().int().min(0).max(10000), fixed_cents: z.number().int().min(0), min_cents: z.number().int().min(0).nullable().optional(), max_cents: z.number().int().min(0).nullable().optional(), active: z.boolean().default(true) }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const before = (await c.query('SELECT * FROM fee_rules WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Fee rule');
    const after = (await c.query('UPDATE fee_rules SET percent_bps=$2, fixed_cents=$3, min_cents=$4, max_cents=$5, active=$6, created_by=$7 WHERE id=$1 RETURNING *', [id, b.percent_bps, b.fixed_cents, b.min_cents ?? null, b.max_cents ?? null, b.active, req.user!.id])).rows[0];
    await audit(c, req.user!.id, 'fee_rule.update', 'fee_rule', id, before, after, ip(req));
  });
  res.status(204).end();
}));

// ---- audit log + appeals ----------------------------------------------------------------------------------------------------------------
admin.get('/admin/audit', requirePermission('view.audit'), wrap(async (req, res) => {
  const a = z.object({ action: z.string().optional(), actor: uuid.optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.before, a.after, a.created_at, u.username AS actor
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
     WHERE ($1::text IS NULL OR a.action LIKE $1||'%') AND ($2::uuid IS NULL OR a.actor_id=$2) AND ($3::bigint IS NULL OR a.id < $3)
     ORDER BY a.id DESC LIMIT $4`, [a.action ?? null, a.actor ?? null, a.before ?? null, a.limit]);
  res.json({ items: rows, next_before: rows.length === a.limit ? rows[rows.length - 1].id : null });
}));

// Suspended users cannot hold a token, so they appeal by re-proving their credentials.
admin.post('/appeals', wrap(async (req, res) => {
  const b = z.object({ identifier: z.string().min(3), password: z.string().min(1), message: z.string().trim().min(10).max(2000) }).parse(req.body);
  const { rows } = await pool.query('SELECT id, password_hash, status FROM users WHERE email=$1 OR username=$1', [b.identifier]);
  if (!rows[0] || !(await verifyPassword(b.password, rows[0].password_hash))) throw new HttpError(401, 'Incorrect email/username or password', 'invalid_credentials');
  if (!['suspended', 'banned'].includes(rows[0].status)) throw badRequest('Your account is not restricted');
  const last = await pool.query(`SELECT id FROM moderation_actions WHERE target_type='user' AND target_id=$1 ORDER BY created_at DESC LIMIT 1`, [rows[0].id]);
  const open = await pool.query(`SELECT 1 FROM appeals WHERE user_id=$1 AND status='open'`, [rows[0].id]);
  if (open.rowCount) throw conflict('You already have an appeal under review');
  await pool.query('INSERT INTO appeals(user_id, moderation_action_id, message) VALUES ($1,$2,$3)', [rows[0].id, last.rows[0]?.id ?? null, b.message]);
  res.status(201).json({ ok: true });
}));
admin.get('/admin/appeals', requirePermission('manage.users'), wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT a.id, a.message, a.status, a.created_at, u.username, u.status AS user_status FROM appeals a JOIN users u ON u.id=a.user_id WHERE a.status='open' ORDER BY a.created_at`);
  res.json({ items: rows });
}));
admin.post('/admin/appeals/:id/decide', requirePermission('manage.users'), wrap(async (req, res) => {
  const b = z.object({ decision: z.enum(['uphold', 'overturn']), reason: z.string().trim().min(3).max(500) }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const a = (await c.query(`SELECT user_id, status FROM appeals WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!a) throw notFound('Appeal');
    if (a.status !== 'open') throw conflict('Already decided');
    await c.query(`UPDATE appeals SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [id, b.decision === 'uphold' ? 'upheld' : 'overturned', req.user!.id]);
    if (b.decision === 'overturn') await restrictUser(c, req.user!.id, a.user_id, 'unban', b.reason, null, ip(req));
    await audit(c, req.user!.id, `appeal.${b.decision}`, 'appeal', id, null, { reason: b.reason }, ip(req));
  });
  res.status(204).end();
}));
