import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError, notFound, wrap, badRequest } from '../lib/errors.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';
import { resolvePlace } from '../lib/geo.js';
import { checkText } from '../lib/policy.js';
import { mediaUrl, thumbUrl } from '../lib/views.js';
import { meView } from './identity.js';

export const users = Router();

const avatar = (k: string | null) => (k ? thumbUrl(k) : null);

users.get('/users/:username', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user?.id ?? null;
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.account_type, u.status, u.created_at, p.display_name, p.bio, p.city, p.province, p.privacy, p.verification_level,
            p.follower_count, p.following_count,
            (SELECT storage_key FROM media_assets WHERE id = p.avatar_media_id) AS avatar_key,
            (SELECT storage_key FROM media_assets WHERE id = p.cover_media_id) AS cover_key,
            (SELECT count(*) FROM posts WHERE author_id = u.id AND status='active' AND visibility='public')::int AS post_count,
            (SELECT count(*) FROM listings WHERE seller_id = u.id AND status='active' AND visibility='public')::int AS listing_count,
            EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.target_type='user' AND f.target_id = u.id) AS i_follow,
            EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = u.id) AS i_blocked,
            EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $2) AS blocked_me
     FROM users u JOIN user_profiles p ON p.user_id = u.id WHERE u.username = $1 AND u.status <> 'deleted'`, [req.params.username, viewer]);
  const r = rows[0];
  if (!r || r.blocked_me || r.status === 'banned') throw notFound('Profile');
  const priv = r.privacy ?? {};
  const own = viewer === r.id;
  res.json({
    id: r.id, username: r.username, display_name: r.display_name, bio: r.bio, account_type: r.account_type,
    verification_level: r.verification_level, joined: r.created_at,
    location: own || priv.show_location !== false ? { city: r.city, province: r.province } : null,
    avatar_url: avatar(r.avatar_key), cover_url: r.cover_key ? mediaUrl(r.cover_key) : null,
    counts: { followers: own || priv.show_followers !== false ? r.follower_count : null, following: r.following_count, posts: r.post_count, listings: r.listing_count },
    viewer: viewer ? { is_self: own, following: r.i_follow, blocked: r.i_blocked } : null,
  });
}));

const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(60).optional(),
  bio: z.string().max(500).nullable().optional(),
  city: z.string().optional(), province: z.string().length(2).optional(),
  avatar_media_id: z.string().uuid().nullable().optional(), cover_media_id: z.string().uuid().nullable().optional(),
  privacy: z.object({
    show_followers: z.boolean().optional(), show_location: z.boolean().optional(),
    show_transport_history: z.boolean().optional(), allow_messages: z.enum(['everyone', 'followers', 'nobody']).optional(),
  }).optional(),
});

users.patch('/me/profile', requireAuth, wrap(async (req, res) => {
  const b = profileSchema.parse(req.body);
  await checkText(b.display_name); await checkText(b.bio);
  const uid = req.user!.id;
  for (const m of [b.avatar_media_id, b.cover_media_id]) {
    if (m) { const o = await pool.query('SELECT 1 FROM media_assets WHERE id = $1 AND owner_id = $2', [m, uid]); if (!o.rowCount) throw badRequest('Unknown image'); }
  }
  const place = b.city ? await resolvePlace(b.city, b.province) : null;
  if (b.city && !place) throw badRequest('We could not find that city');
  await pool.query(
    `UPDATE user_profiles SET
       display_name = coalesce($2, display_name),
       bio = CASE WHEN $3::boolean THEN $4 ELSE bio END,
       avatar_media_id = CASE WHEN $5::boolean THEN $6 ELSE avatar_media_id END,
       cover_media_id = CASE WHEN $7::boolean THEN $8 ELSE cover_media_id END,
       city = coalesce($9, city), province = coalesce($10, province),
       location = CASE WHEN $11::float8 IS NULL THEN location ELSE ST_SetSRID(ST_MakePoint($11,$12),4326)::geography END,
       privacy = privacy || $13::jsonb
     WHERE user_id = $1`,
    [uid, b.display_name ?? null, 'bio' in b, b.bio ?? null, 'avatar_media_id' in b, b.avatar_media_id ?? null,
      'cover_media_id' in b, b.cover_media_id ?? null, place?.city ?? null, place?.province ?? null, place?.lng ?? null, place?.lat ?? null,
      JSON.stringify(b.privacy ?? {})]);
  res.json({ user: await meView(uid) });
}));

// ---- follow graph -------------------------------------------------------
users.post('/follows/:type/:id', requireAuth, wrap(async (req, res) => {
  const { type, id } = z.object({ type: z.enum(['user', 'business']), id: z.string().uuid() }).parse(req.params);
  const me = req.user!.id;
  if (type === 'user' && id === me) throw badRequest('You cannot follow yourself');
  await tx(async (c) => {
    const exists = await c.query(type === 'user' ? `SELECT 1 FROM users WHERE id=$1 AND status='active'` : `SELECT 1 FROM businesses WHERE id=$1 AND status='active'`, [id]);
    if (!exists.rowCount) throw notFound(type);
    if (type === 'user') {
      const blk = await c.query(`SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`, [me, id]);
      if (blk.rowCount) throw new HttpError(403, 'You cannot follow this account');
    }
    const ins = await c.query(`INSERT INTO follows(follower_id,target_type,target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`, [me, type, id]);
    if (ins.rowCount) {
      await c.query(`UPDATE user_profiles SET following_count = following_count + 1 WHERE user_id = $1`, [me]);
      await c.query(type === 'user' ? `UPDATE user_profiles SET follower_count = follower_count + 1 WHERE user_id = $1` : `UPDATE businesses SET follower_count = follower_count + 1 WHERE id = $1`, [id]);
      if (type === 'user') await c.query(`INSERT INTO notifications(user_id,type,actor_id,target_type,target_id) VALUES ($1,'follow',$2,'user',$2)`, [id, me]);
    }
  });
  res.status(204).end();
}));

users.delete('/follows/:type/:id', requireAuth, wrap(async (req, res) => {
  const { type, id } = z.object({ type: z.enum(['user', 'business']), id: z.string().uuid() }).parse(req.params);
  const me = req.user!.id;
  await tx(async (c) => {
    const del = await c.query(`DELETE FROM follows WHERE follower_id=$1 AND target_type=$2 AND target_id=$3 RETURNING 1`, [me, type, id]);
    if (del.rowCount) {
      await c.query(`UPDATE user_profiles SET following_count = greatest(following_count - 1, 0) WHERE user_id = $1`, [me]);
      await c.query(type === 'user' ? `UPDATE user_profiles SET follower_count = greatest(follower_count - 1, 0) WHERE user_id = $1` : `UPDATE businesses SET follower_count = greatest(follower_count - 1, 0) WHERE id = $1`, [id]);
    }
  });
  res.status(204).end();
}));

async function relationList(req: import('express').Request, res: import('express').Response, dir: 'followers' | 'following') {
  const { rows: t } = await pool.query(`SELECT u.id, p.privacy FROM users u JOIN user_profiles p ON p.user_id=u.id WHERE u.username=$1 AND u.status='active'`, [req.params.username]);
  if (!t[0]) throw notFound('Profile');
  if (dir === 'followers' && t[0].privacy?.show_followers === false && req.user?.id !== t[0].id) throw new HttpError(403, 'This list is private');
  const { rows } = await pool.query(
    dir === 'followers'
      ? `SELECT u.username, p.display_name, p.verification_level, (SELECT storage_key FROM media_assets WHERE id=p.avatar_media_id) AS avatar_key FROM follows f JOIN users u ON u.id=f.follower_id JOIN user_profiles p ON p.user_id=u.id WHERE f.target_type='user' AND f.target_id=$1 AND u.status='active' ORDER BY f.created_at DESC LIMIT 100`
      : `SELECT u.username, p.display_name, p.verification_level, (SELECT storage_key FROM media_assets WHERE id=p.avatar_media_id) AS avatar_key FROM follows f JOIN users u ON u.id=f.target_id JOIN user_profiles p ON p.user_id=u.id WHERE f.follower_id=$1 AND f.target_type='user' AND u.status='active' ORDER BY f.created_at DESC LIMIT 100`, [t[0].id]);
  res.json({ items: rows.map((r) => ({ username: r.username, display_name: r.display_name, verification_level: r.verification_level, avatar_url: avatar(r.avatar_key) })) });
}
users.get('/users/:username/followers', optionalAuth, wrap((req, res) => relationList(req, res, 'followers')));
users.get('/users/:username/following', optionalAuth, wrap((req, res) => relationList(req, res, 'following')));

// ---- blocking -----------------------------------------------------------
users.post('/blocks/:userId', requireAuth, wrap(async (req, res) => {
  const target = z.string().uuid().parse(req.params.userId);
  const me = req.user!.id;
  if (target === me) throw badRequest('You cannot block yourself');
  await tx(async (c) => {
    if (!(await c.query(`SELECT 1 FROM users WHERE id=$1`, [target])).rowCount) throw notFound('User');
    await c.query(`INSERT INTO blocks(blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [me, target]);
    for (const [a, b] of [[me, target], [target, me]]) {
      const d = await c.query(`DELETE FROM follows WHERE follower_id=$1 AND target_type='user' AND target_id=$2 RETURNING 1`, [a, b]);
      if (d.rowCount) {
        await c.query(`UPDATE user_profiles SET following_count = greatest(following_count-1,0) WHERE user_id=$1`, [a]);
        await c.query(`UPDATE user_profiles SET follower_count = greatest(follower_count-1,0) WHERE user_id=$1`, [b]);
      }
    }
  });
  res.status(204).end();
}));
users.delete('/blocks/:userId', requireAuth, wrap(async (req, res) => {
  await pool.query(`DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2`, [req.user!.id, z.string().uuid().parse(req.params.userId)]);
  res.status(204).end();
}));
users.get('/me/blocks', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT u.id, u.username, p.display_name FROM blocks b JOIN users u ON u.id=b.blocked_id JOIN user_profiles p ON p.user_id=u.id WHERE b.blocker_id=$1 ORDER BY b.created_at DESC`, [req.user!.id]);
  res.json({ items: rows });
}));
