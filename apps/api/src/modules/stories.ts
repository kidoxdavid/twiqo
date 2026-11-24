import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError, badRequest, forbidden, notFound, wrap } from '../lib/errors.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';
import { checkText, setting } from '../lib/policy.js';
import { videoUrls } from '../lib/video.js';
import { mediaUrl, thumbUrl } from '../lib/views.js';
import { can } from './business.js';
import { assertOwnsMedia } from './content.js';
import { audit } from '../lib/audit.js';

export const stories = Router();
const uuid = z.string().uuid();

/** A story is visible while active and unexpired, to everyone (public) or to followers only; never across a block. */
const VISIBLE = (a: string, viewer: string) => `(${a}.status='active' AND ${a}.expires_at > now()
  AND EXISTS (SELECT 1 FROM users su WHERE su.id=${a}.author_id AND su.status='active')
  AND (${a}.author_id=${viewer}::uuid OR ${a}.visibility='public' OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=${viewer}::uuid AND f.target_type='user' AND f.target_id=${a}.author_id))
  AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=${viewer}::uuid AND b.blocked_id=${a}.author_id) OR (b.blocker_id=${a}.author_id AND b.blocked_id=${viewer}::uuid))
  AND (${a}.video_id IS NULL OR EXISTS (SELECT 1 FROM videos v WHERE v.id=${a}.video_id AND v.status='ready')))`;

async function storyViews(ids: string[], viewer: string | null) {
  if (!ids.length) return new Map<string, any>();
  const { rows } = await pool.query(
    `SELECT s.*, u.username, p.display_name, (SELECT storage_key FROM media_assets WHERE id=p.avatar_media_id) AS avatar_key,
            (SELECT storage_key FROM media_assets WHERE id=s.media_id) AS media_key, v.provider, v.provider_video_id, v.duration_s,
            l.title AS link_title, b.name AS link_biz, b.slug AS link_slug,
            EXISTS (SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.viewer_id=$2) AS seen
     FROM stories s JOIN users u ON u.id=s.author_id JOIN user_profiles p ON p.user_id=u.id LEFT JOIN videos v ON v.id=s.video_id
     LEFT JOIN listings l ON s.link_type='listing' AND l.id=s.link_id LEFT JOIN businesses b ON s.link_type='business' AND b.id=s.link_id WHERE s.id = ANY($1::uuid[])`, [ids, viewer]);
  return new Map(rows.map((s) => [s.id, {
    id: s.id, kind: s.kind, text: s.text_body, bg: s.bg, created_at: s.created_at, expires_at: s.expires_at, seen: s.seen,
    image_url: s.media_key ? mediaUrl(s.media_key) : null,
    video: s.video_id ? { urls: videoUrls({ id: s.video_id, provider: s.provider, provider_video_id: s.provider_video_id }), duration_s: s.duration_s === null ? null : Number(s.duration_s) } : null,
    link: s.link_type === 'listing' ? { type: 'listing', id: s.link_id, label: s.link_title } : s.link_type === 'business' ? { type: 'business', slug: s.link_slug, label: s.link_biz } : null,
    author: { id: s.author_id, username: s.username, display_name: s.display_name, avatar_url: s.avatar_key ? thumbUrl(s.avatar_key) : null },
    view_count: viewer === s.author_id ? s.view_count : undefined,
  }]));
}

const createSchema = z.object({
  kind: z.enum(['photo', 'video', 'text']), media_id: uuid.optional(), video_id: uuid.optional(), text_body: z.string().trim().max(300).optional(), bg: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  link_type: z.enum(['listing', 'business']).optional(), link_id: uuid.optional(), visibility: z.enum(['public', 'followers']).default('public'), business_id: uuid.optional(),
});

stories.post('/stories', requireAuth, wrap(async (req, res) => {
  const b = createSchema.parse(req.body); const me = req.user!.id;
  if (b.kind === 'photo' && !b.media_id) throw badRequest('Choose a photo');
  if (b.kind === 'video' && !b.video_id) throw badRequest('Choose a video');
  if (b.kind === 'text' && !b.text_body) throw badRequest('Write something');
  if (!!b.link_type !== !!b.link_id) throw badRequest('Link is incomplete');
  await checkText(b.text_body);
  const hours = Number(await setting('story.expiry_hours', 24));
  const id = await tx(async (c) => {
    if (b.business_id && !(await can(b.business_id, me, 'manage_listings')) && !(await can(b.business_id, me, 'edit_profile'))) throw forbidden('You cannot post for this business');
    if (b.media_id) await assertOwnsMedia(c, me, [b.media_id]);
    if (b.video_id) { const v = (await c.query('SELECT status FROM videos WHERE id=$1 AND owner_id=$2', [b.video_id, me])).rows[0]; if (!v || ['failed', 'rejected', 'removed'].includes(v.status)) throw badRequest('That video is not available. Upload it again.'); }
    if (b.link_type === 'listing' && !(await c.query(`SELECT 1 FROM listings WHERE id=$1 AND status='active' AND visibility='public'`, [b.link_id])).rowCount) throw badRequest('That listing is not available');
    if (b.link_type === 'business' && !(await c.query(`SELECT 1 FROM businesses WHERE id=$1 AND status='active'`, [b.link_id])).rowCount) throw badRequest('That business is not available');
    const r = await c.query(`INSERT INTO stories(author_id,business_id,kind,media_id,video_id,text_body,bg,link_type,link_id,visibility,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' hours')::interval) RETURNING id`,
      [me, b.business_id ?? null, b.kind, b.media_id ?? null, b.video_id ?? null, b.text_body ?? null, b.bg ?? '#246BFD', b.link_type ?? null, b.link_id ?? null, b.visibility, String(hours)]);
    return r.rows[0].id as string;
  });
  res.status(201).json((await storyViews([id], me)).get(id));
}));

