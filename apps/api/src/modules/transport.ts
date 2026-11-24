import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { HttpError, badRequest, forbidden, notFound, wrap } from '../lib/errors.js';
import { optionalAuth, requireAuth } from '../lib/auth.js';
import { checkText, setting } from '../lib/policy.js';
import { requirePlace } from '../lib/geo.js';
import { hydrateJourneys, hydrateRequests, hydrateServices } from '../lib/hydrate.js';
import { journeysForRequest, requestsForJourney, servicesForRequest } from '../lib/matching.js';
import { notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { can } from './business.js';
import { assertOwnsMedia } from './content.js';
import { rejectOpenOffers } from './offers.js';
import { patchOf } from '../lib/validation.js';

export const transport = Router();
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const VEHICLES = ['car', 'suv', 'pickup_truck', 'cargo_van', 'box_truck', 'trailer', 'other'] as const;
const CATEGORIES = ['furniture', 'appliances', 'boxes', 'tires', 'bikes', 'equipment', 'building_materials', 'vehicle_parts', 'electronics', 'other'] as const;
const RESTRICTIONS = [...CATEGORIES, 'fragile'] as const;
const todayUtc = () => new Date().toISOString().slice(0, 10);

const notBlockedActive = (alias: string, owner: string, viewer: string) =>
  `EXISTS (SELECT 1 FROM users ou WHERE ou.id=${alias}.${owner} AND ou.status='active') AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id=${viewer}::uuid AND bl.blocked_id=${alias}.${owner}) OR (bl.blocker_id=${alias}.${owner} AND bl.blocked_id=${viewer}::uuid))`;

async function syncFeed(c: Db, type: 'transport_request' | 'journey' | 'transport_service', id: string, owner: string, business: string | null, visibility: string, live: boolean, locationSql: string) {
  await c.query(
    `INSERT INTO feed_items(item_type,item_id,author_id,business_id,visibility,status,location) VALUES ($1,$2,$3,$4,$5,$6,${locationSql})
     ON CONFLICT (item_type,item_id) DO UPDATE SET status=EXCLUDED.status, visibility=EXCLUDED.visibility`,
    [type, id, owner, business, visibility, live ? 'active' : 'pending']);
}
export const setFeedStatus = (c: Db, type: string, id: string, live: boolean) =>
  c.query(`UPDATE feed_items SET status=$3 WHERE item_type=$1 AND item_id=$2`, [type, id, live ? 'active' : 'pending']);

// ---- places for pickers -------------------------------------------------------------------------------------------
transport.get('/places', wrap(async (req, res) => {
  const q = z.string().trim().min(1).max(40).parse(req.query.q ?? '');
  const { rows } = await pool.query(`SELECT city, province FROM places WHERE city ILIKE $1||'%' OR city % $1 ORDER BY (city ILIKE $1||'%') DESC, city LIMIT 8`, [q]);
  res.json({ items: rows });
}));

// ============================================================================================ requests
const requestSchema = z.object({
  title: z.string().trim().min(3).max(120), description: z.string().max(4000).default(''),
  item_category: z.enum(CATEGORIES).default('other'), quantity: z.number().int().min(1).max(500).default(1),
  weight_kg: z.number().min(0.1).max(5000),
  length_cm: z.number().int().min(1).max(2000).optional(), width_cm: z.number().int().min(1).max(2000).optional(), height_cm: z.number().int().min(1).max(2000).optional(),
  fragile: z.boolean().default(false), special_handling: z.string().max(500).optional(),
  needs_loading_help: z.boolean().default(false), needs_unloading_help: z.boolean().default(false),
  origin_city: z.string().min(2), origin_province: z.string().length(2).optional(), pickup_area: z.string().max(100).optional(),
  dest_city: z.string().min(2), dest_province: z.string().length(2).optional(), delivery_area: z.string().max(100).optional(),
  pickup_from: date, pickup_to: date, deliver_by: date.optional(),
  budget_cents: z.number().int().min(0).max(10_000_000).optional(), price_type: z.enum(['fixed', 'negotiable']).default('negotiable'),
  preferred_vehicles: z.array(z.enum(VEHICLES)).max(7).default([]), visibility: z.enum(['public', 'private']).default('public'),
  media_ids: z.array(uuid).max(10).default([]), linked_listing_id: uuid.optional(), business_id: uuid.optional(),
});

function checkDates(from: string, to: string, by?: string | null) {
  if (to < from) throw badRequest('The pickup window must end on or after it starts');
  if (to < todayUtc()) throw badRequest('Pickup dates cannot be in the past');
  if (by && by < from) throw badRequest('The delivery deadline cannot be before pickup starts');
}

async function notifyMatchesForRequest(requestId: string) {
  try {
    const min = Number(await setting('transport.match_min_score', 55));
    const reqRow = (await pool.query('SELECT requester_id, title FROM transport_requests WHERE id=$1 AND visibility=\'public\'', [requestId])).rows[0];
    if (!reqRow) return;
    for (const m of (await journeysForRequest(requestId, 10)).filter((x) => x.score >= min)) {
      const j = (await pool.query('SELECT driver_id FROM journeys WHERE id=$1', [m.id])).rows[0];
      if (j) await notify(pool, { userId: j.driver_id, type: 'match', actorId: reqRow.requester_id, targetType: 'transport_request', targetId: requestId, data: { score: m.score, journey_id: m.id, title: reqRow.title }, dedupeKey: `${requestId}:${m.id}` });
    }
  } catch (e) { console.error('match notify failed', e); }
}
async function notifyMatchesForJourney(journeyId: string) {
  try {
    const min = Number(await setting('transport.match_min_score', 55));
    const j = (await pool.query('SELECT driver_id, origin_city, dest_city FROM journeys WHERE id=$1', [journeyId])).rows[0];
    for (const m of (await requestsForJourney(journeyId, 20)).filter((x) => x.score >= min)) {
      const r = (await pool.query('SELECT requester_id, title FROM transport_requests WHERE id=$1', [m.id])).rows[0];
      if (r) await notify(pool, { userId: r.requester_id, type: 'match', actorId: j.driver_id, targetType: 'journey', targetId: journeyId, data: { score: m.score, request_id: m.id, title: `${j.origin_city} → ${j.dest_city}` }, dedupeKey: `${m.id}:${journeyId}` });
    }
    const followers = (await pool.query(`SELECT follower_id FROM follows WHERE target_type='user' AND target_id=$1`, [j.driver_id])).rows;
    for (const f of followers) await notify(pool, { userId: f.follower_id, type: 'journey_posted', actorId: j.driver_id, targetType: 'journey', targetId: journeyId, data: { title: `${j.origin_city} → ${j.dest_city}` }, dedupeKey: journeyId });
  } catch (e) { console.error('journey notify failed', e); }
}

transport.post('/transport/requests', requireAuth, wrap(async (req, res) => {
  const b = requestSchema.parse(req.body); const uid = req.user!.id;
  checkDates(b.pickup_from, b.pickup_to, b.deliver_by);
  await checkText(b.title); await checkText(b.description); await checkText(b.special_handling); await checkText(b.pickup_area); await checkText(b.delivery_area);
  const id = await tx(async (c) => {
    const o = await requirePlace(b.origin_city, b.origin_province, c); const d = await requirePlace(b.dest_city, b.dest_province, c);
    if (b.business_id && !(await can(b.business_id, uid, 'delivery'))) throw forbidden('You cannot post for this business');
    await assertOwnsMedia(c, uid, b.media_ids);
    if (b.linked_listing_id && !(await c.query(`SELECT 1 FROM listings WHERE id=$1`, [b.linked_listing_id])).rowCount) throw badRequest('That listing was not found');
    const r = await c.query(
      `INSERT INTO transport_requests(requester_id,business_id,linked_listing_id,title,description,item_category,quantity,weight_kg,length_cm,width_cm,height_cm,fragile,special_handling,needs_loading_help,needs_unloading_help,
         origin_city,origin_province,origin,pickup_area,dest_city,dest_province,dest,delivery_area,pickup_from,pickup_to,deliver_by,budget_cents,price_type,preferred_vehicles,visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,ST_SetSRID(ST_MakePoint($18,$19),4326)::geography,$20,$21,$22,ST_SetSRID(ST_MakePoint($23,$24),4326)::geography,$25,$26,$27,$28,$29,$30,$31,$32) RETURNING id`,
      [uid, b.business_id ?? null, b.linked_listing_id ?? null, b.title, b.description, b.item_category, b.quantity, b.weight_kg, b.length_cm ?? null, b.width_cm ?? null, b.height_cm ?? null, b.fragile, b.special_handling ?? null, b.needs_loading_help, b.needs_unloading_help,
        o.city, o.province, o.lng, o.lat, b.pickup_area ?? null, d.city, d.province, d.lng, d.lat, b.delivery_area ?? null, b.pickup_from, b.pickup_to, b.deliver_by ?? null, b.budget_cents ?? null, b.price_type, b.preferred_vehicles, b.visibility]);
    for (const [i, m] of b.media_ids.entries()) await c.query('INSERT INTO transport_request_media(request_id,media_id,position) VALUES ($1,$2,$3)', [r.rows[0].id, m, i]);
    if (b.visibility === 'public') await syncFeed(c, 'transport_request', r.rows[0].id, uid, b.business_id ?? null, 'public', true, `(SELECT origin FROM transport_requests WHERE id='${r.rows[0].id}')`);
    return r.rows[0].id as string;
  });
  void notifyMatchesForRequest(id);
  res.status(201).json((await hydrateRequests([id], uid)).get(id));
}));

async function loadRequest(id: string, viewer: string | null) {
  const { rows } = await pool.query(
    `SELECT r.* FROM transport_requests r WHERE r.id=$1 AND ${viewer ? notBlockedActive('r', 'requester_id', '$2') : `EXISTS (SELECT 1 FROM users ou WHERE ou.id=r.requester_id AND ou.status='active') AND $2::uuid IS NULL`}`, [id, viewer]);
  const r = rows[0];
  if (!r) throw notFound('Request');
  const owner = viewer === r.requester_id;
  if (!owner) {
    const party = viewer ? (await pool.query(`SELECT 1 FROM offers WHERE request_id=$1 AND provider_id=$2 UNION SELECT 1 FROM bookings WHERE request_id=$1 AND transporter_id=$2`, [id, viewer])).rowCount : 0;
    if (!party && !(r.status === 'open' && r.visibility === 'public')) throw notFound('Request');
  }
  return r;
}

transport.get('/transport/requests/:id', optionalAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); await loadRequest(id, req.user?.id ?? null);
  res.json((await hydrateRequests([id], req.user?.id ?? null)).get(id));
}));

