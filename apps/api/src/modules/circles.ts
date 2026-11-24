import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { HttpError, badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';
import { checkText, setting } from '../lib/policy.js';
import { requirePlace } from '../lib/geo.js';
import { hydratePosts } from '../lib/hydrate.js';
import { notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { mediaUrl } from '../lib/views.js';
import { assertOwnsMedia } from './content.js';
import { RANK, atLeast, isActive, membership } from '../lib/groups.js';
import { patchOf } from '../lib/validation.js';

export const circles = Router();
const uuid = z.string().uuid();
export { RANK };

/** Private circles do not exist for outsiders: no listing, no page, no hint. Invited people may see them to accept. */
export async function loadGroup(slug: string, viewer: string | null, db: Db = pool) {
  const g = (await db.query(`SELECT * FROM groups WHERE slug=$1 AND status='active'`, [slug])).rows[0];
  if (!g) throw notFound('Circle');
  const m = await membership(db, g.id, viewer);
  if (g.visibility === 'private' && !(m && ['active', 'invited', 'pending'].includes(m.status)) && !viewer) throw notFound('Circle');
  if (g.visibility === 'private' && !m) throw notFound('Circle');
  if (m?.status === 'banned') throw notFound('Circle');
  return { g, m };
}

const groupView = async (g: any, m: { role: string; status: string } | null) => {
  const cover = g.cover_media_id ? (await pool.query('SELECT storage_key FROM media_assets WHERE id=$1', [g.cover_media_id])).rows[0] : null;
  const pending = atLeast(m, 'moderator') ? (await pool.query(`SELECT count(*)::int n FROM group_members WHERE group_id=$1 AND status='pending'`, [g.id])).rows[0].n : undefined;
  return {
    id: g.id, slug: g.slug, name: g.name, description: g.description, category: g.category, location: g.city ? { city: g.city, province: g.province } : null,
    cover_url: cover ? mediaUrl(cover.storage_key) : null, visibility: g.visibility, join_policy: g.join_policy, who_can_post: g.who_can_post, allow_commerce: g.allow_commerce,
    rules: g.rules, member_count: g.member_count, created_at: g.created_at, viewer: m ? { role: m.role, status: m.status } : null, pending_requests: pending,
  };
};

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44);

// ---------------------------------------------------------------------------------------------- create / discover
const body = z.object({
  name: z.string().trim().min(3).max(80), slug: z.string().toLowerCase().regex(/^[a-z0-9-]{3,50}$/).optional(), description: z.string().max(2000).default(''), category: z.string().trim().max(40).optional(),
  city: z.string().optional(), province: z.string().length(2).optional(), visibility: z.enum(['public', 'private']).default('public'), join_policy: z.enum(['open', 'approval']).default('open'),
  who_can_post: z.enum(['members', 'moderators']).default('members'), allow_commerce: z.boolean().default(true), rules: z.string().max(3000).default(''), cover_media_id: uuid.nullable().optional(),
});

circles.post('/circles', requireAuth, wrap(async (req, res) => {
  const b = body.parse(req.body); const me = req.user!.id;
  await checkText(b.name); await checkText(b.description); await checkText(b.rules);
  const maxOwned = Number(await setting('circle.max_owned_per_user', 10));
  const slug = await tx(async (c) => {
    if ((await c.query(`SELECT count(*)::int n FROM groups WHERE created_by=$1 AND status<>'removed'`, [me])).rows[0].n >= maxOwned) throw new HttpError(409, `You can own up to ${maxOwned} circles`, 'limit');
    if (b.cover_media_id) await assertOwnsMedia(c, me, [b.cover_media_id]);
    const place = b.city ? await requirePlace(b.city, b.province, c) : null;
    let slug = b.slug ?? slugify(b.name); if (slug.length < 3) slug = `circle-${Math.random().toString(36).slice(2, 8)}`;
    if (!b.slug) for (let i = 2; (await c.query('SELECT 1 FROM groups WHERE slug=$1', [slug])).rowCount; i++) slug = `${slugify(b.name).slice(0, 40)}-${i}`;
    const g = await c.query(
      `INSERT INTO groups(slug,name,description,category,city,province,location,cover_media_id,visibility,join_policy,who_can_post,allow_commerce,rules,member_count,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($7,$8),4326)::geography END,$9,$10,$11,$12,$13,$14,1,$15) RETURNING id, slug`,
      [slug, b.name, b.description, b.category ?? null, place?.city ?? null, place?.province ?? null, place?.lng ?? null, place?.lat ?? null, b.cover_media_id ?? null, b.visibility,
        b.visibility === 'private' ? 'approval' : b.join_policy, b.who_can_post, b.allow_commerce, b.rules, me])
      .catch((e) => { if (e.code === '23505') throw conflict('That circle URL is taken'); throw e; });
    await c.query(`INSERT INTO group_members(group_id,user_id,role,status) VALUES ($1,$2,'owner','active')`, [g.rows[0].id, me]);
    return g.rows[0].slug as string;
  });
  const { g, m } = await loadGroup(slug, me);
  res.status(201).json(await groupView(g, m));
}));

circles.get('/circles', optionalAuth, wrap(async (req, res) => {
  const q = z.object({ q: z.string().max(80).optional(), category: z.string().max(40).optional(), city: z.string().optional(), radius_km: z.coerce.number().min(1).max(5000).default(100), mine: z.enum(['1', 'true']).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().optional() }).parse(req.query);
  const viewer = req.user?.id ?? null; const p: unknown[] = []; const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const where = [`g.status='active'`];
  if (q.mine) { if (!viewer) throw new HttpError(401, 'Sign in required', 'unauthorized'); where.push(`EXISTS (SELECT 1 FROM group_members m WHERE m.group_id=g.id AND m.user_id=${add(viewer)}::uuid AND m.status IN ('active','invited','pending'))`); }
  else where.push(`g.visibility='public'`);
  if (q.q) { const t = add(q.q); where.push(`(g.search_vector @@ websearch_to_tsquery('english', ${t}) OR g.name ILIKE '%'||${t}||'%')`); }
  if (q.category) where.push(`g.category ILIKE ${add(q.category)}`);
  if (q.city) { const pl = await requirePlace(q.city); where.push(`g.location IS NOT NULL AND ST_DWithin(g.location, ST_SetSRID(ST_MakePoint(${add(pl.lng)}::float8,${add(pl.lat)}::float8),4326)::geography, ${add(q.radius_km * 1000)})`); }
  const offset = q.cursor ? Math.max(0, parseInt(Buffer.from(q.cursor, 'base64url').toString(), 10) || 0) : 0;
  const { rows } = await pool.query(`SELECT g.* FROM groups g WHERE ${where.join(' AND ')} ORDER BY g.member_count DESC, g.created_at DESC LIMIT ${q.limit + 1} OFFSET ${offset}`, p);
  const items = await Promise.all(rows.slice(0, q.limit).map(async (g) => groupView(g, await membership(pool, g.id, viewer))));
  res.json({ items, next_cursor: rows.length > q.limit ? Buffer.from(String(offset + q.limit)).toString('base64url') : null });
}));

circles.get('/circles/:slug', optionalAuth, wrap(async (req, res) => {
  const { g, m } = await loadGroup(String(req.params.slug), req.user?.id ?? null);
  res.json(await groupView(g, m));
}));

circles.patch('/circles/:slug', requireAuth, wrap(async (req, res) => {
  const b = patchOf(body.pick({ name: true, description: true, category: true, join_policy: true, who_can_post: true, allow_commerce: true, rules: true, visibility: true, cover_media_id: true })).parse(req.body);
  const { g, m } = await loadGroup(String(req.params.slug), req.user!.id);
  if (!atLeast(m, 'admin')) throw forbidden('Only admins can change circle settings');
  if (b.visibility && b.visibility !== g.visibility && m!.role !== 'owner') throw forbidden('Only the owner can change who can see the circle');
  await checkText(b.name); await checkText(b.description); await checkText(b.rules);
  await tx(async (c) => {
    if (b.cover_media_id) await assertOwnsMedia(c, req.user!.id, [b.cover_media_id]);
    const sets: string[] = []; const vals: unknown[] = [g.id]; for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k}=$${vals.length}`); }
    const nextVis = b.visibility ?? g.visibility; if (nextVis === 'private') sets.push(`join_policy='approval'`);
    if (sets.length) await c.query(`UPDATE groups SET ${sets.join(',')} WHERE id=$1`, vals);
    if (b.visibility) await c.query(`UPDATE posts SET visibility=$2 WHERE group_id=$1 AND visibility IN ('public','group')`, [g.id, b.visibility === 'private' ? 'group' : 'public']),
      await c.query(`UPDATE feed_items SET visibility=$2 WHERE group_id=$1 AND visibility IN ('public','group')`, [g.id, b.visibility === 'private' ? 'group' : 'public']);
    await audit(c, req.user!.id, 'circle.update', 'group', g.id, null, b, req.ip ?? null);
  });
  const fresh = await loadGroup(g.slug, req.user!.id); res.json(await groupView(fresh.g, fresh.m));
}));

circles.delete('/circles/:slug', requireAuth, wrap(async (req, res) => {
  const { g, m } = await loadGroup(String(req.params.slug), req.user!.id);
  if (!isActive(m) || m!.role !== 'owner') throw forbidden('Only the owner can delete a circle');
  await pool.query(`UPDATE groups SET status='removed' WHERE id=$1`, [g.id]);
  res.status(204).end();
}));

// ---------------------------------------------------------------------------------------------- membership
async function bump(c: Db, groupId: string, d: number) { await c.query('UPDATE groups SET member_count = greatest(member_count + $2, 0) WHERE id=$1', [groupId, d]); }
async function notifyStaff(c: Db, g: any, type: string, actor: string, data: Record<string, unknown> = {}) {
  const staff = (await c.query(`SELECT user_id FROM group_members WHERE group_id=$1 AND status='active' AND role IN ('owner','admin','moderator')`, [g.id])).rows;
  for (const s of staff) await notify(c, { userId: s.user_id, type, actorId: actor, targetType: 'group', targetId: g.id, data: { name: g.name, slug: g.slug, ...data } });
}

circles.post('/circles/:slug/join', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; let outcome = 'active';
  await tx(async (c) => {
    const g = (await c.query(`SELECT * FROM groups WHERE slug=$1 AND status='active' FOR NO KEY UPDATE`, [String(req.params.slug)])).rows[0];
    if (!g) throw notFound('Circle');
    const cur = await membership(c, g.id, me);
    if (cur?.status === 'banned') throw notFound('Circle');
    if (cur?.status === 'active') { outcome = 'active'; return; }
    if (cur?.status === 'pending') { outcome = 'pending'; return; }
    if (g.visibility === 'private' && cur?.status !== 'invited') throw notFound('Circle');
    if (cur?.status === 'invited' || g.join_policy === 'open') {
      await c.query(`INSERT INTO group_members(group_id,user_id,role,status) VALUES ($1,$2,'member','active') ON CONFLICT (group_id,user_id) DO UPDATE SET status='active'`, [g.id, me]);
      await bump(c, g.id, 1); outcome = 'active';
    } else {
      await c.query(`INSERT INTO group_members(group_id,user_id,role,status) VALUES ($1,$2,'member','pending')`, [g.id, me]);
      await notifyStaff(c, g, 'group_activity', me, { event: 'join_request' }); outcome = 'pending';
    }
  });
  res.json({ status: outcome });
}));

circles.post('/circles/:slug/leave', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  await tx(async (c) => {
    const g = (await c.query(`SELECT id FROM groups WHERE slug=$1 FOR NO KEY UPDATE`, [String(req.params.slug)])).rows[0]; if (!g) throw notFound('Circle');
    const m = await membership(c, g.id, me); if (!m || m.status === 'banned') throw notFound('Circle');
    if (m.role === 'owner') throw conflict('Transfer ownership or delete the circle before leaving');
    await c.query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [g.id, me]);
    if (m.status === 'active') await bump(c, g.id, -1);
  });
  res.status(204).end();
}));

circles.get('/circles/:slug/members', optionalAuth, wrap(async (req, res) => {
  const { g, m } = await loadGroup(String(req.params.slug), req.user?.id ?? null);
  const status = z.enum(['active', 'pending', 'invited', 'banned']).default('active').parse(req.query.status ?? 'active');
  if (status !== 'active' && !atLeast(m, 'moderator')) throw forbidden();
  if (g.visibility === 'private' && !isActive(m)) throw forbidden('Members only');
  const { rows } = await pool.query(
    `SELECT u.id, u.username, p.display_name, gm.role, gm.status, gm.created_at FROM group_members gm JOIN users u ON u.id=gm.user_id JOIN user_profiles p ON p.user_id=u.id
     WHERE gm.group_id=$1 AND gm.status=$2 AND u.status='active' ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, gm.created_at LIMIT 200`, [g.id, status]);
  res.json({ items: rows });
}));

async function userByName(db: Db, username: string) {
  const u = (await db.query(`SELECT id FROM users WHERE username=$1 AND status='active'`, [username])).rows[0]; if (!u) throw notFound('User'); return u.id as string;
}

circles.post('/circles/:slug/invites', requireAuth, wrap(async (req, res) => {
  const { username } = z.object({ username: z.string().min(3).max(30) }).parse(req.body); const me = req.user!.id;
  const { g, m } = await loadGroup(String(req.params.slug), me);
  if (!atLeast(m, 'moderator')) throw forbidden('Only moderators and admins can invite');
  await tx(async (c) => {
    const uid = await userByName(c, username);
    if ((await c.query(`SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`, [me, uid])).rowCount) throw notFound('User');
    const cur = await membership(c, g.id, uid);
    if (cur?.status === 'active') throw conflict('They are already a member');
    if (cur?.status === 'banned') throw conflict('This person is banned from the circle');
    if (cur?.status === 'pending') { await c.query(`UPDATE group_members SET status='active' WHERE group_id=$1 AND user_id=$2`, [g.id, uid]); await bump(c, g.id, 1); }
    else await c.query(`INSERT INTO group_members(group_id,user_id,role,status,invited_by) VALUES ($1,$2,'member','invited',$3) ON CONFLICT (group_id,user_id) DO NOTHING`, [g.id, uid, me]);
    await notify(c, { userId: uid, type: 'group_invite', actorId: me, targetType: 'group', targetId: g.id, data: { name: g.name, slug: g.slug } });
  });
  res.status(201).json({ ok: true });
}));

for (const decision of ['approve', 'reject'] as const) {
  circles.post(`/circles/:slug/requests/:username/${decision}`, requireAuth, wrap(async (req, res) => {
    const me = req.user!.id; const { g, m } = await loadGroup(String(req.params.slug), me);
    if (!atLeast(m, 'moderator')) throw forbidden();
    await tx(async (c) => {
      const uid = await userByName(c, String(req.params.username));
      const r = await c.query(decision === 'approve' ? `UPDATE group_members SET status='active' WHERE group_id=$1 AND user_id=$2 AND status='pending' RETURNING 1` : `DELETE FROM group_members WHERE group_id=$1 AND user_id=$2 AND status='pending' RETURNING 1`, [g.id, uid]);
      if (!r.rowCount) throw notFound('Request');
      if (decision === 'approve') { await bump(c, g.id, 1); await notify(c, { userId: uid, type: 'group_activity', actorId: me, targetType: 'group', targetId: g.id, data: { event: 'approved', name: g.name, slug: g.slug } }); }
    });
    res.status(204).end();
  }));
}

circles.put('/circles/:slug/members/:username/role', requireAuth, wrap(async (req, res) => {
  const { role } = z.object({ role: z.enum(['admin', 'moderator', 'member']) }).parse(req.body); const me = req.user!.id;
  const { g, m } = await loadGroup(String(req.params.slug), me);
  if (!atLeast(m, 'admin')) throw forbidden('Only admins can change roles');
  if (role === 'admin' && m!.role !== 'owner') throw forbidden('Only the owner can appoint admins');
  await tx(async (c) => {
    const uid = await userByName(c, String(req.params.username)); const t = await membership(c, g.id, uid);
    if (!isActive(t)) throw notFound('Member');
    if (t!.role === 'owner') throw forbidden('The owner role cannot be changed here');
    if (RANK[t!.role] >= RANK[m!.role] && m!.role !== 'owner') throw forbidden('You cannot change someone at or above your own role');
    await c.query('UPDATE group_members SET role=$3 WHERE group_id=$1 AND user_id=$2', [g.id, uid, role]);
    await audit(c, me, 'circle.role', 'group', g.id, { user: uid, role: t!.role }, { role }, req.ip ?? null);
    await notify(c, { userId: uid, type: 'group_activity', actorId: me, targetType: 'group', targetId: g.id, data: { event: 'role', role, name: g.name, slug: g.slug } });
  });
  res.status(204).end();
}));

circles.post('/circles/:slug/transfer', requireAuth, wrap(async (req, res) => {
  const { username } = z.object({ username: z.string() }).parse(req.body); const me = req.user!.id;
  await tx(async (c) => {
    const g = (await c.query(`SELECT * FROM groups WHERE slug=$1 AND status='active' FOR NO KEY UPDATE`, [String(req.params.slug)])).rows[0]; if (!g) throw notFound('Circle');
    const m = await membership(c, g.id, me); if (!isActive(m) || m!.role !== 'owner') throw forbidden('Only the owner can transfer ownership');
    const uid = await userByName(c, username); if (uid === me) throw badRequest('You already own this circle');
    if (!isActive(await membership(c, g.id, uid))) throw badRequest('They must be an active member first');
    await c.query(`UPDATE group_members SET role='admin' WHERE group_id=$1 AND user_id=$2`, [g.id, me]);   // single-owner index: demote first
    await c.query(`UPDATE group_members SET role='owner' WHERE group_id=$1 AND user_id=$2`, [g.id, uid]);
    await audit(c, me, 'circle.transfer', 'group', g.id, { from: me }, { to: uid }, req.ip ?? null);
  });
  res.status(204).end();
}));

circles.delete('/circles/:slug/members/:username', requireAuth, wrap(async (req, res) => {
  const { ban, reason } = z.object({ ban: z.boolean().default(false), reason: z.string().trim().max(300).optional() }).parse(req.body ?? {}); const me = req.user!.id;
  const { g, m } = await loadGroup(String(req.params.slug), me);
  if (!atLeast(m, 'moderator')) throw forbidden('Only moderators and admins can remove members');
  await tx(async (c) => {
    const uid = await userByName(c, String(req.params.username)); const t = await membership(c, g.id, uid);
    if (!t) throw notFound('Member');
    if (uid === me) throw badRequest('Use leave instead');
    if (RANK[t.role] >= RANK[m!.role]) throw forbidden('You cannot remove someone at or above your own role');
    if (ban) await c.query(`UPDATE group_members SET status='banned', role='member' WHERE group_id=$1 AND user_id=$2`, [g.id, uid]);
    else await c.query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [g.id, uid]);
    if (t.status === 'active') await bump(c, g.id, -1);
    await audit(c, me, ban ? 'circle.ban' : 'circle.remove_member', 'group', g.id, { user: uid }, { reason }, req.ip ?? null);
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------------------------------------- content moderation and pins
circles.get('/circles/:slug/posts', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user?.id ?? null; const { g, m } = await loadGroup(String(req.params.slug), viewer);
  if (g.visibility === 'private' && !isActive(m)) throw forbidden('Members only');
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
  const rows = (await pool.query(`SELECT p.id, p.created_at FROM posts p WHERE p.group_id=$1 AND p.status='active' AND ($2::timestamptz IS NULL OR p.created_at < $2)
      AND (p.video_id IS NULL OR EXISTS (SELECT 1 FROM videos v WHERE v.id=p.video_id AND v.status='ready'))
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$3::uuid AND b.blocked_id=p.author_id) OR (b.blocker_id=p.author_id AND b.blocked_id=$3::uuid))
      ORDER BY p.created_at DESC LIMIT 21`, [g.id, before, viewer])).rows;
  const pinnedIds = before ? [] : (await pool.query(`SELECT p.id FROM group_pins gp JOIN posts p ON p.id=gp.post_id WHERE gp.group_id=$1 AND p.status='active' ORDER BY gp.pinned_at DESC`, [g.id])).rows.map((r) => r.id);
  const page = rows.slice(0, 20); const map = await hydratePosts([...pinnedIds, ...page.map((r) => r.id)], viewer);
  res.json({ pinned: pinnedIds.map((i) => map.get(i)), items: page.filter((r) => !pinnedIds.includes(r.id)).map((r) => map.get(r.id)), next_before: rows.length > 20 ? page[page.length - 1].created_at : null });
}));

circles.post('/circles/:slug/posts/:postId/pin', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const { g, m } = await loadGroup(String(req.params.slug), me);
  if (!atLeast(m, 'admin')) throw forbidden('Only admins can pin posts');
  await tx(async (c) => {
    const p = (await c.query(`SELECT 1 FROM posts WHERE id=$1 AND group_id=$2 AND status='active'`, [uuid.parse(req.params.postId), g.id])).rows[0]; if (!p) throw notFound('Post');
    if ((await c.query('SELECT count(*)::int n FROM group_pins WHERE group_id=$1', [g.id])).rows[0].n >= 3) throw conflict('You can pin up to 3 posts');
    await c.query(`INSERT INTO group_pins(group_id,post_id,pinned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [g.id, req.params.postId, me]);
  });
  res.status(204).end();
}));
circles.delete('/circles/:slug/posts/:postId/pin', requireAuth, wrap(async (req, res) => {
  const { g, m } = await loadGroup(String(req.params.slug), req.user!.id);
  if (!atLeast(m, 'admin')) throw forbidden('Only admins can unpin posts');
  await pool.query('DELETE FROM group_pins WHERE group_id=$1 AND post_id=$2', [g.id, uuid.parse(req.params.postId)]);
  res.status(204).end();
}));

