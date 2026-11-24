import { Router } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { HttpError, badRequest, conflict, forbidden, notFound, wrap } from '../lib/errors.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';
import { checkText } from '../lib/policy.js';
import { hydratePosts, hydrateJourneys, hydrateRequests, hydrateServices } from '../lib/hydrate.js';
import { notify } from '../lib/notify.js';
import { visibleTo } from '../lib/views.js';
import { audit } from '../lib/audit.js';
import { can } from './business.js';
import { atLeast, membership } from '../lib/groups.js';

export const content = Router();
const postLimiter = rateLimit({ windowMs: 60_000, limit: 20, skip: () => config.RATE_LIMIT_DISABLED === 'true',
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? '0.0.0.0') });

const uuid = z.string().uuid();

// ---- posts --------------------------------------------------------------
const postSchema = z.object({
  kind: z.enum(['text', 'photo', 'video', 'poll', 'share']).default('text'),
  body: z.string().trim().max(5000).optional(),
  media_ids: z.array(uuid).max(10).default([]),
  attachment_type: z.enum(['listing', 'business', 'transport_request', 'journey', 'transport_service']).optional(),
  video_id: uuid.optional(), group_id: uuid.optional(),
  poll: z.object({ options: z.array(z.string().trim().min(1).max(80)).min(2).max(6), closes_in_hours: z.number().int().min(1).max(24 * 30).optional() }).optional(),
  attachment_id: uuid.optional(),
  visibility: z.enum(['public', 'followers', 'private']).default('public'),
  business_id: uuid.optional(),
});

