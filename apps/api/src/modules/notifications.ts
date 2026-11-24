import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { setting } from '../lib/policy.js';
import { requirePlace } from '../lib/geo.js';
import { notify, NOTIFICATION_TYPES } from '../lib/notify.js';
import { enqueue, registerJob } from '../lib/queue.js';
import { channelEnabled, readUnsubscribeToken } from '../lib/delivery.js';
import { pushSender } from '../lib/push.js';

export const notifications = Router();
const uuid = z.string().uuid();

// ---------------------------------------------------------------------------------------------- web push
notifications.get('/push/config', (_req, res) => { const s = pushSender(); res.json({ enabled: s.enabled, public_key: s.publicKey() }); });
notifications.post('/push/subscribe', requireAuth, wrap(async (req, res) => {
  const b = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }).parse(req.body);
  if (!pushSender().enabled) throw conflict('Push notifications are not set up on this server');
  await pool.query(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, failures=0`, [req.user!.id, b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200)]);
  res.status(204).end();
}));
notifications.delete('/push/subscribe', requireAuth, wrap(async (req, res) => {
  const b = z.object({ endpoint: z.string().url() }).parse(req.body);
  await pool.query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [req.user!.id, b.endpoint]); res.status(204).end();
}));

// ---------------------------------------------------------------------------------------------- channel preferences and unsubscribe
notifications.get('/me/notification-channels', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const off = (await pool.query('SELECT email_notifications_off, email_verified_at FROM users WHERE id=$1', [me])).rows[0];
  const items = await Promise.all(NOTIFICATION_TYPES.map(async (t) => ({ ...t, email: await channelEnabled(pool, me, t.type, 'email'), push: await channelEnabled(pool, me, t.type, 'push') })));
  res.json({ email_notifications_off: off.email_notifications_off, email_verified: !!off.email_verified_at, push_enabled_on_server: pushSender().enabled, push_devices: (await pool.query('SELECT count(*)::int n FROM push_subscriptions WHERE user_id=$1', [me])).rows[0].n, items });
}));
notifications.put('/me/notification-channels', requireAuth, wrap(async (req, res) => {
  const b = z.object({ type: z.string().max(40), channel: z.enum(['email', 'push']), enabled: z.boolean() }).parse(req.body);
  if (!NOTIFICATION_TYPES.some((t) => t.type === b.type)) throw badRequest('Unknown notification type');
  await pool.query(`INSERT INTO notification_channels(user_id,type,channel,enabled) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,type,channel) DO UPDATE SET enabled=EXCLUDED.enabled`, [req.user!.id, b.type, b.channel, b.enabled]);
  res.status(204).end();
}));
notifications.put('/me/email-notifications', requireAuth, wrap(async (req, res) => {
  const b = z.object({ off: z.boolean() }).parse(req.body); await pool.query('UPDATE users SET email_notifications_off=$2 WHERE id=$1', [req.user!.id, b.off]); res.status(204).end();
}));
/** GET shows a confirmation page (link scanners follow GET links, so GET never changes anything); POST is the one-click unsubscribe mail clients use. */
notifications.get('/email/unsubscribe', (req, res) => {
  const t = String(req.query.t ?? ''); const ok = !!readUnsubscribeToken(t);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>twiqo</title><body style="font-family:system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 16px;color:#13203D"><h2 style="color:#246BFD">twiqo</h2>${ok
    ? `<p>Stop emailing you about offers, bookings and other notifications?</p><form method="post" action="/api/email/unsubscribe?t=${encodeURIComponent(t)}"><button style="background:#246BFD;color:#fff;border:0;padding:12px 20px;border-radius:12px;font-size:16px">Unsubscribe</button></form><p style="font-size:13px;color:#5B6784">You will still get essential account emails such as password resets and security alerts.</p>`
    : '<p>This unsubscribe link is not valid.</p>'}</body>`);
});
notifications.post('/email/unsubscribe', wrap(async (req, res) => {
  const id = readUnsubscribeToken(String(req.query.t ?? '')); if (!id) throw badRequest('This unsubscribe link is not valid');
  await pool.query('UPDATE users SET email_notifications_off=true WHERE id=$1', [id]);
  res.type('html').send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 16px"><h2 style="color:#246BFD">twiqo</h2><p>You are unsubscribed from notification emails. You can turn them back on in Settings.</p></body>');
}));