const browseBase = z.object({
  from: z.string().optional(), to: z.string().optional(), radius_km: z.coerce.number().min(1).max(3000).default(60),
  date_from: date.optional(), date_to: date.optional(), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().optional(),
});
const off = (c?: string) => (c ? Math.max(0, parseInt(Buffer.from(c, 'base64url').toString(), 10) || 0) : 0);
const nextCursor = (more: boolean, o: number, l: number) => (more ? Buffer.from(String(o + l)).toString('base64url') : null);

transport.get('/transport/requests', optionalAuth, wrap(async (req, res) => {
  const q = browseBase.extend({ category: z.enum(CATEGORIES).optional(), max_weight_kg: z.coerce.number().optional(), mine: z.enum(['1', 'true']).optional(), q: z.string().max(80).optional(), sort: z.enum(['soonest', 'newest', 'budget']).default('soonest') }).parse(req.query);
  const viewer = req.user?.id ?? null; const p: unknown[] = [viewer]; const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const where: string[] = [];
  if (q.mine) { if (!viewer) throw new HttpError(401, 'Sign in required', 'unauthorized'); where.push('r.requester_id = $1::uuid'); }
  else where.push(`r.status='open' AND r.visibility='public' AND r.pickup_to >= current_date AND ${notBlockedActive('r', 'requester_id', '$1')}`);
  if (q.from) { const pl = await requirePlace(q.from); where.push(`ST_DWithin(r.origin, ST_SetSRID(ST_MakePoint(${add(pl.lng)}::float8,${add(pl.lat)}::float8),4326)::geography, ${add(q.radius_km * 1000)})`); }
  if (q.to) { const pl = await requirePlace(q.to); where.push(`ST_DWithin(r.dest, ST_SetSRID(ST_MakePoint(${add(pl.lng)}::float8,${add(pl.lat)}::float8),4326)::geography, ${add(q.radius_km * 1000)})`); }
  if (q.date_from) where.push(`r.pickup_to >= ${add(q.date_from)}::date`);
  if (q.date_to) where.push(`r.pickup_from <= ${add(q.date_to)}::date`);
  if (q.category) where.push(`r.item_category = ${add(q.category)}`);
  if (q.max_weight_kg) where.push(`r.weight_kg * r.quantity <= ${add(q.max_weight_kg)}`);
  if (q.q) where.push(`r.search_vector @@ websearch_to_tsquery('english', ${add(q.q)})`);
  const order = { soonest: 'r.pickup_from, r.id', newest: 'r.created_at DESC, r.id', budget: 'r.budget_cents DESC NULLS LAST, r.id' }[q.sort]; const o = off(q.cursor);
  const { rows } = await pool.query(`SELECT r.id FROM transport_requests r WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${q.limit + 1} OFFSET ${o}`, p);
  const ids = rows.slice(0, q.limit).map((r) => r.id); const map = await hydrateRequests(ids, viewer);
  res.json({ items: ids.map((i) => map.get(i)), next_cursor: nextCursor(rows.length > q.limit, o, q.limit) });
}));