/** Moderators remove posts inside their circle; the action is recorded with a reason. */
circles.delete('/circles/:slug/posts/:postId', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body ?? {});
  const { g, m } = await loadGroup(String(req.params.slug), me);
  if (!atLeast(m, 'moderator')) throw forbidden('Only moderators and admins can remove posts');
  await tx(async (c) => {
    const id = uuid.parse(req.params.postId); const p = (await c.query(`SELECT author_id FROM posts WHERE id=$1 AND group_id=$2 AND status<>'removed' FOR UPDATE`, [id, g.id])).rows[0];
    if (!p) throw notFound('Post');
    const am = await membership(c, g.id, p.author_id); if (am && RANK[am.role] >= RANK[m!.role] && p.author_id !== me) throw forbidden('You cannot remove a post from someone at or above your role');
    await c.query(`UPDATE posts SET status='removed' WHERE id=$1`, [id]); await c.query(`UPDATE feed_items SET status='removed' WHERE item_type='post' AND item_id=$1`, [id]);
    await c.query('DELETE FROM group_pins WHERE post_id=$1', [id]);
    await c.query(`INSERT INTO moderation_actions(moderator_id,target_type,target_id,action,reason) VALUES ($1,'post',$2,'remove',$3)`, [me, id, reason]);
    await audit(c, me, 'circle.post.remove', 'post', id, { group: g.id }, { reason }, req.ip ?? null);
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------------------------------------- events
const eventSchema = z.object({ title: z.string().trim().min(3).max(120), description: z.string().max(3000).default(''), starts_at: z.string().datetime(), ends_at: z.string().datetime().optional(), city: z.string().optional(), province: z.string().length(2).optional(), venue: z.string().max(120).optional() });

async function eventViews(ids: string[], viewer: string | null) {
  if (!ids.length) return new Map<string, any>();
  const { rows } = await pool.query(
    `SELECT e.*, g.slug AS group_slug, g.name AS group_name, u.username AS host_username, p.display_name AS host_name,
            (SELECT status FROM event_rsvps r WHERE r.event_id=e.id AND r.user_id=$2) AS my_rsvp
     FROM events e LEFT JOIN groups g ON g.id=e.group_id JOIN users u ON u.id=e.host_id JOIN user_profiles p ON p.user_id=u.id WHERE e.id = ANY($1::uuid[])`, [ids, viewer]);
  return new Map(rows.map((e) => [e.id, { id: e.id, title: e.title, description: e.description, starts_at: e.starts_at, ends_at: e.ends_at, venue: e.venue, location: e.city ? { city: e.city, province: e.province } : null, status: e.status, going_count: e.going_count,
    group: e.group_id ? { slug: e.group_slug, name: e.group_name } : null, host: { username: e.host_username, display_name: e.host_name }, viewer: { rsvp: e.my_rsvp ?? null } }]));
}

circles.post('/circles/:slug/events', requireAuth, wrap(async (req, res) => {
  const b = eventSchema.parse(req.body); const me = req.user!.id; const { g, m } = await loadGroup(String(req.params.slug), me);
  if (!atLeast(m, 'moderator')) throw forbidden('Only moderators and admins can create events');
  if (new Date(b.starts_at) < new Date()) throw badRequest('Events must start in the future');
  if (b.ends_at && new Date(b.ends_at) <= new Date(b.starts_at)) throw badRequest('The event must end after it starts');
  await checkText(b.title); await checkText(b.description);
  const id = await tx(async (c) => {
    const place = b.city ? await requirePlace(b.city, b.province, c) : g.city ? { city: g.city, province: g.province, lng: null, lat: null } : null;
    const r = await c.query(`INSERT INTO events(group_id,host_id,title,description,starts_at,ends_at,city,province,location,venue) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
      CASE WHEN $9::float8 IS NULL THEN $11::geography ELSE ST_SetSRID(ST_MakePoint($9,$10),4326)::geography END,$12) RETURNING id`,
      [g.id, me, b.title, b.description, b.starts_at, b.ends_at ?? null, place?.city ?? null, place?.province ?? null, place?.lng ?? null, place?.lat ?? null, g.location, b.venue ?? null]);
    const members = (await c.query(`SELECT user_id FROM group_members WHERE group_id=$1 AND status='active' AND user_id<>$2 LIMIT 500`, [g.id, me])).rows;
    for (const mm of members) await notify(c, { userId: mm.user_id, type: 'group_activity', actorId: me, targetType: 'event', targetId: r.rows[0].id, data: { event: 'new_event', title: b.title, name: g.name, slug: g.slug } });
    return r.rows[0].id as string;
  });
  res.status(201).json((await eventViews([id], me)).get(id));
}));

circles.get('/circles/:slug/events', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user?.id ?? null; const { g, m } = await loadGroup(String(req.params.slug), viewer);
  if (g.visibility === 'private' && !isActive(m)) throw forbidden('Members only');
  const rows = (await pool.query(`SELECT id FROM events WHERE group_id=$1 AND status='scheduled' AND coalesce(ends_at, starts_at + interval '3 hours') > now() ORDER BY starts_at LIMIT 50`, [g.id])).rows.map((r) => r.id);
  const map = await eventViews(rows, viewer); res.json({ items: rows.map((i) => map.get(i)) });
}));