// ---------------------------------------------------------------------------------------------- saved searches
const listingParams = z.object({ q: z.string().trim().max(80).optional(), category: z.string().max(60).optional(), min_price: z.number().int().min(0).optional(), max_price: z.number().int().min(0).optional(), condition: z.string().max(60).optional(), city: z.string().max(80).optional(), radius_km: z.number().min(1).max(5000).optional() });
const corridorParams = z.object({ from: z.string().min(2).max(80), to: z.string().min(2).max(80), radius_km: z.number().min(5).max(500).default(60), earliest: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), latest: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const searchBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('listing'), name: z.string().trim().min(1).max(80), params: listingParams }),
  z.object({ kind: z.literal('journey'), name: z.string().trim().min(1).max(80), params: corridorParams }),
  z.object({ kind: z.literal('request'), name: z.string().trim().min(1).max(80), params: corridorParams }),
]);

notifications.get('/saved-searches', requireAuth, wrap(async (req, res) => {
  res.json({ items: (await pool.query(`SELECT id, kind, name, params, active, created_at, last_alert_at FROM saved_searches WHERE user_id=$1 ORDER BY created_at DESC`, [req.user!.id])).rows });
}));
notifications.post('/saved-searches', requireAuth, wrap(async (req, res) => {
  const b = searchBody.parse(req.body); const me = req.user!.id;
  const max = Number(await setting('saved_search.max_per_user', 20));
  if (Number((await pool.query('SELECT count(*)::int n FROM saved_searches WHERE user_id=$1', [me])).rows[0].n) >= max) throw conflict(`You can keep up to ${max} saved searches. Delete one to add another.`);
  const params: Record<string, unknown> = { ...b.params };
  if (b.kind === 'listing') { if (!Object.values(b.params).some((v) => v !== undefined && v !== '')) throw badRequest('Add a keyword or filter to save a search'); if (b.params.city) { const pl = await requirePlace(b.params.city); params.lng = pl.lng; params.lat = pl.lat; params.radius_km ??= 25; } }
  else { const f = await requirePlace(b.params.from); const t = await requirePlace(b.params.to); Object.assign(params, { from_lng: f.lng, from_lat: f.lat, to_lng: t.lng, to_lat: t.lat }); }
  const row = (await pool.query(`INSERT INTO saved_searches(user_id,kind,name,params) VALUES ($1,$2,$3,$4) RETURNING id, kind, name, params, active, created_at`, [me, b.kind, b.name, JSON.stringify(params)])).rows[0];
  res.status(201).json(row);
}));
notifications.patch('/saved-searches/:id', requireAuth, wrap(async (req, res) => {
  const b = z.object({ active: z.boolean().optional(), name: z.string().trim().min(1).max(80).optional() }).parse(req.body);
  const r = await pool.query(`UPDATE saved_searches SET active = coalesce($3, active), name = coalesce($4, name) WHERE id=$1 AND user_id=$2 RETURNING id, kind, name, params, active`, [uuid.parse(req.params.id), req.user!.id, b.active ?? null, b.name ?? null]);
  if (!r.rowCount) throw notFound('Saved search'); res.json(r.rows[0]);
}));
notifications.delete('/saved-searches/:id', requireAuth, wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM saved_searches WHERE id=$1 AND user_id=$2', [uuid.parse(req.params.id), req.user!.id]); if (!r.rowCount) throw notFound('Saved search'); res.status(204).end();
}));

/** Queue a match run for a newly published item. Cheap to call; the work happens in the job. */
export const queueSearchMatch = (kind: 'listing' | 'journey' | 'request', id: string) => enqueue(pool, 'match_saved_searches', { kind, id }, { dedupeKey: `ssm:${kind}:${id}` }).catch((e) => console.error('could not queue saved-search match', e.message));