transport.patch('/transport/requests/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = patchOf(requestSchema.pick({ title: true, description: true, special_handling: true, budget_cents: true, price_type: true, visibility: true, preferred_vehicles: true, needs_loading_help: true, needs_unloading_help: true, pickup_from: true, pickup_to: true, deliver_by: true })).parse(req.body);
  await checkText(b.title); await checkText(b.description);
  await tx(async (c) => {
    const r = (await c.query('SELECT * FROM transport_requests WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!r || r.requester_id !== req.user!.id) throw notFound('Request');
    if (r.status !== 'open') throw new HttpError(409, 'Only open requests can be edited', 'conflict');
    const from = b.pickup_from ?? r.pickup_from.toISOString().slice(0, 10); const to = b.pickup_to ?? r.pickup_to.toISOString().slice(0, 10);
    checkDates(from, to, b.deliver_by ?? r.deliver_by?.toISOString().slice(0, 10));
    const sets: string[] = []; const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k}=$${vals.length}`); }
    if (sets.length) await c.query(`UPDATE transport_requests SET ${sets.join(',')} WHERE id=$1`, vals);
    if (b.visibility) await c.query(`UPDATE feed_items SET visibility=$2, status=$3 WHERE item_type='transport_request' AND item_id=$1`, [id, b.visibility, b.visibility === 'public' ? 'active' : 'pending']);
  });
  res.json((await hydrateRequests([id], req.user!.id)).get(id));
}));

transport.delete('/transport/requests/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const r = (await c.query('SELECT requester_id, status FROM transport_requests WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!r || r.requester_id !== req.user!.id) throw notFound('Request');
    if (r.status === 'booked') throw new HttpError(409, 'This request has a booking. Cancel the booking first.', 'conflict');
    if (!['open'].includes(r.status)) throw new HttpError(409, 'This request is already closed', 'conflict');
    await c.query(`UPDATE transport_requests SET status='cancelled' WHERE id=$1`, [id]);
    await setFeedStatus(c, 'transport_request', id, false);
    await rejectOpenOffers(c, { requestId: id }, req.user!.id, 'The request was cancelled');
  });
  res.status(204).end();
}));

transport.get('/transport/requests/:id/matches', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const r = (await pool.query('SELECT requester_id, status FROM transport_requests WHERE id=$1', [id])).rows[0];
  if (!r || r.requester_id !== req.user!.id) throw notFound('Request');
  const js = await journeysForRequest(id, 20); const ss = await servicesForRequest(id, 20);
  const jm = await hydrateJourneys(js.map((m) => m.id), req.user!.id); const sm = await hydrateServices(ss.map((m) => m.id), req.user!.id);
  const shape = (m: any) => ({ score: m.score, level: m.level, reasons: m.reasons, warnings: m.warnings, metrics: m.metrics });
  res.json({ journeys: js.map((m) => ({ match: shape(m), journey: jm.get(m.id) })), services: ss.map((m) => ({ match: shape(m), service: sm.get(m.id) })) });
}));

// ============================================================================================ journeys
const wp = z.object({ city: z.string().min(2), province: z.string().length(2).optional() });
const journeySchema = z.object({
  origin_city: z.string().min(2), origin_province: z.string().length(2).optional(), dest_city: z.string().min(2), dest_province: z.string().length(2).optional(),
  waypoints: z.array(wp).max(8).default([]), max_detour_km: z.number().int().min(0).max(500).default(15),
  departure_at: z.string().datetime(), arrival_at: z.string().datetime().optional(),
  vehicle_type: z.enum(VEHICLES), capacity_kg: z.number().int().min(1).max(30000), capacity_m3: z.number().min(0.1).max(200).optional(),
  max_length_cm: z.number().int().min(1).max(2000).optional(), max_width_cm: z.number().int().min(1).max(500).optional(), max_height_cm: z.number().int().min(1).max(500).optional(),
  item_restrictions: z.array(z.enum(RESTRICTIONS)).default([]), price_cents: z.number().int().min(0).max(10_000_000), price_type: z.enum(['fixed', 'negotiable']).default('negotiable'),
  pickup_preferences: z.string().max(500).optional(), delivery_preferences: z.string().max(500).optional(), helps_loading: z.boolean().default(false),
  description: z.string().max(4000).default(''), business_id: uuid.optional(),
});

transport.post('/transport/journeys', requireAuth, wrap(async (req, res) => {
  const b = journeySchema.parse(req.body); const uid = req.user!.id;
  if (new Date(b.departure_at).getTime() < Date.now()) throw badRequest('Departure must be in the future');
  if (b.arrival_at && new Date(b.arrival_at) <= new Date(b.departure_at)) throw badRequest('Arrival must be after departure');
  await checkText(b.description);
  const id = await tx(async (c) => {
    const o = await requirePlace(b.origin_city, b.origin_province, c); const d = await requirePlace(b.dest_city, b.dest_province, c);
    const wps = []; for (const w of b.waypoints) wps.push(await requirePlace(w.city, w.province, c));
    if (b.business_id && !(await can(b.business_id, uid, 'delivery'))) throw forbidden('You cannot post for this business');
    const pts = [o, ...wps, d];
    if (pts.length === 2 && o.lat === d.lat && o.lng === d.lng) throw badRequest('Origin and destination must be different. For local moves, offer a service instead.');
    const wkt = `LINESTRING(${pts.map((p) => `${p.lng} ${p.lat}`).join(', ')})`;
    const r = await c.query(
      `INSERT INTO journeys(driver_id,business_id,description,origin_city,origin_province,origin,dest_city,dest_province,dest,waypoints,route,distance_km,max_detour_km,departure_at,arrival_at,vehicle_type,
         capacity_kg,capacity_m3,remaining_kg,remaining_m3,max_length_cm,max_width_cm,max_height_cm,item_restrictions,price_cents,price_type,pickup_preferences,delivery_preferences,helps_loading)
       VALUES ($1,$2,$3,$4,$5,ST_SetSRID(ST_MakePoint($6,$7),4326)::geography,$8,$9,ST_SetSRID(ST_MakePoint($10,$11),4326)::geography,$12,ST_GeogFromText($13),
         round(ST_Length(ST_GeogFromText($13))/1000),$14,$15,$16,$17,$18,$19,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING id`,
      [uid, b.business_id ?? null, b.description, o.city, o.province, o.lng, o.lat, d.city, d.province, d.lng, d.lat, JSON.stringify(wps.map((w) => ({ city: w.city, province: w.province, lat: w.lat, lng: w.lng }))), `SRID=4326;${wkt}`,
        b.max_detour_km, b.departure_at, b.arrival_at ?? null, b.vehicle_type, b.capacity_kg, b.capacity_m3 ?? null, b.max_length_cm ?? null, b.max_width_cm ?? null, b.max_height_cm ?? null,
        b.item_restrictions, b.price_cents, b.price_type, b.pickup_preferences ?? null, b.delivery_preferences ?? null, b.helps_loading]);
    await syncFeed(c, 'journey', r.rows[0].id, uid, b.business_id ?? null, 'public', true, `(SELECT origin FROM journeys WHERE id='${r.rows[0].id}')`);
    return r.rows[0].id as string;
  });
  void notifyMatchesForJourney(id);
  res.status(201).json((await hydrateJourneys([id], uid)).get(id));
}));

async function loadJourney(id: string, viewer: string | null) {
  const { rows } = await pool.query(`SELECT j.* FROM journeys j WHERE j.id=$1 AND ${viewer ? notBlockedActive('j', 'driver_id', '$2') : `EXISTS (SELECT 1 FROM users ou WHERE ou.id=j.driver_id AND ou.status='active') AND $2::uuid IS NULL`}`, [id, viewer]);
  const j = rows[0];
  if (!j) throw notFound('Journey');
  if (viewer !== j.driver_id && !['open', 'full', 'departed'].includes(j.status)) throw notFound('Journey');
  return j;
}
transport.get('/transport/journeys/:id', optionalAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); await loadJourney(id, req.user?.id ?? null);
  res.json((await hydrateJourneys([id], req.user?.id ?? null)).get(id));
}));

transport.get('/transport/journeys', optionalAuth, wrap(async (req, res) => {
  const q = browseBase.extend({ vehicle: z.enum(VEHICLES).optional(), min_capacity_kg: z.coerce.number().optional(), mine: z.enum(['1', 'true']).optional(), driver: z.string().optional(), sort: z.enum(['departure', 'price', 'newest']).default('departure') }).parse(req.query);
  const viewer = req.user?.id ?? null; const p: unknown[] = [viewer]; const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const where: string[] = [];
  if (q.mine) { if (!viewer) throw new HttpError(401, 'Sign in required', 'unauthorized'); where.push('j.driver_id = $1::uuid'); }
  else where.push(`j.status = 'open' AND j.departure_at > now() AND ${notBlockedActive('j', 'driver_id', '$1')}`);
  let a: string | null = null, z2: string | null = null;
  if (q.from) { const pl = await requirePlace(q.from); a = `ST_SetSRID(ST_MakePoint(${add(pl.lng)}::float8,${add(pl.lat)}::float8),4326)`; where.push(`ST_DWithin(j.route, ${a}::geography, ${add(q.radius_km * 1000)})`); }
  if (q.to) { const pl = await requirePlace(q.to); z2 = `ST_SetSRID(ST_MakePoint(${add(pl.lng)}::float8,${add(pl.lat)}::float8),4326)`; where.push(`ST_DWithin(j.route, ${z2}::geography, ${add(q.radius_km * 1000)})`); }
  if (a && z2) where.push(`ST_LineLocatePoint(j.route::geometry, ${a}) < ST_LineLocatePoint(j.route::geometry, ${z2})`);   // the driver passes your pickup BEFORE your drop-off
  if (q.date_from) where.push(`j.departure_at >= ${add(q.date_from)}::date`);
  if (q.date_to) where.push(`j.departure_at < ${add(q.date_to)}::date + 1`);
  if (q.vehicle) where.push(`j.vehicle_type = ${add(q.vehicle)}`);
  if (q.min_capacity_kg) where.push(`j.remaining_kg >= ${add(q.min_capacity_kg)}`);
  if (q.driver) where.push(`j.driver_id = (SELECT id FROM users WHERE username = ${add(q.driver)})`);
  const order = { departure: 'j.departure_at, j.id', price: 'j.price_cents, j.id', newest: 'j.created_at DESC, j.id' }[q.sort]; const o = off(q.cursor);
  const { rows } = await pool.query(`SELECT j.id FROM journeys j WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${q.limit + 1} OFFSET ${o}`, p);
  const ids = rows.slice(0, q.limit).map((r) => r.id); const map = await hydrateJourneys(ids, viewer);
  res.json({ items: ids.map((i) => map.get(i)), next_cursor: nextCursor(rows.length > q.limit, o, q.limit) });
}));

transport.patch('/transport/journeys/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = patchOf(journeySchema.pick({ description: true, price_cents: true, price_type: true, max_detour_km: true, item_restrictions: true, pickup_preferences: true, delivery_preferences: true, helps_loading: true, capacity_kg: true, arrival_at: true, departure_at: true })).parse(req.body);
  await checkText(b.description);
  await tx(async (c) => {
    const j = (await c.query('SELECT * FROM journeys WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!j || j.driver_id !== req.user!.id) throw notFound('Journey');
    if (!['open', 'full'].includes(j.status)) throw new HttpError(409, 'This journey can no longer be edited', 'conflict');
    const booked = (await c.query(`SELECT count(*)::int n FROM bookings WHERE journey_id=$1 AND status <> 'cancelled'`, [id])).rows[0].n;
    if (b.departure_at && booked) throw new HttpError(409, 'Departure time cannot change once there are bookings', 'conflict');
    const sets: string[] = []; const vals: unknown[] = [id]; const set = (k: string, v: unknown) => { vals.push(v); sets.push(`${k}=$${vals.length}`); };
    for (const [k, v] of Object.entries(b)) if (k !== 'capacity_kg') set(k, v);
    if (b.capacity_kg !== undefined) {
      const reserved = j.capacity_kg - j.remaining_kg; if (b.capacity_kg < reserved) throw new HttpError(409, `${reserved} kg is already reserved by bookings`, 'conflict');
      set('capacity_kg', b.capacity_kg); set('remaining_kg', b.capacity_kg - reserved);
    }
    if (sets.length) await c.query(`UPDATE journeys SET ${sets.join(',')} WHERE id=$1`, vals);
    const after = (await c.query('SELECT remaining_kg FROM journeys WHERE id=$1', [id])).rows[0];
    await c.query(`UPDATE journeys SET status = CASE WHEN remaining_kg = 0 THEN 'full' ELSE 'open' END WHERE id=$1`, [id]);
    await setFeedStatus(c, 'journey', id, after.remaining_kg > 0);
  });
  res.json((await hydrateJourneys([id], req.user!.id)).get(id));
}));

transport.post('/transport/journeys/:id/depart', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const j = (await c.query('SELECT driver_id, status FROM journeys WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!j || j.driver_id !== req.user!.id) throw notFound('Journey');
    if (!['open', 'full'].includes(j.status)) throw new HttpError(409, 'Already departed or closed', 'conflict');
    await c.query(`UPDATE journeys SET status='departed' WHERE id=$1`, [id]); await setFeedStatus(c, 'journey', id, false);
    await rejectOpenOffers(c, { journeyId: id }, req.user!.id, 'The journey has departed');
  });
  res.status(204).end();
}));

transport.delete('/transport/journeys/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const j = (await c.query('SELECT driver_id, status FROM journeys WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!j || j.driver_id !== req.user!.id) throw notFound('Journey');
    if ((await c.query(`SELECT 1 FROM bookings WHERE journey_id=$1 AND status NOT IN ('cancelled','completed')`, [id])).rowCount) throw new HttpError(409, 'This journey has active bookings. Cancel them first.', 'conflict');
    await c.query(`UPDATE journeys SET status='cancelled' WHERE id=$1`, [id]); await setFeedStatus(c, 'journey', id, false);
    await rejectOpenOffers(c, { journeyId: id }, req.user!.id, 'The journey was cancelled');
  });
  res.status(204).end();
}));

transport.get('/transport/journeys/:id/matches', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const j = (await pool.query('SELECT driver_id FROM journeys WHERE id=$1', [id])).rows[0];
  if (!j || j.driver_id !== req.user!.id) throw notFound('Journey');
  const ms = await requestsForJourney(id, 30); const map = await hydrateRequests(ms.map((m) => m.id), req.user!.id);
  res.json({ requests: ms.map((m) => ({ match: { score: m.score, level: m.level, reasons: m.reasons, warnings: m.warnings, metrics: m.metrics }, request: map.get(m.id) })) });
}));

// ============================================================================================ services
const serviceSchema = z.object({
  title: z.string().trim().min(3).max(120), description: z.string().max(4000).default(''), vehicle_type: z.enum(VEHICLES),
  service_city: z.string().min(2), service_province: z.string().length(2).optional(), service_radius_km: z.number().int().min(1).max(5000).default(30), intercity: z.boolean().default(false),
  capacity_kg: z.number().int().min(1).max(30000), max_length_cm: z.number().int().min(1).max(2000).optional(), max_width_cm: z.number().int().min(1).max(500).optional(), max_height_cm: z.number().int().min(1).max(500).optional(),
  helps_loading: z.boolean().default(false), item_restrictions: z.array(z.enum(RESTRICTIONS)).default([]),
  pricing_model: z.enum(['flat', 'hourly', 'per_km']).default('flat'), price_cents: z.number().int().min(0).max(10_000_000), price_type: z.enum(['fixed', 'negotiable']).default('negotiable'),
  business_id: uuid.optional(),
});

transport.post('/transport/services', requireAuth, wrap(async (req, res) => {
  const b = serviceSchema.parse(req.body); const uid = req.user!.id;
  await checkText(b.title); await checkText(b.description);
  const id = await tx(async (c) => {
    const pl = await requirePlace(b.service_city, b.service_province, c);
    if (b.business_id && !(await can(b.business_id, uid, 'delivery'))) throw forbidden('You cannot post for this business');
    const r = await c.query(
      `INSERT INTO transport_services(provider_id,business_id,title,description,vehicle_type,service_city,service_province,service_center,service_radius_km,intercity,capacity_kg,max_length_cm,max_width_cm,max_height_cm,helps_loading,item_restrictions,pricing_model,price_cents,price_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,ST_SetSRID(ST_MakePoint($8,$9),4326)::geography,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [uid, b.business_id ?? null, b.title, b.description, b.vehicle_type, pl.city, pl.province, pl.lng, pl.lat, b.service_radius_km, b.intercity, b.capacity_kg, b.max_length_cm ?? null, b.max_width_cm ?? null, b.max_height_cm ?? null, b.helps_loading, b.item_restrictions, b.pricing_model, b.price_cents, b.price_type]);
    await syncFeed(c, 'transport_service', r.rows[0].id, uid, b.business_id ?? null, 'public', true, `(SELECT service_center FROM transport_services WHERE id='${r.rows[0].id}')`);
    return r.rows[0].id as string;
  });
  res.status(201).json((await hydrateServices([id], uid)).get(id));
}));

