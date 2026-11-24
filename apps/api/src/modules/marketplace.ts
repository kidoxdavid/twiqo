import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError, badRequest, forbidden, notFound, wrap } from '../lib/errors.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';
import { checkText, setting } from '../lib/policy.js';
import { resolvePlace } from '../lib/geo.js';
import { hydrateListings } from '../lib/hydrate.js';
import { can } from './business.js';
import { assertOwnsMedia } from './content.js';

export const marketplace = Router();
const uuid = z.string().uuid();

// ---- categories (public read; admin manages in admin module) -----------------------
marketplace.get('/categories', wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT id, parent_id, slug, name, icon, position, is_restricted FROM categories WHERE is_active ORDER BY position, name`);
  const roots = rows.filter((r) => !r.parent_id).map((r) => ({ ...r, children: rows.filter((c) => c.parent_id === r.id) }));
  res.json({ items: roots });
}));

// ---- create ---------------------------------------------------------------------------
const listingBody = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().max(8000).default(''),
  category_id: uuid,
  price_cents: z.number().int().min(0).max(100_000_000).default(0),
  price_type: z.enum(['fixed', 'negotiable', 'free']).default('fixed'),
  condition: z.enum(['new', 'like_new', 'good', 'fair', 'for_parts']).default('good'),
  quantity: z.number().int().min(1).max(10000).default(1),
  city: z.string().optional(), province: z.string().length(2).optional(),
  fulfillment: z.object({ pickup: z.boolean(), delivery: z.boolean(), shipping: z.boolean() }).default({ pickup: true, delivery: false, shipping: false }),
  tags: z.array(z.string().trim().toLowerCase().max(30)).max(10).default([]),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  visibility: z.enum(['public', 'followers']).default('public'),
  media_ids: z.array(uuid).max(20).default([]),
  business_id: uuid.optional(),
});

marketplace.post('/listings', requireAuth, wrap(async (req, res) => {
  const b = listingBody.parse(req.body);
  const uid = req.user!.id;
  if (b.price_type === 'free') b.price_cents = 0;
  else if (b.price_cents <= 0) throw badRequest('Set a price, or choose "Free"');
  const flagged = (await checkText(b.title)) || (await checkText(b.description)) || (await Promise.all(b.tags.map((t) => checkText(t)))).some(Boolean);
  const maxImages = Number(await setting('listing.max_images', 10));
  if (b.media_ids.length > maxImages) throw badRequest(`You can add up to ${maxImages} photos`);
  const reviewNew = (await setting('moderation.new_account_listing_review', false)) === true;
  const id = await tx(async (c) => {
    const cat = await c.query(`SELECT is_restricted FROM categories WHERE id=$1 AND is_active`, [b.category_id]);
    if (!cat.rowCount) throw badRequest('Choose a valid category');
    if (b.business_id && !(await can(b.business_id, uid, 'manage_listings'))) throw forbidden('You cannot list for this business');
    await assertOwnsMedia(c, uid, b.media_ids);
    const place = b.city ? await resolvePlace(b.city, b.province, c) : null;
    if (b.city && !place) throw badRequest('We could not find that city');
    const young = reviewNew && (await c.query(`SELECT 1 FROM users WHERE id=$1 AND created_at > now() - interval '7 days'`, [uid])).rowCount;
    const status = cat.rows[0].is_restricted || flagged || young ? 'pending_review' : 'active';
    const l = await c.query(
      `INSERT INTO listings(seller_id,business_id,category_id,title,description,price_cents,price_type,condition,quantity,status,city,province,location,fulfillment,tags,attributes,visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         coalesce($11,(SELECT city FROM user_profiles WHERE user_id=$1)), coalesce($12,(SELECT province FROM user_profiles WHERE user_id=$1)),
         CASE WHEN $13::float8 IS NULL THEN (SELECT location FROM user_profiles WHERE user_id=$1) ELSE ST_SetSRID(ST_MakePoint($13,$14),4326)::geography END,
         $15,$16,$17,$18) RETURNING id, location`,
      [uid, b.business_id ?? null, b.category_id, b.title, b.description, b.price_cents, b.price_type, b.condition, b.quantity, status,
        place?.city ?? null, place?.province ?? null, place?.lng ?? null, place?.lat ?? null,
        JSON.stringify(b.fulfillment), b.tags, JSON.stringify(b.attributes), b.visibility]);
    for (const [i, m] of b.media_ids.entries()) await c.query(`INSERT INTO listing_media(listing_id,media_id,position) VALUES ($1,$2,$3)`, [l.rows[0].id, m, i]);
    await c.query(`INSERT INTO feed_items(item_type,item_id,author_id,business_id,visibility,status,location) VALUES ('listing',$1,$2,$3,$4,$5,$6)`,
      [l.rows[0].id, uid, b.business_id ?? null, b.visibility, status === 'active' ? 'active' : 'pending', l.rows[0].location]);
    return l.rows[0].id as string;
  });
  const out = (await hydrateListings([id], uid)).get(id);
  res.status(201).json(out);
}));

// ---- search / browse -------------------------------------------------------------------
const searchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().optional(),
  min_price: z.coerce.number().int().min(0).optional(), max_price: z.coerce.number().int().min(0).optional(),
  condition: z.string().optional(),
  city: z.string().optional(), province: z.string().length(2).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(),
  radius_km: z.coerce.number().min(1).max(5000).optional(),
  price_type: z.enum(['fixed', 'negotiable', 'free']).optional(),
  seller: z.string().optional(), business: z.string().optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'distance', 'relevance']).default('newest'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

marketplace.get('/listings', optionalAuth, wrap(async (req, res) => {
  const q = searchQuery.parse(req.query);
  const viewer = req.user?.id ?? null;
  let center: { lng: number; lat: number } | undefined;
  if (q.lat !== undefined && q.lng !== undefined) center = { lat: q.lat, lng: q.lng };
  else if (q.city) { const p = await resolvePlace(q.city, q.province); if (!p) throw badRequest('We could not find that city'); center = { lat: p.lat, lng: p.lng }; }
  if (q.sort === 'distance' && !center) throw badRequest('Choose a location to sort by distance');
  const radius = q.radius_km ?? (center ? Number(await setting('search.default_radius_km', 25)) : undefined);
  const offset = q.cursor ? Math.max(0, parseInt(Buffer.from(q.cursor, 'base64url').toString(), 10) || 0) : 0;

  const p: unknown[] = [viewer]; const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const where = [`l.status = 'active'`, `l.expires_at > now()`,
    `(l.visibility = 'public' OR l.seller_id = $1::uuid OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1::uuid AND f.target_type='user' AND f.target_id = l.seller_id))`,
    `EXISTS (SELECT 1 FROM users su WHERE su.id = l.seller_id AND su.status = 'active')`,
    `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1::uuid AND b.blocked_id = l.seller_id) OR (b.blocker_id = l.seller_id AND b.blocked_id = $1::uuid))`];
  let rank = '0';
  if (q.q) {
    const t = add(q.q);
    where.push(`(l.search_vector @@ websearch_to_tsquery('english', ${t}) OR l.title % ${t} OR l.title ILIKE '%' || ${t} || '%')`);
    rank = `(ts_rank(l.search_vector, websearch_to_tsquery('english', ${t})) + similarity(l.title, ${t}))`;
  }
  if (q.category) {
    const t = add(q.category);
    where.push(`l.category_id IN (SELECT id FROM categories WHERE slug = ${t} OR parent_id = (SELECT id FROM categories WHERE slug = ${t}))`);
  }
  if (q.min_price !== undefined) where.push(`l.price_cents >= ${add(q.min_price)}`);
  if (q.max_price !== undefined) where.push(`l.price_cents <= ${add(q.max_price)}`);
  if (q.condition) where.push(`l.condition = ANY(${add(q.condition.split(','))}::text[])`);
  if (q.price_type) where.push(`l.price_type = ${add(q.price_type)}`);
  if (q.business) where.push(`l.business_id = (SELECT id FROM businesses WHERE slug = ${add(q.business)})`);
  if (q.seller) where.push(`l.seller_id = (SELECT id FROM users WHERE username = ${add(q.seller)})`);
  let dist = 'NULL::float8';
  if (center) {
    const pt = `ST_SetSRID(ST_MakePoint(${add(center.lng)}::float8, ${add(center.lat)}::float8),4326)::geography`;
    dist = `ST_Distance(l.location, ${pt})`;
    if (radius) where.push(`ST_DWithin(l.location, ${pt}, ${add(radius * 1000)})`);
  }
  const order = { newest: 'l.created_at DESC, l.id', price_asc: 'l.price_cents ASC, l.id', price_desc: 'l.price_cents DESC, l.id', distance: `${dist} ASC, l.id`, relevance: `${rank} DESC, l.created_at DESC` }[q.sort];
  const sql = `SELECT l.id FROM listings l WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${q.limit + 1} OFFSET ${offset}`;
  const { rows } = await pool.query(sql, p);
  const more = rows.length > q.limit;
  const ids = rows.slice(0, q.limit).map((r) => r.id);
  const map = await hydrateListings(ids, viewer, center);
  res.json({ items: ids.map((i) => map.get(i)), next_cursor: more ? Buffer.from(String(offset + q.limit)).toString('base64url') : null });
}));

// ---- detail / update ----------------------------------------------------------------------
marketplace.get('/listings/:id', optionalAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const viewer = req.user?.id ?? null;
  const { rows } = await pool.query(
    `SELECT l.description, l.attributes, l.expires_at, l.seller_id, l.business_id, l.status, l.visibility, l.category_id,
            (SELECT name FROM categories WHERE id = l.category_id) AS category_name
     FROM listings l WHERE l.id = $1
       AND EXISTS (SELECT 1 FROM users su WHERE su.id = l.seller_id AND su.status='active')
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $2::uuid AND b.blocked_id = l.seller_id) OR (b.blocker_id = l.seller_id AND b.blocked_id = $2::uuid))`, [id, viewer]);
  const r = rows[0];
  if (!r) throw notFound('Listing');
  const mine = viewer === r.seller_id || (r.business_id && viewer && (await can(r.business_id, viewer, 'manage_listings')));
  if (!mine && (!['active', 'reserved', 'sold'].includes(r.status) || r.visibility === 'private')) throw notFound('Listing');
  if (!mine && r.visibility === 'followers') {
    const f = viewer ? await pool.query(`SELECT 1 FROM follows WHERE follower_id=$1 AND target_type='user' AND target_id=$2`, [viewer, r.seller_id]) : null;
    if (!f?.rowCount) throw notFound('Listing');
  }
  if (!mine) await pool.query('UPDATE listings SET view_count = view_count + 1 WHERE id = $1', [id]);
  const base = (await hydrateListings([id], viewer)).get(id);
  res.json({ ...base, description: r.description, attributes: r.attributes, expires_at: r.expires_at, category: { id: r.category_id, name: r.category_name }, viewer: { ...base.viewer, is_owner: !!mine } });
}));

const patchSchema = listingBody.partial().extend({ status: z.enum(['draft', 'active', 'reserved', 'sold']).optional() });
marketplace.patch('/listings/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = patchSchema.parse(req.body);
  await checkText(b.title); await checkText(b.description);
  await tx(async (c) => {
    const { rows } = await c.query('SELECT seller_id, business_id, status, price_type FROM listings WHERE id=$1 FOR UPDATE', [id]);
    const l = rows[0];
    if (!l) throw notFound('Listing');
    const ok = l.seller_id === req.user!.id || (l.business_id && (await can(l.business_id, req.user!.id, 'manage_listings')));
    if (!ok) throw forbidden();
    if (['removed', 'pending_review'].includes(l.status)) throw new HttpError(409, 'This listing is under review or was removed', 'conflict');
    if (b.category_id && !(await c.query('SELECT 1 FROM categories WHERE id=$1 AND is_active', [b.category_id])).rowCount) throw badRequest('Choose a valid category');
    const sets: string[] = ['updated_at = now()']; const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.title !== undefined) set('title', b.title);
    if (b.description !== undefined) set('description', b.description);
    if (b.category_id !== undefined) set('category_id', b.category_id);
    if (b.price_type !== undefined) set('price_type', b.price_type);
    if (b.price_cents !== undefined || b.price_type === 'free') set('price_cents', b.price_type === 'free' ? 0 : b.price_cents);
    if (b.condition !== undefined) set('condition', b.condition);
    if (b.quantity !== undefined) set('quantity', b.quantity);
    if (b.fulfillment !== undefined) set('fulfillment', JSON.stringify(b.fulfillment));
    if (b.tags !== undefined) set('tags', b.tags);
    if (b.status !== undefined) set('status', b.status);
    await c.query(`UPDATE listings SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (b.status) await c.query(`UPDATE feed_items SET status = $2 WHERE item_type='listing' AND item_id = $1`, [id, b.status === 'draft' ? 'pending' : 'active']);
    if (b.media_ids) {
      await assertOwnsMedia(c, req.user!.id, b.media_ids);
      await c.query('DELETE FROM listing_media WHERE listing_id=$1', [id]);
      for (const [i, m] of b.media_ids.entries()) await c.query(`INSERT INTO listing_media(listing_id,media_id,position) VALUES ($1,$2,$3)`, [id, m, i]);
    }
  });
  res.json((await hydrateListings([id], req.user!.id)).get(id));
}));