/** The story ring row: people I follow (and me) with active stories; unseen first. */
stories.get('/stories/tray', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  const { rows } = await pool.query(
    `SELECT s.author_id, u.username, p.display_name, (SELECT storage_key FROM media_assets WHERE id=p.avatar_media_id) AS avatar_key,
            count(*)::int AS n, max(s.created_at) AS latest, bool_and(EXISTS (SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.viewer_id=$1)) AS all_seen
     FROM stories s JOIN users u ON u.id=s.author_id JOIN user_profiles p ON p.user_id=u.id
     WHERE ${VISIBLE('s', '$1')} AND (s.author_id=$1 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.target_type='user' AND f.target_id=s.author_id))
     GROUP BY s.author_id, u.username, p.display_name, p.avatar_media_id
     ORDER BY (s.author_id=$1) DESC, bool_and(EXISTS (SELECT 1 FROM story_views sv WHERE sv.story_id=s.id AND sv.viewer_id=$1)) ASC, max(s.created_at) DESC LIMIT 50`, [me]);
  res.json({ items: rows.map((r) => ({ author: { id: r.author_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_key ? thumbUrl(r.avatar_key) : null }, count: r.n, latest_at: r.latest, all_seen: r.all_seen, is_me: r.author_id === me })) });
}));

stories.get('/stories/user/:username', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user?.id ?? null;
  const u = (await pool.query(`SELECT id FROM users WHERE username=$1 AND status='active'`, [String(req.params.username)])).rows[0]; if (!u) throw notFound('Profile');
  const { rows } = await pool.query(`SELECT s.id FROM stories s WHERE s.author_id=$1 AND ${VISIBLE('s', '$2')} ORDER BY s.created_at`, [u.id, viewer]);
  const m = await storyViews(rows.map((r) => r.id), viewer); res.json({ items: rows.map((r) => m.get(r.id)) });
}));

stories.post('/stories/:id/view', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const s = (await pool.query(`SELECT s.author_id FROM stories s WHERE s.id=$1 AND ${VISIBLE('s', '$2')}`, [id, me])).rows[0]; if (!s) throw notFound('Story');
  if (s.author_id !== me) {
    const ins = await pool.query(`INSERT INTO story_views(story_id,viewer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1`, [id, me]);
    if (ins.rowCount) await pool.query('UPDATE stories SET view_count = view_count + 1 WHERE id=$1', [id]);
  }
  res.status(204).end();
}));

/** Only the author sees who viewed. Viewers who blocked the author are not listed. */
stories.get('/stories/:id/viewers', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  const s = (await pool.query('SELECT author_id FROM stories WHERE id=$1', [id])).rows[0]; if (!s || s.author_id !== me) throw notFound('Story');
  const { rows } = await pool.query(`SELECT u.username, p.display_name, sv.viewed_at FROM story_views sv JOIN users u ON u.id=sv.viewer_id JOIN user_profiles p ON p.user_id=u.id
     WHERE sv.story_id=$1 AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=sv.viewer_id AND b.blocked_id=$2) ORDER BY sv.viewed_at DESC LIMIT 200`, [id, me]);
  res.json({ items: rows });
}));

stories.delete('/stories/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const me = req.user!.id;
  await tx(async (c) => {
    const s = (await c.query(`SELECT author_id FROM stories WHERE id=$1 AND status='active' FOR UPDATE`, [id])).rows[0]; if (!s) throw notFound('Story');
    const mod = req.user!.permissions.includes('moderate.content');
    if (s.author_id !== me && !mod) throw new HttpError(403, 'You cannot delete this story', 'forbidden');
    await c.query(`UPDATE stories SET status='removed' WHERE id=$1`, [id]);
    if (s.author_id !== me) await audit(c, me, 'story.remove', 'story', id, null, null, req.ip ?? null);
  });
  res.status(204).end();
}));