transport.get('/transport/services/:id', optionalAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const viewer = req.user?.id ?? null;
  const s = (await pool.query(`SELECT provider_id, status FROM transport_services WHERE id=$1 AND EXISTS (SELECT 1 FROM users u WHERE u.id=provider_id AND u.status='active')
     AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id=$2::uuid AND bl.blocked_id=provider_id) OR (bl.blocker_id=provider_id AND bl.blocked_id=$2::uuid))`, [id, viewer])).rows[0];
  if (!s || (s.status !== 'active' && s.status !== 'paused' && viewer !== s.provider_id) || (s.status === 'removed' && viewer !== s.provider_id)) throw notFound('Service');
  res.json((await hydrateServices([id], viewer)).get(id));
}));

transport.get('/transport/services', optionalAuth, wrap(async (req, res) => {
  const q = z.object({ city: z.string().optional(), vehicle: z.enum(VEHICLES).optional(), mine: z.enum(['1', 'true']).optional(), provider: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().optional() }).parse(req.query);
  const viewer = req.user?.id ?? null; const p: unknown[] = [viewer]; const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const where: string[] = [];
  if (q.mine) { if (!viewer) throw new HttpError(401, 'Sign in required', 'unauthorized'); where.push(`s.provider_id=$1::uuid AND s.status <> 'removed'`); }
  else where.push(`s.status='active' AND ${notBlockedActive('s', 'provider_id', '$1')}`);
  if (q.city) { const pl = await requirePlace(q.city); where.push(`ST_DWithin(s.service_center, ST_SetSRID(ST_MakePoint(${add(pl.lng)}::float8,${add(pl.lat)}::float8),4326)::geography, s.service_radius_km*1000)`); }
  if (q.vehicle) where.push(`s.vehicle_type=${add(q.vehicle)}`);
  if (q.provider) where.push(`s.provider_id = (SELECT id FROM users WHERE username=${add(q.provider)})`);
  const o = off(q.cursor);
  const { rows } = await pool.query(`SELECT s.id FROM transport_services s WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id LIMIT ${q.limit + 1} OFFSET ${o}`, p);
  const ids = rows.slice(0, q.limit).map((r) => r.id); const map = await hydrateServices(ids, viewer);
  res.json({ items: ids.map((i) => map.get(i)), next_cursor: nextCursor(rows.length > q.limit, o, q.limit) });
}));