async function listingMatches(id: string, p: any) {
  const a: unknown[] = [id]; const add = (v: unknown) => { a.push(v); return `$${a.length}`; }; const w: string[] = ['l.id = $1', `l.status='active'`, `l.visibility='public'`, 'l.expires_at > now()'];
  if (p.q) w.push(`l.search_vector @@ websearch_to_tsquery('english', ${add(p.q)})`);
  if (p.category) { const c = add(p.category); w.push(`l.category_id IN (SELECT id FROM categories WHERE slug = ${c} OR parent_id = (SELECT id FROM categories WHERE slug = ${c}))`); }
  if (p.min_price !== undefined) w.push(`l.price_cents >= ${add(p.min_price)}`); if (p.max_price !== undefined) w.push(`l.price_cents <= ${add(p.max_price)}`);
  if (p.condition) w.push(`l.condition = ANY(${add(String(p.condition).split(','))}::text[])`);
  if (p.lng !== undefined) w.push(`l.location IS NOT NULL AND ST_DWithin(l.location, ST_SetSRID(ST_MakePoint(${add(p.lng)}::float8, ${add(p.lat)}::float8),4326)::geography, ${add((p.radius_km ?? 25) * 1000)})`);
  return !!(await pool.query(`SELECT 1 FROM listings l WHERE ${w.join(' AND ')}`, a)).rowCount;
}
async function corridorMatches(kind: 'journey' | 'request', id: string, p: any) {
  const t = kind === 'journey' ? 'journeys' : 'transport_requests'; const a: unknown[] = [id, p.from_lng, p.from_lat, p.to_lng, p.to_lat, (p.radius_km ?? 60) * 1000];
  const date = kind === 'journey' ? 'x.departure_at::date' : 'x.pickup_from'; const ok = kind === 'journey' ? `x.status IN ('open')` : `x.status='open' AND x.visibility='public'`;
  const w = [`x.id=$1`, ok, `ST_DWithin(x.origin, ST_SetSRID(ST_MakePoint($2::float8,$3::float8),4326)::geography, $6)`, `ST_DWithin(x.dest, ST_SetSRID(ST_MakePoint($4::float8,$5::float8),4326)::geography, $6)`];
  if (p.earliest) { a.push(p.earliest); w.push(`${date} >= $${a.length}::date`); } if (p.latest) { a.push(p.latest); w.push(`${date} <= $${a.length}::date`); }
  return !!(await pool.query(`SELECT 1 FROM ${t} x WHERE ${w.join(' AND ')}`, a)).rowCount;
}
registerJob('match_saved_searches', async ({ kind, id }: { kind: 'listing' | 'journey' | 'request'; id: string }) => {
  const item = kind === 'listing' ? (await pool.query(`SELECT seller_id AS owner, title FROM listings WHERE id=$1`, [id])).rows[0]
    : kind === 'journey' ? (await pool.query(`SELECT driver_id AS owner, origin_city || ' → ' || dest_city AS title FROM journeys WHERE id=$1`, [id])).rows[0]
    : (await pool.query(`SELECT requester_id AS owner, title FROM transport_requests WHERE id=$1`, [id])).rows[0];
  if (!item) return;
  const cap = Number(await setting('saved_search.max_alerts_per_day', 10));
  const searches = (await pool.query(`SELECT s.id, s.user_id, s.name, s.params FROM saved_searches s JOIN users u ON u.id=s.user_id WHERE s.kind=$1 AND s.active AND s.user_id <> $2 AND u.status='active'
     AND (SELECT count(*) FROM saved_search_hits h WHERE h.search_id=s.id AND h.created_at > now() - interval '1 day') < $3 AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=s.user_id AND b.blocked_id=$2) OR (b.blocker_id=$2 AND b.blocked_id=s.user_id)) LIMIT 5000`, [kind, item.owner, cap])).rows;
  for (const s of searches) {
    const hit = kind === 'listing' ? await listingMatches(id, s.params) : await corridorMatches(kind, id, s.params); if (!hit) continue;
    const first = await pool.query('INSERT INTO saved_search_hits(search_id,item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [s.id, id]); if (!first.rowCount) continue;
    await pool.query('UPDATE saved_searches SET last_alert_at=now() WHERE id=$1', [s.id]);
    await notify(pool, { userId: s.user_id, type: 'saved_search_match', targetType: kind === 'listing' ? 'listing' : kind === 'journey' ? 'journey' : 'transport_request', targetId: id, data: { search_id: s.id, search_name: s.name, title: item.title }, dedupeKey: `${s.id}:${id}` });
  }
});

// ---------------------------------------------------------------------------------------------- price-drop alerts for people who saved a listing
registerJob('price_drop', async ({ id, old_cents, new_cents }: { id: string; old_cents: number; new_cents: number }) => {
  const minPct = Number(await setting('notifications.price_drop_min_percent', 5));
  if (!(old_cents > 0) || ((old_cents - new_cents) / old_cents) * 100 < minPct) return;
  const l = (await pool.query(`SELECT title, seller_id, price_cents FROM listings WHERE id=$1 AND status='active' AND visibility='public'`, [id])).rows[0]; if (!l || l.price_cents !== new_cents) return;
  const savers = (await pool.query(`SELECT s.user_id FROM saved_items s WHERE s.target_type='listing' AND s.target_id=$1 AND s.user_id <> $2`, [id, l.seller_id])).rows;
  for (const s of savers) await notify(pool, { userId: s.user_id, type: 'price_drop', actorId: l.seller_id, targetType: 'listing', targetId: id, data: { title: l.title, old_cents, new_cents }, dedupeKey: `${id}:${new_cents}` });
});