export async function assertOwnsMedia(db: Db, userId: string, ids: string[]) {
  if (!ids.length) return;
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM media_assets WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND status = 'ready'`, [ids, userId]);
  if (rows[0].n !== new Set(ids).size) throw badRequest('One of the images could not be used');
}

content.post('/posts', requireAuth, postLimiter, wrap(async (req, res) => {
  const b = postSchema.parse(req.body);
  const uid = req.user!.id;
  if (b.kind === 'photo' && !b.media_ids.length) throw badRequest('Add at least one photo');
  if (b.kind === 'text' && !b.body) throw badRequest('Write something to post');
  if (b.kind === 'share' && !b.attachment_id) throw badRequest('Choose something to share');
  if (b.kind === 'video' && !b.video_id) throw badRequest('Choose a video');
  if (b.kind === 'poll' && (!b.body || !b.poll)) throw badRequest('Ask a question and add 2–6 options');
  if (b.kind !== 'video' && b.video_id) throw badRequest('Only video posts can include a video');
  if (b.kind !== 'poll' && b.poll) throw badRequest('Only poll posts can include options');
  if (!!b.attachment_type !== !!b.attachment_id) throw badRequest('Attachment is incomplete');
  let flagged = await checkText(b.body);
  for (const o of b.poll?.options ?? []) flagged = (await checkText(o)) || flagged;
  const id = await tx(async (c) => {
    if (b.business_id && !(await can(b.business_id, uid, 'manage_listings')) && !(await can(b.business_id, uid, 'edit_profile'))) throw forbidden('You cannot post for this business');
    await assertOwnsMedia(c, uid, b.media_ids);
    let visibility: string = b.visibility; let groupId: string | null = null;
    if (b.group_id) {
      const g = (await c.query(`SELECT * FROM groups WHERE id=$1 AND status='active'`, [b.group_id])).rows[0];
      const m = g ? await membership(c, g.id, uid) : null;
      if (!g || !m || m.status !== 'active') throw forbidden('Join this circle to post in it');
      if (g.who_can_post === 'moderators' && !atLeast(m, 'moderator')) throw forbidden('Only moderators and admins can post in this circle');
      if (!g.allow_commerce && b.attachment_type && !atLeast(m, 'moderator')) throw forbidden('This circle does not allow listings or promotions from members');
      groupId = g.id; visibility = g.visibility === 'private' ? 'group' : 'public';
    }
    if (b.kind === 'video') {
      const v = (await c.query('SELECT status FROM videos WHERE id=$1 AND owner_id=$2', [b.video_id, uid])).rows[0];
      if (!v || ['failed', 'rejected', 'removed'].includes(v.status)) throw badRequest('That video is not available. Upload it again.');
      if ((await c.query(`SELECT 1 FROM posts WHERE video_id=$1 AND status <> 'removed'`, [b.video_id])).rowCount) throw conflict('That video is already posted');
    }
    if (b.attachment_type === 'listing') {
      const l = await c.query(`SELECT 1 FROM listings l WHERE l.id=$1 AND l.status IN ('active','reserved') AND l.visibility='public'`, [b.attachment_id]);
      if (!l.rowCount) throw badRequest('That listing is not available to share');
    }
    if (b.attachment_type === 'transport_request' && !(await c.query(`SELECT 1 FROM transport_requests WHERE id=$1 AND status='open' AND visibility='public'`, [b.attachment_id])).rowCount) throw badRequest('That request is not available to share');
    if (b.attachment_type === 'journey' && !(await c.query(`SELECT 1 FROM journeys WHERE id=$1 AND status IN ('open','full')`, [b.attachment_id])).rowCount) throw badRequest('That journey is not available to share');
    if (b.attachment_type === 'transport_service' && !(await c.query(`SELECT 1 FROM transport_services WHERE id=$1 AND status='active'`, [b.attachment_id])).rowCount) throw badRequest('That service is not available to share');
    if (b.attachment_type === 'business') {
      if (!(await c.query(`SELECT 1 FROM businesses WHERE id=$1 AND status='active'`, [b.attachment_id])).rowCount) throw badRequest('That business is not available to share');
    }
    const status = flagged ? 'pending' : 'active';
    const p = await c.query(
      `INSERT INTO posts(author_id,business_id,group_id,kind,body,attachment_type,attachment_id,visibility,status,video_id,poll_closes_at,location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11::int IS NULL THEN NULL ELSE now() + ($11 || ' hours')::interval END,
         CASE WHEN $3::uuid IS NULL THEN (SELECT location FROM user_profiles WHERE user_id=$1) ELSE NULL END) RETURNING id, location`,
      [uid, b.business_id ?? null, groupId, b.kind, b.body ?? null, b.attachment_type ?? null, b.attachment_id ?? null, visibility, status, b.video_id ?? null, b.poll?.closes_in_hours ?? null]);
    for (const [i, m] of b.media_ids.entries()) await c.query(`INSERT INTO post_media(post_id,media_id,position) VALUES ($1,$2,$3)`, [p.rows[0].id, m, i]);
    for (const [i, o] of (b.poll?.options ?? []).entries()) await c.query(`INSERT INTO poll_options(post_id,text,position) VALUES ($1,$2,$3)`, [p.rows[0].id, o, i]);
    await c.query(`INSERT INTO feed_items(item_type,item_id,author_id,business_id,group_id,visibility,status,location) VALUES ('post',$1,$2,$3,$4,$5,$6,$7)`,
      [p.rows[0].id, uid, b.business_id ?? null, groupId, visibility, status, p.rows[0].location]);
    return p.rows[0].id as string;
  });
  res.status(201).json((await hydratePosts([id], uid)).get(id));
}));

content.get('/posts/:id', optionalAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { rows } = await pool.query(`SELECT p.id FROM posts p WHERE p.id=$1 AND ${visibleTo('p', '$2')}`, [id, req.user?.id ?? null]);
  if (!rows[0]) throw notFound('Post');
  res.json((await hydratePosts([id], req.user?.id ?? null)).get(id));
}));

content.delete('/posts/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows } = await c.query('SELECT author_id, status FROM posts WHERE id=$1 FOR UPDATE', [id]);
    if (!rows[0]) throw notFound('Post');
    const mod = req.user!.permissions.includes('moderate.content');
    if (rows[0].author_id !== req.user!.id && !mod) throw forbidden();
    await c.query(`UPDATE posts SET status='removed' WHERE id=$1`, [id]);
    await c.query(`UPDATE feed_items SET status='removed' WHERE item_type='post' AND item_id=$1`, [id]);
    if (rows[0].author_id !== req.user!.id) await audit(c, req.user!.id, 'post.remove', 'post', id, { status: rows[0].status }, { status: 'removed' }, req.ip ?? null);
  });
  res.status(204).end();
}));

// ---- comments (threaded, one level of replies) ------------------------------
const TARGETS: Record<string, { table: string }> = {
  post: { table: 'posts' }, listing: { table: 'listings' }, transport_request: { table: 'transport_requests' }, journey: { table: 'journeys' }, transport_service: { table: 'transport_services' },
};
const BLOCK = (owner: string) => `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$2::uuid AND b.blocked_id=${owner}) OR (b.blocker_id=${owner} AND b.blocked_id=$2::uuid))`;

async function assertTargetVisible(db: Db, type: string, id: string, viewer: string | null) {
  if (!TARGETS[type]) throw new HttpError(422, 'Comments are not available on that yet', 'not_available');
  const q: Record<string, string> = {
    post: `SELECT p.author_id FROM posts p WHERE p.id=$1 AND ${visibleTo('p', '$2')}`,
    listing: `SELECT l.seller_id AS author_id FROM listings l WHERE l.id=$1 AND l.status IN ('active','reserved','sold') AND ${BLOCK('l.seller_id')}`,
    transport_request: `SELECT r.requester_id AS author_id FROM transport_requests r WHERE r.id=$1 AND ((r.status='open' AND r.visibility='public') OR r.requester_id=$2::uuid) AND ${BLOCK('r.requester_id')}`,
    journey: `SELECT j.driver_id AS author_id FROM journeys j WHERE j.id=$1 AND j.status IN ('open','full','departed') AND ${BLOCK('j.driver_id')}`,
    transport_service: `SELECT s.provider_id AS author_id FROM transport_services s WHERE s.id=$1 AND s.status='active' AND ${BLOCK('s.provider_id')}`,
  };
  const { rows } = await db.query(q[type], [id, viewer]);
  if (!rows[0]) throw notFound('Item');
  return rows[0].author_id as string;
}

const commentView = (r: any) => ({
  id: r.id, body: r.status === 'removed' ? null : r.body, removed: r.status === 'removed', parent_id: r.parent_id, like_count: r.like_count, created_at: r.created_at,
  author: { id: r.author_id, username: r.username, display_name: r.display_name }, liked: r.liked ?? false,
});

content.get('/comments', optionalAuth, wrap(async (req, res) => {
  const q = z.object({ target_type: z.enum(['post', 'listing', 'transport_request', 'journey', 'transport_service']), target_id: uuid, limit: z.coerce.number().int().min(1).max(50).default(20), before: z.string().datetime().optional() }).parse(req.query);
  const viewer = req.user?.id ?? null;
  await assertTargetVisible(pool, q.target_type, q.target_id, viewer);
  const { rows } = await pool.query(
    `SELECT c.*, u.username, p.display_name, EXISTS (SELECT 1 FROM reactions r WHERE r.user_id=$3 AND r.target_type='comment' AND r.target_id=c.id) AS liked
     FROM comments c JOIN users u ON u.id=c.author_id JOIN user_profiles p ON p.user_id=u.id
     WHERE c.target_type=$1 AND c.target_id=$2 AND c.parent_id IS NULL AND ($4::timestamptz IS NULL OR c.created_at < $4)
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$3::uuid AND b.blocked_id=c.author_id) OR (b.blocker_id=c.author_id AND b.blocked_id=$3::uuid))
     ORDER BY c.created_at DESC LIMIT $5`, [q.target_type, q.target_id, viewer, q.before ?? null, q.limit]);
  const ids = rows.map((r) => r.id);
  const replies = ids.length ? (await pool.query(
    `SELECT c.*, u.username, p.display_name, EXISTS (SELECT 1 FROM reactions r WHERE r.user_id=$2 AND r.target_type='comment' AND r.target_id=c.id) AS liked
     FROM comments c JOIN users u ON u.id=c.author_id JOIN user_profiles p ON p.user_id=u.id
     WHERE c.parent_id = ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$2::uuid AND b.blocked_id=c.author_id) OR (b.blocker_id=c.author_id AND b.blocked_id=$2::uuid))
     ORDER BY c.created_at`, [ids, viewer])).rows : [];
  res.json({ items: rows.map((r) => ({ ...commentView(r), replies: replies.filter((x) => x.parent_id === r.id).map(commentView) })),
    next_before: rows.length === q.limit ? rows[rows.length - 1].created_at : null });
}));

content.post('/comments', requireAuth, postLimiter, wrap(async (req, res) => {
  const b = z.object({ target_type: z.enum(['post', 'listing', 'transport_request', 'journey', 'transport_service']), target_id: uuid, parent_id: uuid.optional(), body: z.string().trim().min(1).max(2000) }).parse(req.body);
  const uid = req.user!.id;
  const flagged = await checkText(b.body);
  if (flagged) throw new HttpError(422, 'This content breaks our community guidelines', 'policy_violation');
  const id = await tx(async (c) => {
    const owner = await assertTargetVisible(c, b.target_type, b.target_id, uid);
    let parent: string | null = null;
    if (b.parent_id) {
      const p = await c.query('SELECT parent_id, target_type, target_id, status FROM comments WHERE id=$1', [b.parent_id]);
      if (!p.rows[0] || p.rows[0].target_id !== b.target_id || p.rows[0].target_type !== b.target_type || p.rows[0].status !== 'active') throw badRequest('Cannot reply to that comment');
      parent = p.rows[0].parent_id ?? b.parent_id;     // flatten: replies to replies attach to the top-level comment
    }
    const r = await c.query(`INSERT INTO comments(target_type,target_id,author_id,parent_id,body) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [b.target_type, b.target_id, uid, parent, b.body]);
    await c.query(`UPDATE ${TARGETS[b.target_type].table} SET comment_count = comment_count + 1 WHERE id = $1`, [b.target_id]);
    await notify(c, { userId: owner, type: parent ? 'reply' : 'comment', actorId: uid, targetType: b.target_type, targetId: b.target_id, data: { comment_id: r.rows[0].id } });
    return r.rows[0].id as string;
  });
  const { rows } = await pool.query(`SELECT c.*, u.username, p.display_name FROM comments c JOIN users u ON u.id=c.author_id JOIN user_profiles p ON p.user_id=u.id WHERE c.id=$1`, [id]);
  res.status(201).json(commentView(rows[0]));
}));