transport.patch('/transport/services/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = patchOf(serviceSchema.pick({ title: true, description: true, price_cents: true, price_type: true, pricing_model: true, service_radius_km: true, intercity: true, helps_loading: true, item_restrictions: true, capacity_kg: true })).extend({ status: z.enum(['active', 'paused']).optional() }).parse(req.body);
  await checkText(b.title); await checkText(b.description);
  await tx(async (c) => {
    const s = (await c.query('SELECT provider_id FROM transport_services WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!s || s.provider_id !== req.user!.id) throw notFound('Service');
    const sets: string[] = []; const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) { vals.push(v); sets.push(`${k}=$${vals.length}`); }
    if (sets.length) await c.query(`UPDATE transport_services SET ${sets.join(',')} WHERE id=$1`, vals);
    if (b.status) await setFeedStatus(c, 'transport_service', id, b.status === 'active');
  });
  res.json((await hydrateServices([id], req.user!.id)).get(id));
}));

transport.delete('/transport/services/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const s = (await c.query('SELECT provider_id FROM transport_services WHERE id=$1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!s || s.provider_id !== req.user!.id) throw notFound('Service');
    if ((await c.query(`SELECT 1 FROM bookings WHERE service_id=$1 AND status NOT IN ('cancelled','completed')`, [id])).rowCount) throw new HttpError(409, 'This service has active bookings', 'conflict');
    await c.query(`UPDATE transport_services SET status='removed' WHERE id=$1`, [id]); await setFeedStatus(c, 'transport_service', id, false);
    await rejectOpenOffers(c, { serviceId: id }, req.user!.id, 'The service was removed');
  });
  res.status(204).end();
}));