circles.get('/events/upcoming', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user?.id ?? null; const q = z.object({ city: z.string().optional(), radius_km: z.coerce.number().min(1).max(2000).default(100) }).parse(req.query);
  const p: unknown[] = [viewer]; let loc = '';
  if (q.city) { const pl = await requirePlace(q.city); p.push(pl.lng, pl.lat, q.radius_km * 1000); loc = `AND e.location IS NOT NULL AND ST_DWithin(e.location, ST_SetSRID(ST_MakePoint($2::float8,$3::float8),4326)::geography, $4)`; }
  const rows = (await pool.query(`SELECT e.id FROM events e JOIN groups g ON g.id=e.group_id WHERE e.status='scheduled' AND g.status='active' AND e.starts_at > now() ${loc}
    AND (g.visibility='public' OR EXISTS (SELECT 1 FROM group_members m WHERE m.group_id=g.id AND m.user_id=$1 AND m.status='active')) ORDER BY e.starts_at LIMIT 50`, p)).rows.map((r) => r.id);
  const map = await eventViews(rows, viewer); res.json({ items: rows.map((i) => map.get(i)) });
}));

async function eventAccess(c: Db, id: string, me: string) {
  const e = (await c.query(`SELECT e.*, g.visibility FROM events e JOIN groups g ON g.id=e.group_id WHERE e.id=$1 AND e.status<>'removed' AND g.status='active'`, [id])).rows[0];
  if (!e) throw notFound('Event');
  const m = await membership(c, e.group_id, me);
  if (e.visibility === 'private' && !isActive(m)) throw notFound('Event');
  return { e, m };
}
circles.post('/events/:id/rsvp', requireAuth, wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(['going', 'interested']).default('going') }).parse(req.body ?? {}); const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { e } = await eventAccess(c, id, req.user!.id);
    if (e.status !== 'scheduled') throw conflict('This event was cancelled');
    await c.query(`INSERT INTO event_rsvps(event_id,user_id,status) VALUES ($1,$2,$3) ON CONFLICT (event_id,user_id) DO UPDATE SET status=EXCLUDED.status`, [id, req.user!.id, status]);
    await c.query(`UPDATE events SET going_count=(SELECT count(*) FROM event_rsvps WHERE event_id=$1 AND status='going') WHERE id=$1`, [id]);
  });
  res.json((await eventViews([id], req.user!.id)).get(id));
}));
circles.delete('/events/:id/rsvp', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => { await c.query('DELETE FROM event_rsvps WHERE event_id=$1 AND user_id=$2', [id, req.user!.id]); await c.query(`UPDATE events SET going_count=(SELECT count(*) FROM event_rsvps WHERE event_id=$1 AND status='going') WHERE id=$1`, [id]); });
  res.status(204).end();
}));
circles.delete('/events/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  await tx(async (c) => {
    const { e, m } = await eventAccess(c, id, me);
    if (e.host_id !== me && !atLeast(m, 'admin')) throw forbidden('Only the host or an admin can cancel this event');
    await c.query(`UPDATE events SET status='cancelled' WHERE id=$1`, [id]);
    for (const r of (await c.query(`SELECT user_id FROM event_rsvps WHERE event_id=$1`, [id])).rows) await notify(c, { userId: r.user_id, type: 'group_activity', actorId: me, targetType: 'event', targetId: id, data: { event: 'cancelled', title: e.title } });
  });
  res.status(204).end();
}));

export type { PoolClient };
