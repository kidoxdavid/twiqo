import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { HttpError, badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { hydrateRequests } from '../lib/hydrate.js';
import { requestsForJourney, volumeM3 } from '../lib/matching.js';
import { setting } from '../lib/policy.js';
import { createOffer, withdrawOffer } from './offers.js';

export const bundles = Router();
const uuid = z.string().uuid();
const AVG_KMH = 70;   // planning speed for ETAs; driving breaks and loading time are not included

async function myJourney(id: string, me: string) {
  const j = (await pool.query('SELECT * FROM journeys WHERE id=$1', [id])).rows[0]; if (!j || j.driver_id !== me) throw notFound('Journey'); return j;
}

// ---------------------------------------------------------------------------------------------- the driver's plan for one trip: every shipment, in the order to do them
bundles.get('/transport/journeys/:id/manifest', requireAuth, wrap(async (req, res) => {
  const j = await myJourney(uuid.parse(req.params.id), req.user!.id);
  const { rows } = await pool.query(
    `SELECT b.id AS booking_id, b.status, b.agreed_cents, b.reserved_kg, b.reserved_m3, b.pickup_confirmed_at, b.delivered_at,
            r.title, r.origin_city, r.origin_province, r.dest_city, r.dest_province, r.pickup_area, r.delivery_area, r.pickup_from::text AS pickup_from, r.pickup_to::text AS pickup_to, r.deliver_by::text AS deliver_by,
            r.fragile, r.needs_loading_help, r.needs_unloading_help,
            ST_LineLocatePoint(j.route::geometry, r.origin::geometry) AS pf, ST_LineLocatePoint(j.route::geometry, r.dest::geometry) AS df,
            ST_Distance(j.route, r.origin)/1000 AS pickup_off_km, ST_Distance(j.route, r.dest)/1000 AS drop_off_km,
            a.pickup_address, a.pickup_notes, a.delivery_address, a.delivery_notes, a.contact_phone, su.username AS shipper_username, sp.display_name AS shipper_name
     FROM bookings b JOIN journeys j ON j.id=b.journey_id JOIN transport_requests r ON r.id=b.request_id JOIN users su ON su.id=b.shipper_id JOIN user_profiles sp ON sp.user_id=su.id
     LEFT JOIN booking_addresses a ON a.booking_id=b.id WHERE b.journey_id=$1 AND b.status <> 'cancelled' ORDER BY b.created_at`, [j.id]);
  const warnings: string[] = []; type Stop = Record<string, any>; const stops: Stop[] = [];
  const dep = new Date(j.departure_at).getTime();
  for (const b of rows) {
    const live = b.status !== 'completed';   // addresses are only shown while the job is still to be done
    let pf = Number(b.pf), df = Number(b.df); let outOfOrder = false;
    if (df < pf) { outOfOrder = true; df = pf; warnings.push(`"${b.title}" travels against the direction of this journey (pick-up is after drop-off along the route). It can't be done in one pass.`); }
    const mk = (type: 'pickup' | 'delivery', pos: number, off: number): Stop => {
      const km = Math.round(pos * j.distance_km); const eta = new Date(dep + (km / AVG_KMH) * 3600_000);
      const etaDay = eta.toISOString().slice(0, 10);
      const window = type === 'pickup' ? (etaDay < b.pickup_from || etaDay > b.pickup_to ? `Estimated ${etaDay} is outside the pick-up window ${b.pickup_from} to ${b.pickup_to}` : null) : (b.deliver_by && etaDay > b.deliver_by ? `Estimated ${etaDay} is after the deliver-by date ${b.deliver_by}` : null);
      return { type, booking_id: b.booking_id, title: b.title, status: b.status, pos, km_along: km, eta_estimate: eta.toISOString(), off_route_km: Math.round(Number(off) * 10) / 10, window_warning: window, out_of_order: outOfOrder,
        done: type === 'pickup' ? !!b.pickup_confirmed_at : !!b.delivered_at, kg: Number(b.reserved_kg), m3: Number(b.reserved_m3),
        place: type === 'pickup' ? { city: b.origin_city, province: b.origin_province, area: b.pickup_area } : { city: b.dest_city, province: b.dest_province, area: b.delivery_area },
        ...(live ? { address: type === 'pickup' ? b.pickup_address : b.delivery_address, notes: type === 'pickup' ? b.pickup_notes : b.delivery_notes, phone: b.contact_phone } : {}),
        handling: { fragile: b.fragile, loading_help: type === 'pickup' ? b.needs_loading_help : b.needs_unloading_help }, shipper: { username: b.shipper_username, display_name: b.shipper_name } };
    };
    stops.push(mk('pickup', pf, b.pickup_off_km), mk('delivery', df, b.drop_off_km));
    if (!live) continue;
  }
  // along the route; at the same spot drop off before picking up so the space is free
  stops.sort((a, b) => a.pos - b.pos || (a.type === b.type ? 0 : a.type === 'delivery' ? -1 : 1));
  let kg = 0; let m3 = 0; let peakKg = 0; let peakM3 = 0;
  for (const s of stops) { if (s.type === 'pickup') { kg += s.kg; m3 += s.m3; } else { kg -= s.kg; m3 -= s.m3; } s.load_after_kg = Math.round(kg); peakKg = Math.max(peakKg, kg); peakM3 = Math.max(peakM3, m3); }
  if (peakKg > j.capacity_kg) warnings.push(`At the busiest point you would carry ${Math.round(peakKg)} kg, over this vehicle's ${j.capacity_kg} kg.`);
  if (j.capacity_m3 && peakM3 > Number(j.capacity_m3)) warnings.push(`At the busiest point the load is ${peakM3.toFixed(1)} m³, over the ${j.capacity_m3} m³ capacity.`);
  for (const s of stops) if (s.window_warning && !s.done) warnings.push(`${s.type === 'pickup' ? 'Pick-up' : 'Drop-off'} of "${s.title}": ${s.window_warning}.`);
  const next = stops.find((s) => !s.done) ?? null;
  const active = rows.filter((b) => b.status !== 'completed');
  res.json({
    journey: { id: j.id, from: j.origin_city, to: j.dest_city, departure_at: j.departure_at, distance_km: j.distance_km, capacity_kg: j.capacity_kg, capacity_m3: j.capacity_m3 === null ? null : Number(j.capacity_m3), remaining_kg: j.remaining_kg, status: j.status },
    summary: { shipments: rows.length, total_agreed_cents: rows.reduce((a, b) => a + b.agreed_cents, 0), loaded_kg: Math.round(rows.reduce((a, b) => a + Number(b.reserved_kg), 0)), peak_kg: Math.round(peakKg), utilisation_pct: Math.round((peakKg / j.capacity_kg) * 100),
      extra_off_route_km: Math.round(rows.reduce((a, b) => a + Number(b.pickup_off_km) + Number(b.drop_off_km), 0) * 10) / 10, active: active.length },
    next_stop: next ? { type: next.type, booking_id: next.booking_id, title: next.title, place: next.place } : null, stops, warnings,
    note: `Order follows the route. Times are estimates at ${AVG_KMH} km/h from departure and don't include loading time or breaks.`,
  });
}));

// ---------------------------------------------------------------------------------------------- what else could ride along: the best set of open shipments for the space that's left
bundles.get('/transport/journeys/:id/consolidation', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const j = await myJourney(uuid.parse(req.params.id), me);
  if (!['open', 'full'].includes(j.status)) throw conflict('This journey is no longer taking shipments');
  const min = Number(await setting('transport.match_min_score', 55));
  const ranked = (await requestsForJourney(j.id, 40)).filter((m) => m.score >= min).slice(0, 12);
  const info = ranked.length ? (await pool.query(`SELECT id, weight_kg, quantity, length_cm, width_cm, height_cm, budget_cents, title FROM transport_requests WHERE id = ANY($1::uuid[])`, [ranked.map((m) => m.id)])).rows : [];
  const byId = new Map(info.map((r) => [r.id as string, r]));
  const cands = ranked.map((m) => { const r = byId.get(m.id)!; const kg = Number(r.weight_kg) * r.quantity; const m3 = volumeM3(r.length_cm, r.width_cm, r.height_cm, r.quantity) ?? 0;
    return { id: m.id, title: r.title as string, kg, m3, value: r.budget_cents ?? j.price_cents, estimated_value: r.budget_cents === null, detour: m.metrics.pickup_off_km + m.metrics.drop_off_km, score: m.score, level: m.level, reasons: m.reasons, warnings: m.warnings }; });
  const capKg = j.remaining_kg; const capM3 = j.remaining_m3 === null ? Infinity : Number(j.remaining_m3);
  let best: { mask: number; value: number; detour: number; kg: number; m3: number; n: number } | null = null;
  for (let mask = 1; mask < (1 << cands.length); mask++) {   // at most 4,095 subsets
    let kg = 0, m3 = 0, value = 0, detour = 0, n = 0;
    for (let i = 0; i < cands.length; i++) if (mask & (1 << i)) { kg += cands[i].kg; m3 += cands[i].m3; value += cands[i].value; detour += cands[i].detour; n++; }
    if (kg > capKg || m3 > capM3) continue;
    if (!best || value > best.value || (value === best.value && (detour < best.detour || (detour === best.detour && n < best.n)))) best = { mask, value, detour, kg, m3, n };
  }
  const chosen = best ? cands.filter((_, i) => best!.mask & (1 << i)) : [];
  const hyd = await hydrateRequests(cands.map((c) => c.id), me);
  res.json({
    remaining: { kg: j.remaining_kg, m3: j.remaining_m3 === null ? null : Number(j.remaining_m3) },
    candidates: cands.map((c) => ({ ...c, in_best_bundle: chosen.some((x) => x.id === c.id), detour_km: Math.round(c.detour * 10) / 10, request: hyd.get(c.id) })),
    best_bundle: chosen.length ? { request_ids: chosen.map((c) => c.id), shipments: chosen.length, total_kg: Math.round(best!.kg), total_m3: Math.round(best!.m3 * 100) / 100, total_cents: best!.value, extra_detour_km: Math.round(best!.detour * 10) / 10, includes_estimates: chosen.some((c) => c.estimated_value) } : null,
    note: 'The best bundle is the set of matching shipments that fits the space left and earns the most, preferring less detour. Amounts use each shipper\'s budget, or your journey price where they gave none.',
  });
}));