// ============================================================================================ transporter profile
transport.get('/users/:username/transport', optionalAuth, wrap(async (req, res) => {
  const viewer = req.user?.id ?? null;
  const u = (await pool.query(`SELECT u.id, p.privacy FROM users u JOIN user_profiles p ON p.user_id=u.id WHERE u.username=$1 AND u.status='active'
     AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=u.id AND b.blocked_id=$2::uuid)`, [req.params.username, viewer])).rows[0];
  if (!u) throw notFound('Profile');
  const stats = (await pool.query(
    `SELECT (SELECT count(*) FROM bookings WHERE transporter_id=$1 AND status='completed')::int AS completed_as_transporter,
            (SELECT count(*) FROM bookings WHERE shipper_id=$1 AND status='completed')::int AS completed_as_shipper,
            (SELECT count(*) FROM bookings WHERE transporter_id=$1 AND status='cancelled' AND cancelled_by=$1)::int AS cancelled_by_them,
            (SELECT round(avg(rating)::numeric,2) FROM reviews WHERE reviewee_id=$1 AND role='transporter' AND status='active') AS rating_avg,
            (SELECT count(*) FROM reviews WHERE reviewee_id=$1 AND role='transporter' AND status='active')::int AS rating_count`, [u.id])).rows[0];
  const show = viewer === u.id || u.privacy?.show_transport_history === true;
  const js = (await pool.query(`SELECT id FROM journeys WHERE driver_id=$1 AND status IN ('open','full') AND departure_at > now() ORDER BY departure_at LIMIT 10`, [u.id])).rows.map((r) => r.id);
  const ss = (await pool.query(`SELECT id FROM transport_services WHERE provider_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 10`, [u.id])).rows.map((r) => r.id);
  const jm = await hydrateJourneys(js, viewer); const sm = await hydrateServices(ss, viewer);
  res.json({
    stats: { rating_avg: stats.rating_avg === null ? null : Number(stats.rating_avg), rating_count: stats.rating_count, ...(show ? { completed_as_transporter: stats.completed_as_transporter, completed_as_shipper: stats.completed_as_shipper, cancelled_by_them: stats.cancelled_by_them } : {}) },
    history_visible: show, upcoming_journeys: js.map((i) => jm.get(i)), services: ss.map((i) => sm.get(i)),
  });
}));

void audit;