content.delete('/comments/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows } = await c.query('SELECT author_id, target_type, target_id, status FROM comments WHERE id=$1 FOR UPDATE', [id]);
    const r = rows[0];
    if (!r || r.status === 'removed') throw notFound('Comment');
    const mod = req.user!.permissions.includes('moderate.content');
    if (r.author_id !== req.user!.id && !mod) throw forbidden();
    await c.query(`UPDATE comments SET status='removed' WHERE id=$1`, [id]);
    await c.query(`UPDATE ${TARGETS[r.target_type].table} SET comment_count = greatest(comment_count-1,0) WHERE id=$1`, [r.target_id]);
    if (r.author_id !== req.user!.id) await audit(c, req.user!.id, 'comment.remove', 'comment', id, null, null, req.ip ?? null);
  });
  res.status(204).end();
}));

// ---- reactions / saves ---------------------------------------------------------------
const COUNTED: Record<string, string> = { post: 'posts', comment: 'comments', listing: 'listings', transport_request: 'transport_requests', journey: 'journeys', transport_service: 'transport_services' };
const reactParams = z.object({ type: z.enum(['post', 'comment', 'listing', 'transport_request', 'journey', 'transport_service']), id: uuid });

content.put('/reactions/:type/:id', requireAuth, wrap(async (req, res) => {
  const { type, id } = reactParams.parse(req.params);
  const uid = req.user!.id;
  const count = await tx(async (c) => {
    if (type === 'comment') { if (!(await c.query(`SELECT 1 FROM comments WHERE id=$1 AND status='active'`, [id])).rowCount) throw notFound('Comment'); }
    else await assertTargetVisible(c, type, id, uid);
    const ins = await c.query(`INSERT INTO reactions(user_id,target_type,target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`, [uid, type, id]);
    if (ins.rowCount) await c.query(`UPDATE ${COUNTED[type]} SET like_count = like_count + 1 WHERE id=$1`, [id]);
    return (await c.query(`SELECT like_count FROM ${COUNTED[type]} WHERE id=$1`, [id])).rows[0].like_count;
  });
  res.json({ liked: true, like_count: count });
}));
content.delete('/reactions/:type/:id', requireAuth, wrap(async (req, res) => {
  const { type, id } = reactParams.parse(req.params);
  const count = await tx(async (c) => {
    const del = await c.query(`DELETE FROM reactions WHERE user_id=$1 AND target_type=$2 AND target_id=$3 RETURNING 1`, [req.user!.id, type, id]);
    if (del.rowCount) await c.query(`UPDATE ${COUNTED[type]} SET like_count = greatest(like_count-1,0) WHERE id=$1`, [id]);
    return (await c.query(`SELECT like_count FROM ${COUNTED[type]} WHERE id=$1`, [id])).rows[0]?.like_count ?? 0;
  });
  res.json({ liked: false, like_count: count });
}));