const maxShipments = async () => Number(await setting('bundle.max_shipments', 6));
const cap = async (journeyId: string, ids: string[]) => {
  const j = (await pool.query('SELECT * FROM journeys WHERE id=$1', [journeyId])).rows[0]; if (!j) throw notFound('Journey');
  const reqs = (await pool.query(`SELECT id, requester_id, status, visibility, title, weight_kg, quantity, length_cm, width_cm, height_cm FROM transport_requests WHERE id = ANY($1::uuid[])`, [ids])).rows;
  if (reqs.length !== new Set(ids).size) throw notFound('Request');
  const kg = reqs.reduce((a, r) => a + Number(r.weight_kg) * r.quantity, 0); const m3 = reqs.reduce((a, r) => a + (volumeM3(r.length_cm, r.width_cm, r.height_cm, r.quantity) ?? 0), 0);
  if (kg > j.remaining_kg) throw new HttpError(422, `Together these weigh ${Math.ceil(kg)} kg but only ${j.remaining_kg} kg is left on this journey.`, 'does_not_fit');
  if (j.remaining_m3 !== null && m3 > Number(j.remaining_m3)) throw new HttpError(422, `Together these need ${m3.toFixed(1)} m³ but only ${j.remaining_m3} m³ is left on this journey.`, 'does_not_fit');
  return { j, reqs, kg };
};
/** If anything goes wrong part-way, take back the offers already sent so a bundle is never left half made. */
async function undo(bundleId: string, me: string) { for (const o of (await pool.query(`SELECT id FROM offers WHERE bundle_id=$1 AND status='pending'`, [bundleId])).rows) await withdrawOffer(o.id, me).catch(() => undefined); }

