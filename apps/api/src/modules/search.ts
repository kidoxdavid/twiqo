import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { wrap } from '../lib/errors.js';
import { optionalAuth } from '../lib/auth.js';
import { thumbUrl } from '../lib/views.js';

export const search = Router();

/** Search provider seam: today PostgreSQL trigram/FTS, later swap for OpenSearch behind the same response shape. */
search.get('/search/people', optionalAuth, wrap(async (req, res) => {
  const { q } = z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query);
  const viewer = req.user?.id ?? null;
  const people = await pool.query(
    `SELECT u.id, u.username, p.display_name, p.verification_level, p.follower_count, (SELECT storage_key FROM media_assets WHERE id=p.avatar_media_id) AS avatar_key
     FROM users u JOIN user_profiles p ON p.user_id=u.id
     WHERE u.status='active' AND (p.display_name ILIKE '%'||$1||'%' OR u.username::text ILIKE $1||'%' OR p.display_name % $1)
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$2::uuid AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=$2::uuid))
     ORDER BY similarity(p.display_name, $1) DESC, p.follower_count DESC LIMIT 20`, [q, viewer]);
  const biz = await pool.query(`SELECT id, name, slug, city, province, verification_status FROM businesses WHERE status='active' AND (name ILIKE '%'||$1||'%') ORDER BY follower_count DESC LIMIT 10`, [q]);
  res.json({ people: people.rows.map((r) => ({ id: r.id, username: r.username, display_name: r.display_name, verification_level: r.verification_level, followers: r.follower_count, avatar_url: r.avatar_key ? thumbUrl(r.avatar_key) : null })), businesses: biz.rows });
}));