const saveParams = z.object({ type: z.enum(['post', 'listing', 'transport_request', 'journey', 'transport_service', 'business']), id: uuid });
content.put('/saves/:type/:id', requireAuth, wrap(async (req, res) => {
  const { type, id } = saveParams.parse(req.params);
  await tx(async (c) => {
    if (type !== 'business') await assertTargetVisible(c, type, id, req.user!.id);
    const ins = await c.query(`INSERT INTO saved_items(user_id,target_type,target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`, [req.user!.id, type, id]);
    if (ins.rowCount && type !== 'business') await c.query(`UPDATE ${TARGETS[type].table} SET save_count = save_count + 1 WHERE id=$1`, [id]);
  });
  res.status(204).end();
}));
content.delete('/saves/:type/:id', requireAuth, wrap(async (req, res) => {
  const { type, id } = saveParams.parse(req.params);
  await tx(async (c) => {
    const del = await c.query(`DELETE FROM saved_items WHERE user_id=$1 AND target_type=$2 AND target_id=$3 RETURNING 1`, [req.user!.id, type, id]);
    if (del.rowCount && type !== 'business') await c.query(`UPDATE ${TARGETS[type].table} SET save_count = greatest(save_count-1,0) WHERE id=$1`, [id]);
  });
  res.status(204).end();
}));