// ---------------------------------------------------------------------------------------------- driver: offer to carry several shipments in one go
bundles.post('/transport/journeys/:id/offer-bundle', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const id = uuid.parse(req.params.id);
  const b = z.object({ items: z.array(z.object({ request_id: uuid, amount_cents: z.number().int().min(1).max(10_000_000) })).min(2), message: z.string().trim().max(500).optional() }).parse(req.body);
  if (b.items.length > (await maxShipments())) throw badRequest(`A bundle can have up to ${await maxShipments()} shipments`);
  if (new Set(b.items.map((i) => i.request_id)).size !== b.items.length) throw badRequest('Each shipment can only be in the bundle once');
  const j = await myJourney(id, me); if (j.status !== 'open') throw conflict('This journey is no longer taking shipments');
  const { reqs } = await cap(id, b.items.map((i) => i.request_id));
  if (reqs.some((r) => r.requester_id === me)) throw badRequest('You cannot carry your own shipments');
  const bundleId = crypto.randomUUID(); const out = [];
  try { for (const it of b.items) out.push(await createOffer(me, { kind: 'transport', request_id: it.request_id, journey_id: id, amount_cents: it.amount_cents, message: b.message, expires_in_hours: undefined } as any, { bundleId })); }
  catch (e) { await undo(bundleId, me); throw e; }
  res.status(201).json({ bundle_id: bundleId, offers: out });
}));