marketplace.post('/listings/:id/renew', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const days = Number(await setting('listing.default_expiry_days', 30));
  const r = await pool.query(
    `UPDATE listings SET expires_at = now() + ($3 || ' days')::interval, status = CASE WHEN status='expired' THEN 'active' ELSE status END, updated_at = now()
     WHERE id=$1 AND seller_id=$2 AND status IN ('active','expired') RETURNING id`, [id, req.user!.id, String(days)]);
  if (!r.rowCount) throw notFound('Listing');
  await pool.query(`UPDATE feed_items SET status='active' WHERE item_type='listing' AND item_id=$1`, [id]);
  res.json({ ok: true });
}));

marketplace.delete('/listings/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows } = await c.query('SELECT seller_id, business_id FROM listings WHERE id=$1 FOR UPDATE', [id]);
    if (!rows[0]) throw notFound('Listing');
    if (rows[0].seller_id !== req.user!.id && !(rows[0].business_id && (await can(rows[0].business_id, req.user!.id, 'manage_listings')))) throw forbidden();
    await c.query(`UPDATE listings SET status='removed' WHERE id=$1`, [id]);
    await c.query(`UPDATE feed_items SET status='removed' WHERE item_type='listing' AND item_id=$1`, [id]);
  });
  res.status(204).end();
}));

marketplace.get('/users/:username/listings', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user?.id ?? null;
  const u = await pool.query(`SELECT id FROM users WHERE username=$1 AND status='active'`, [req.params.username]);
  if (!u.rows[0]) throw notFound('Profile');
  const isSelf = viewer === u.rows[0].id;
  const { rows } = await pool.query(
    `SELECT l.id FROM listings l WHERE l.seller_id=$1 AND ($3 OR (l.status IN ('active','reserved','sold') AND l.visibility='public'))
       AND l.status <> 'removed' AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=l.seller_id AND b.blocked_id=$2::uuid)
     ORDER BY l.created_at DESC LIMIT 60`, [u.rows[0].id, viewer, isSelf]);
  const map = await hydrateListings(rows.map((r) => r.id), viewer);
  res.json({ items: rows.map((r) => map.get(r.id)) });
}));
