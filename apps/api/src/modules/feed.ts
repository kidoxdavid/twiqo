import { pickSponsored } from './boosts.js';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { badRequest, notFound, wrap } from '../lib/errors.js';
import { optionalAuth } from '../lib/auth.js';
import { setting } from '../lib/policy.js';
import { hydrateJourneys, hydrateListings, hydratePosts, hydrateRequests, hydrateServices } from '../lib/hydrate.js';
import { visibleTo } from '../lib/views.js';
import { resolvePlace } from '../lib/geo.js';

export const feed = Router();

const q = z.object({
  tab: z.enum(['for_you', 'following', 'nearby', 'circles']).default('for_you'),
  limit: z.coerce.number().int().min(1).max(30).default(15),
  cursor: z.string().optional(),
  lat: z.coerce.number().optional(), lng: z.coerce.number().optional(), city: z.string().optional(), radius_km: z.coerce.number().min(1).max(500).optional(),
});

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s?: string) => { try { return s ? JSON.parse(Buffer.from(s, 'base64url').toString()) : null; } catch { throw badRequest('Bad cursor'); } };

feed.get('/feed', optionalAuth, wrap(async (req, res) => {
  const a = q.parse(req.query);
  const viewer = req.user?.id ?? null;
  if (a.tab === 'circles' && !viewer) throw badRequest('Sign in to see your circles');
  if (a.tab === 'following' && !viewer) throw badRequest('Sign in to see people you follow');

  let center: { lng: number; lat: number } | null = null;
  if (a.lat !== undefined && a.lng !== undefined) center = { lat: a.lat, lng: a.lng };
  else if (a.city) { const p = await resolvePlace(a.city); if (p) center = { lat: p.lat, lng: p.lng }; }
  else if (viewer) {
    const r = await pool.query(`SELECT ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat FROM user_profiles WHERE user_id=$1 AND location IS NOT NULL`, [viewer]);
    if (r.rows[0]) center = r.rows[0];
  }
  if (a.tab === 'nearby' && !center) throw badRequest('Choose a city to see what is nearby');

  const p: unknown[] = [viewer]; const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const where = [visibleTo('fi', '$1'), `fi.created_at > now() - interval '60 days'`,
    `(fi.item_type <> 'post' OR NOT EXISTS (SELECT 1 FROM posts vp JOIN videos vv ON vv.id = vp.video_id WHERE vp.id = fi.item_id AND vv.status <> 'ready'))`];
  if (a.tab === 'circles') where.push(`fi.group_id IN (SELECT group_id FROM group_members WHERE user_id=$1::uuid AND status='active')`);
  const followed = `(fi.author_id IN (SELECT target_id FROM follows WHERE follower_id=$1::uuid AND target_type='user') OR fi.business_id IN (SELECT target_id FROM follows WHERE follower_id=$1::uuid AND target_type='business'))`;
  if (a.tab === 'following') where.push(followed);
  const cpt = center && (a.tab === 'for_you' || a.tab === 'nearby') ? `ST_SetSRID(ST_MakePoint(${add(center.lng)}::float8, ${add(center.lat)}::float8),4326)::geography` : null;
  if (a.tab === 'nearby') where.push(`fi.location IS NOT NULL AND ST_DWithin(fi.location, ${cpt}, ${add((a.radius_km ?? Number(await setting('search.default_radius_km', 25))) * 1000)})`);

  let rows: { item_type: string; item_id: string; created_at: Date; id: string }[]; let next: string | null = null;
  if (a.tab === 'for_you') {
    // Configurable ranking (platform_settings feed.weights): recency decay + followed accounts + engagement quality + proximity.
    const w = await setting('feed.weights', { recency: 1, following: 2, engagement: 0.5, proximity: 0.8 });
    const offset = dec(a.cursor)?.o ?? 0;
    const score = `(${Number(w.recency)} * (1.0 / (1 + extract(epoch from now() - fi.created_at) / 3600 / 12))
      + ${Number(w.following)} * (CASE WHEN ${followed} THEN 1 ELSE 0 END)
      + ${Number(w.engagement)} * ln(1 + coalesce(po.like_count + 2*po.comment_count, li.like_count + 2*li.comment_count + li.save_count, 0))
      + ${cpt ? `${Number(w.proximity)} * (CASE WHEN fi.location IS NULL THEN 0 ELSE 1.0 / (1 + ST_Distance(fi.location, ${cpt}) / 1000 / 25) END)` : '0'}
      + fi.rank_hint)`;
    ({ rows } = await pool.query(
      `SELECT fi.id, fi.item_type, fi.item_id, fi.created_at FROM feed_items fi
       LEFT JOIN posts po ON fi.item_type='post' AND po.id = fi.item_id
       LEFT JOIN listings li ON fi.item_type='listing' AND li.id = fi.item_id AND li.expires_at > now()
       WHERE ${where.join(' AND ')} AND (fi.item_type <> 'listing' OR li.id IS NOT NULL)
       ORDER BY ${score} DESC, fi.id LIMIT ${a.limit + 1} OFFSET ${Number(offset)}`, p));
    if (rows.length > a.limit) next = enc({ o: Number(offset) + a.limit });
  } else {
    const cur = dec(a.cursor);
    if (cur) where.push(`(fi.created_at, fi.id) < (${add(cur.t)}::timestamptz, ${add(cur.i)}::uuid)`);
    ({ rows } = await pool.query(
      `SELECT fi.id, fi.item_type, fi.item_id, fi.created_at FROM feed_items fi
       LEFT JOIN listings li ON fi.item_type='listing' AND li.id = fi.item_id
       WHERE ${where.join(' AND ')} AND (fi.item_type <> 'listing' OR li.expires_at > now())
       ORDER BY fi.created_at DESC, fi.id DESC LIMIT ${a.limit + 1}`, p));
    if (rows.length > a.limit) { const last = rows[a.limit - 1]; next = enc({ t: last.created_at, i: last.id }); }
  }
  rows = rows.slice(0, a.limit);
  const posts = await hydratePosts(rows.filter((r) => r.item_type === 'post').map((r) => r.item_id), viewer);
  const listings = await hydrateListings(rows.filter((r) => r.item_type === 'listing').map((r) => r.item_id), viewer, center ?? undefined);
  const ids = (t: string) => rows.filter((r) => r.item_type === t).map((r) => r.item_id);
  const [reqs, jrns, svcs] = await Promise.all([hydrateRequests(ids('transport_request'), viewer), hydrateJourneys(ids('journey'), viewer), hydrateServices(ids('transport_service'), viewer)]);
  const pick = (r: { item_type: string; item_id: string }) => ({ post: posts, listing: listings, transport_request: reqs, journey: jrns, transport_service: svcs } as Record<string, Map<string, any>>)[r.item_type]?.get(r.item_id);
  const items: any[] = rows.map(pick).filter(Boolean);
  // at most one clearly labelled sponsored item per page, in the For You and Nearby feeds only
  if (a.tab === 'for_you' || a.tab === 'nearby') {
    const sp = await pickSponsored(viewer, items.map((i) => i.id), items.length);
    if (sp) items.splice(Math.min(items.length, Number(await setting('ads.every_n', 8)) - 1), 0, sp);
  }
  res.json({ items, next_cursor: next });
}));

feed.get('/users/:username/posts', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user?.id ?? null;
  const u = await pool.query(`SELECT id FROM users WHERE username=$1 AND status='active'`, [req.params.username]);
  if (!u.rows[0]) throw notFound('Profile');
  const { rows } = await pool.query(`SELECT p.id FROM posts p WHERE p.author_id=$1 AND ${visibleTo('p', '$2')} ORDER BY p.created_at DESC LIMIT 40`, [u.rows[0].id, viewer]);
  const map = await hydratePosts(rows.map((r) => r.id), viewer);
  res.json({ items: rows.map((r) => map.get(r.id)) });
}));