// ---------------------------------------------------------------------------------------------- shipper: book several of my shipments on one journey for one price
bundles.post('/transport/journeys/:id/book-bundle', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id; const id = uuid.parse(req.params.id);
  const b = z.object({ request_ids: z.array(uuid).min(2), total_cents: z.number().int().min(1).max(50_000_000), message: z.string().trim().max(500).optional() }).parse(req.body);
  if (b.request_ids.length > (await maxShipments())) throw badRequest(`A bundle can have up to ${await maxShipments()} shipments`);
  if (new Set(b.request_ids).size !== b.request_ids.length) throw badRequest('Each shipment can only be in the bundle once');
  const { j, reqs } = await cap(id, b.request_ids);
  if (j.status !== 'open' || new Date(j.departure_at) < new Date()) throw notFound('Journey'); if (j.driver_id === me) throw badRequest('You cannot book your own journey');
  if (reqs.some((r) => r.requester_id !== me)) throw badRequest('You can only bundle your own shipments'); if (reqs.some((r) => r.status !== 'open')) throw conflict('One of these shipments is no longer open');
  // split the price by weight, or at the journey's fixed price each
  const w = reqs.map((r) => Math.max(1, Number(r.weight_kg) * r.quantity)); const sw = w.reduce((a, x) => a + x, 0); let amounts: number[];
  if (j.price_type === 'fixed') { if (b.total_cents !== j.price_cents * reqs.length) throw new HttpError(422, `This journey has a fixed price of ${(j.price_cents / 100).toFixed(2)} per shipment, so ${reqs.length} shipments cost ${((j.price_cents * reqs.length) / 100).toFixed(2)}.`, 'fixed_price'); amounts = reqs.map(() => j.price_cents); }
  else { amounts = w.map((x) => Math.floor((b.total_cents * x) / sw)); amounts[w.indexOf(Math.max(...w))] += b.total_cents - amounts.reduce((a, x) => a + x, 0); if (amounts.some((a) => a < 1)) throw badRequest('That total is too low to split across these shipments'); }
  const bundleId = crypto.randomUUID(); const out = [];
  try { for (const [i, r] of reqs.entries()) out.push(await createOffer(me, { kind: 'transport', request_id: r.id, journey_id: id, amount_cents: amounts[i], message: b.message } as any, { bundleId })); }
  catch (e) { await undo(bundleId, me); throw e; }
  res.status(201).json({ bundle_id: bundleId, total_cents: amounts.reduce((a, x) => a + x, 0), offers: out });
}));
