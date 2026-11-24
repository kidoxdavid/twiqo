import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError, badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';
import { setting } from '../lib/policy.js';
import { hydratePosts } from '../lib/hydrate.js';
import { visibleTo } from '../lib/views.js';
import { resolvePlace } from '../lib/geo.js';

export const clips = Router();
const uuid = z.string().uuid();
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s?: string) => { try { return s ? JSON.parse(Buffer.from(s, 'base64url').toString()) : null; } catch { throw badRequest('Bad cursor'); } };

/**
 * Clips: full-screen vertical video. Ranking is configurable (platform_settings feed.weights) and starts simple:
 * recency + followed creators + engagement quality + proximity. Engagement is capped and logged so a burst of likes
 * cannot dominate, and brand-new accounts are only shown to their followers until they are old enough.
 */
clips.get('/clips', optionalAuth, wrap(async (req, res) => {
  const a = z.object({ tab: z.enum(['for_you', 'following', 'nearby']).default('for_you'), limit: z.coerce.number().int().min(1).max(20).default(8), cursor: z.string().optional(), city: z.string().optional(), radius_km: z.coerce.number().min(1).max(500).optional() }).parse(req.query);
  const viewer = req.user?.id ?? null;
  if (a.tab === 'following' && !viewer) throw badRequest('Sign in to see creators you follow');
  let center: { lng: number; lat: number } | null = null;
  if (a.city) { const p = await resolvePlace(a.city); if (p) center = { lat: p.lat, lng: p.lng }; }
  else if (viewer) { const r = await pool.query(`SELECT ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat FROM user_profiles WHERE user_id=$1 AND location IS NOT NULL`, [viewer]); if (r.rows[0]) center = r.rows[0]; }
  if (a.tab === 'nearby' && !center) throw badRequest('Choose a city to see clips near you');
  const p: unknown[] = [viewer]; const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const followed = `p.author_id IN (SELECT target_id FROM follows WHERE follower_id=$1::uuid AND target_type='user')`;
  const minAge = Number(await setting('clips.min_account_age_hours', 24));
  const where = [`p.kind='video'`, `v.status='ready'`, visibleTo('p', '$1')];
  const cpt = center && (a.tab === 'for_you' || a.tab === 'nearby') ? `ST_SetSRID(ST_MakePoint(${add(center.lng)}::float8, ${add(center.lat)}::float8),4326)::geography` : null;
  if (a.tab === 'following') where.push(followed);
  if (a.tab === 'nearby') where.push(`p.location IS NOT NULL AND ST_DWithin(p.location, ${cpt}, ${add((a.radius_km ?? Number(await setting('search.default_radius_km', 25))) * 1000)})`);
  if (a.tab === 'for_you') where.push(`(u.created_at < now() - (${add(minAge)} || ' hours')::interval OR ${followed})`);
  let rows: { id: string; created_at: Date }[]; let next: string | null = null;
  if (a.tab === 'for_you') {
    const w = await setting('feed.weights', { recency: 1, following: 2, engagement: 0.5, proximity: 0.8 }); const offset = dec(a.cursor)?.o ?? 0;
    const score = `(${Number(w.recency)} * (1.0 / (1 + extract(epoch from now() - p.created_at) / 3600 / 12)) + ${Number(w.following)} * (CASE WHEN ${followed} THEN 1 ELSE 0 END)
      + ${Number(w.engagement)} * ln(1 + least(p.like_count, 500) + 2 * least(p.comment_count, 100) + 0.2 * least(p.view_count, 5000))
      + ${cpt ? `${Number(w.proximity)} * (CASE WHEN p.location IS NULL THEN 0 ELSE 1.0 / (1 + ST_Distance(p.location, ${cpt}) / 1000 / 25) END)` : '0'})`;
    rows = (await pool.query(`SELECT p.id, p.created_at FROM posts p JOIN videos v ON v.id=p.video_id JOIN users u ON u.id=p.author_id WHERE ${where.join(' AND ')} ORDER BY ${score} DESC, p.id LIMIT ${a.limit + 1} OFFSET ${Number(offset)}`, p)).rows;
    if (rows.length > a.limit) next = enc({ o: Number(offset) + a.limit });
  } else {
    const cur = dec(a.cursor); if (cur) where.push(`(p.created_at, p.id) < (${add(cur.t)}::timestamptz, ${add(cur.i)}::uuid)`);
    rows = (await pool.query(`SELECT p.id, p.created_at FROM posts p JOIN videos v ON v.id=p.video_id JOIN users u ON u.id=p.author_id WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ${a.limit + 1}`, p)).rows;
    if (rows.length > a.limit) { const last = rows[a.limit - 1]; next = enc({ t: last.created_at, i: last.id }); }
  }
  const page = rows.slice(0, a.limit); const map = await hydratePosts(page.map((r) => r.id), viewer);
  res.json({ items: page.map((r) => map.get(r.id)), next_cursor: next });
}));

/** One view per person (or per network address when signed out) per day. */
clips.post('/posts/:id/view', optionalAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const viewer = req.user?.id ?? null;
  const ok = await pool.query(`SELECT 1 FROM posts p WHERE p.id=$1 AND p.author_id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000') AND ${visibleTo('p', '$2')}`, [id, viewer]);
  if (ok.rowCount) {
    const key = viewer ?? crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 24);
    const ins = await pool.query(`INSERT INTO post_views(post_id, viewer_key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1`, [id, key]);
    if (ins.rowCount) await pool.query('UPDATE posts SET view_count = view_count + 1 WHERE id=$1', [id]);
  }
  res.status(204).end();
}));

clips.post('/posts/:id/vote', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id; const { option_id } = z.object({ option_id: uuid }).parse(req.body);
  await tx(async (c) => {
    const p = (await c.query(`SELECT p.kind, p.poll_closes_at FROM posts p WHERE p.id=$1 AND ${visibleTo('p', '$2')} FOR NO KEY UPDATE OF p`, [id, me])).rows[0];
    if (!p || p.kind !== 'poll') throw notFound('Poll');
    if (p.poll_closes_at && new Date(p.poll_closes_at) < new Date()) throw new HttpError(409, 'This poll has closed', 'closed');
    if (!(await c.query('SELECT 1 FROM poll_options WHERE id=$1 AND post_id=$2', [option_id, id])).rowCount) throw badRequest('Choose one of the options');
    const ins = await c.query(`INSERT INTO poll_votes(post_id,user_id,option_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`, [id, me, option_id]);
    if (!ins.rowCount) throw conflict('You already voted in this poll');
    await c.query('UPDATE poll_options SET vote_count = vote_count + 1 WHERE id=$1', [option_id]);
  });
  res.json((await hydratePosts([id], me)).get(id));
}));