content.get('/me/saved', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT target_type, target_id FROM saved_items WHERE user_id=$1 AND target_type <> 'business' ORDER BY created_at DESC LIMIT 100`, [req.user!.id]);
  const { hydrateListings } = await import('../lib/hydrate.js');
  const ids = (t: string) => rows.filter((r) => r.target_type === t).map((r) => r.target_id); const me = req.user!.id;
  const maps: Record<string, Map<string, any>> = { post: await hydratePosts(ids('post'), me), listing: await hydrateListings(ids('listing'), me), transport_request: await hydrateRequests(ids('transport_request'), me), journey: await hydrateJourneys(ids('journey'), me), transport_service: await hydrateServices(ids('transport_service'), me) };
  res.json({ items: rows.map((r) => maps[r.target_type].get(r.target_id)).filter((x) => x && x.status !== 'removed' && x.status !== 'cancelled') });
}));

// ---- reports ------------------------------------------------------------------------------
content.post('/reports', requireAuth, wrap(async (req, res) => {
  const b = z.object({
    target_type: z.enum(['user', 'post', 'comment', 'listing', 'business', 'message', 'transport_request', 'journey', 'transport_service', 'group', 'story', 'event']), target_id: uuid,
    reason: z.enum(['spam', 'prohibited_item', 'fraud', 'harassment', 'nudity', 'violence', 'misleading', 'other']),
    details: z.string().max(1000).optional(),
  }).parse(req.body);
  const uid = req.user!.id;
  if (b.target_type === 'user' && b.target_id === uid) throw badRequest('You cannot report yourself');
  if (b.target_type === 'message') {
    const m = await pool.query(`SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$2 WHERE m.id=$1`, [b.target_id, uid]);
    if (!m.rowCount) throw notFound('Message');
  } else {
    const tbl = { user: 'users', post: 'posts', comment: 'comments', listing: 'listings', business: 'businesses', transport_request: 'transport_requests', journey: 'journeys', transport_service: 'transport_services', group: 'groups', story: 'stories', event: 'events' }[b.target_type]!;
    if (!(await pool.query(`SELECT 1 FROM ${tbl} WHERE id=$1`, [b.target_id])).rowCount) throw notFound('Item');
  }
  await pool.query(`INSERT INTO reports(reporter_id,target_type,target_id,reason,details) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (reporter_id,target_type,target_id) DO NOTHING`,
    [uid, b.target_type, b.target_id, b.reason, b.details ?? null]);
  res.status(201).json({ ok: true });
}));
