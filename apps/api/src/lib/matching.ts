import { pool } from '../db/pool.js';

/** Everything the scorer needs, flattened so scoring is a pure function that is easy to test. */
export interface MatchInput {
  kind: 'journey' | 'service';
  // shipment
  weightKg: number; quantity: number; lengthCm: number | null; widthCm: number | null; heightCm: number | null;
  fragile: boolean; category: string; preferredVehicles: string[]; budgetCents: number | null;
  pickupFrom: string; pickupTo: string; deliverBy: string | null; needsLoadingHelp: boolean;
  // capacity provider
  vehicle: string; remainingKg: number; remainingM3: number | null; maxLengthCm: number | null; maxWidthCm: number | null; maxHeightCm: number | null;
  restrictions: string[]; priceCents: number; priceType: string; helpsLoading: boolean;
  detourKm: number;                 // journey: driver's detour tolerance. service: service radius
  departure: string | null; arrival: string | null;   // ISO; journeys only
  // geometry
  pickupOffKm: number; dropOffKm: number; coverage: number; directionOk: boolean;
  // reliability of the provider
  ratingAvg: number | null; ratingCount: number; completed: number;
}

export type ExclusionCode = 'capacity' | 'restriction' | 'direction' | 'date' | 'distance';
export interface MatchResult {
  excluded?: { code: ExclusionCode; reason: string };
  score: number; level: 'great' | 'good' | 'possible';
  reasons: string[]; warnings: string[];
  metrics: { pickup_off_km: number; drop_off_km: number; coverage_pct: number };
}

const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const DAY = 86_400_000;
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const fmt = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n)).toString();

export function volumeM3(l: number | null, w: number | null, h: number | null, qty: number) {
  return l && w && h ? (l * w * h * qty) / 1_000_000 : null;
}

/** Hard rules exclude; everything else contributes to a 0–100 score with human-readable reasons. */
export function scoreMatch(i: MatchInput): MatchResult {
  const reasons: string[] = []; const warnings: string[] = [];
  const metrics = { pickup_off_km: Math.round(i.pickupOffKm * 10) / 10, drop_off_km: Math.round(i.dropOffKm * 10) / 10, coverage_pct: Math.round(i.coverage * 100) };
  const out = (code: ExclusionCode, reason: string): MatchResult => ({ excluded: { code, reason }, score: 0, level: 'possible', reasons, warnings, metrics });

  // ---- hard capacity / restriction rules
  const need = i.weightKg * i.quantity;
  if (need > i.remainingKg) return out('capacity', `Needs ${fmt(need)} kg but only ${i.remainingKg} kg is left`);
  const vol = volumeM3(i.lengthCm, i.widthCm, i.heightCm, i.quantity);
  if (vol !== null && i.remainingM3 !== null && vol > i.remainingM3) return out('capacity', `Needs about ${vol.toFixed(2)} m³ but only ${i.remainingM3} m³ is left`);
  const maxD = [i.maxLengthCm, i.maxWidthCm, i.maxHeightCm];
  const itemD = [i.lengthCm, i.widthCm, i.heightCm];
  if (maxD.every((x) => x) && itemD.every((x) => x)) {
    const a = [...(itemD as number[])].sort((x, y) => y - x); const b = [...(maxD as number[])].sort((x, y) => y - x);
    if (a.some((v, k) => v > b[k])) return out('capacity', 'Too large for the cargo space');
  }
  if (i.restrictions.includes(i.category) || (i.fragile && i.restrictions.includes('fragile'))) return out('restriction', i.fragile && i.restrictions.includes('fragile') ? 'Does not carry fragile items' : `Does not carry ${i.category.replace('_', ' ')}`);

  // ---- route (journeys) or service area
  const limit = Math.max(i.detourKm, i.kind === 'service' ? 1 : 10);
  if (i.kind === 'journey') {
    if (!i.directionOk) return out('direction', 'Route passes your pickup and drop-off in the opposite order');
    if (i.pickupOffKm > limit * 2 || i.dropOffKm > limit * 2) return out('distance', 'Too far from the driver\'s route');
  }
  const prox = (o: number) => (o <= limit ? 1 - 0.5 * (o / limit) : clamp(0.5 * (1 - (o - limit) / limit)));
  let routePts: number; let coveragePts = 0;
  if (i.kind === 'journey') {
    routePts = 35 * (0.5 * prox(i.pickupOffKm) + 0.5 * prox(i.dropOffKm));
    coveragePts = 10 * i.coverage;
    reasons.push(i.pickupOffKm < 1 ? 'Passes through your pickup city' : `Pickup is ${fmt(i.pickupOffKm)} km from the route`);
    reasons.push(i.dropOffKm < 1 ? 'Passes through your destination city' : `Drop-off is ${fmt(i.dropOffKm)} km from the route`);
    if (i.pickupOffKm > limit) warnings.push(`Pickup is ${fmt(i.pickupOffKm - limit)} km beyond the driver's ${limit} km detour limit — needs agreement`);
    if (i.dropOffKm > limit) warnings.push(`Drop-off is ${fmt(i.dropOffKm - limit)} km beyond the driver's ${limit} km detour limit — needs agreement`);
  } else {
    if (i.pickupOffKm > i.detourKm) return out('distance', 'Pickup is outside the service area');
    routePts = 30 * (0.6 + 0.4 * prox(i.pickupOffKm)); coveragePts = 5;
    reasons.push('Pickup is inside the service area');
  }

  // ---- timing (journeys depart on a date; services are arranged)
  let timePts = 0;
  if (i.kind === 'journey' && i.departure) {
    const d = day(i.departure.slice(0, 10)); const from = day(i.pickupFrom); const to = day(i.pickupTo);
    const outside = d < from ? (from - d) / DAY : d > to ? (d - to) / DAY : 0;
    if (outside === 0) { timePts = 15; reasons.push('Departs inside your pickup window'); }
    else if (outside <= 2) { timePts = 8; warnings.push(`Departs ${outside} day${outside > 1 ? 's' : ''} ${d < from ? 'before' : 'after'} your pickup window`); }
    else return out('date', `Departs ${Math.round(outside)} days outside your pickup window`);
    if (i.deliverBy) {
      if (i.arrival) { if (day(i.arrival.slice(0, 10)) > day(i.deliverBy)) return out('date', 'Estimated arrival is after your delivery deadline'); reasons.push('Arrives before your deadline'); }
      else warnings.push('Arrival time not provided — confirm it meets your deadline');
    }
  } else { timePts = 7; reasons.push('Date to be agreed with the provider'); }

  // ---- capacity headroom
  const headroom = 1 - need / i.remainingKg;
  const capPts = headroom >= 0.2 ? 15 : 10;
  reasons.push(`Fits: ${fmt(need)} kg of ${i.remainingKg} kg available`);
  if (!itemD.every((x) => x) && maxD.some((x) => x)) warnings.push('Item dimensions not provided — provider may need to confirm it fits');

  // ---- vehicle, handling
  let vehPts = 2;
  if (i.preferredVehicles.length === 0) vehPts = 3;
  else if (i.preferredVehicles.includes(i.vehicle)) { vehPts = 5; reasons.push(`${i.vehicle.replace('_', ' ')} is one of your preferred vehicles`); }
  else warnings.push(`Vehicle is a ${i.vehicle.replace('_', ' ')}, not one of your preferred types`);
  if (i.needsLoadingHelp && !i.helpsLoading) warnings.push('You asked for loading help — this provider does not offer it');
  if (i.needsLoadingHelp && i.helpsLoading) reasons.push('Offers loading help');

  // ---- price
  let pricePts = 5;
  if (i.budgetCents !== null) {
    if (i.priceCents <= i.budgetCents) { pricePts = 10; reasons.push('Within your budget'); }
    else if (i.priceType === 'negotiable') { pricePts = 6; warnings.push('Above your budget, but the price is negotiable'); }
    else if (i.priceCents <= i.budgetCents * 1.3) { pricePts = 3; warnings.push('Above your budget'); }
    else { pricePts = 0; warnings.push('Well above your budget'); }
  }

  // ---- reliability
  let relPts = 4;
  if (i.ratingCount > 0 && i.ratingAvg !== null) {
    relPts = 6 * (i.ratingAvg / 5) + 4 * clamp(i.completed / 10);
    reasons.push(`${i.ratingAvg.toFixed(1)}★ from ${i.ratingCount} review${i.ratingCount > 1 ? 's' : ''}`);
  } else if (i.completed > 0) { relPts = 4 + 3 * clamp(i.completed / 10); reasons.push(`${i.completed} completed move${i.completed > 1 ? 's' : ''}`); }
  else reasons.push('New transporter — no reviews yet');

  const score = Math.round(clamp((routePts + coveragePts + timePts + capPts + vehPts + pricePts + relPts) / 100, 0, 1) * 100);
  const level = score >= 80 ? 'great' : score >= 60 ? 'good' : 'possible';
  return { score, level, reasons, warnings, metrics };
}

// ------------------------------------------------------------------------------------------- queries
const RATING = (u: string) => `(SELECT avg(rating) FROM reviews WHERE reviewee_id=${u} AND status='active' AND role='transporter') AS rating_avg,
  (SELECT count(*) FROM reviews WHERE reviewee_id=${u} AND status='active' AND role='transporter')::int AS rating_count,
  (SELECT count(*) FROM bookings WHERE transporter_id=${u} AND status='completed')::int AS completed`;

const REQ_COLS = `r.id AS request_id, r.requester_id, r.weight_kg, r.quantity, r.length_cm, r.width_cm, r.height_cm, r.fragile, r.item_category, r.preferred_vehicles,
  r.budget_cents, r.pickup_from::text AS pickup_from, r.pickup_to::text AS pickup_to, r.deliver_by::text AS deliver_by, r.needs_loading_help`;

const NOT_BLOCKED = (a: string, b: string) => `NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id=${a} AND bl.blocked_id=${b}) OR (bl.blocker_id=${b} AND bl.blocked_id=${a}))`;

function journeyInput(r: any): MatchInput {
  const leg = Number(r.leg_km);
  const segKm = Math.max(0, (Number(r.df) - Number(r.pf)) * Number(r.distance_km));
  return {
    kind: 'journey', weightKg: Number(r.weight_kg), quantity: r.quantity, lengthCm: r.length_cm, widthCm: r.width_cm, heightCm: r.height_cm, fragile: r.fragile, category: r.item_category,
    preferredVehicles: r.preferred_vehicles, budgetCents: r.budget_cents, pickupFrom: r.pickup_from, pickupTo: r.pickup_to, deliverBy: r.deliver_by, needsLoadingHelp: r.needs_loading_help,
    vehicle: r.vehicle_type, remainingKg: r.remaining_kg, remainingM3: r.remaining_m3 === null ? null : Number(r.remaining_m3), maxLengthCm: r.max_length_cm, maxWidthCm: r.max_width_cm, maxHeightCm: r.max_height_cm,
    restrictions: r.item_restrictions, priceCents: r.price_cents, priceType: r.price_type, helpsLoading: r.helps_loading, detourKm: r.max_detour_km,
    departure: new Date(r.departure_at).toISOString(), arrival: r.arrival_at ? new Date(r.arrival_at).toISOString() : null,
    pickupOffKm: Number(r.pickup_off_km), dropOffKm: Number(r.drop_off_km), coverage: leg > 0 ? clamp(segKm / leg) : 1, directionOk: Number(r.df) > Number(r.pf) + 0.0005,
    ratingAvg: r.rating_avg === null ? null : Number(r.rating_avg), ratingCount: r.rating_count, completed: r.completed,
  };
}

const JOURNEY_PAIR = `SELECT j.id AS journey_id, j.driver_id, j.vehicle_type, j.remaining_kg, j.remaining_m3, j.max_length_cm, j.max_width_cm, j.max_height_cm, j.item_restrictions,
    j.price_cents, j.price_type, j.helps_loading, j.max_detour_km, j.departure_at, j.arrival_at, j.distance_km, ${REQ_COLS},
    ST_Distance(j.route, r.origin)/1000 AS pickup_off_km, ST_Distance(j.route, r.dest)/1000 AS drop_off_km,
    ST_LineLocatePoint(j.route::geometry, r.origin::geometry) AS pf, ST_LineLocatePoint(j.route::geometry, r.dest::geometry) AS df,
    ST_Distance(r.origin, r.dest)/1000 AS leg_km, ${RATING('j.driver_id')}
  FROM journeys j JOIN transport_requests r ON r.status='open' AND j.status='open' AND j.departure_at > now() AND j.driver_id <> r.requester_id
    AND ST_DWithin(j.route, r.origin, greatest(j.max_detour_km, 10) * 2000) AND ST_DWithin(j.route, r.dest, greatest(j.max_detour_km, 10) * 2000)
    AND ${NOT_BLOCKED('j.driver_id', 'r.requester_id')}`;

export type RankedMatch = { id: string; score: number; level: string; reasons: string[]; warnings: string[]; metrics: MatchResult['metrics'] };

/** Journeys that could carry this request, best first. Partial matches (beyond detour limit, small date gaps) are kept with warnings. */
export async function journeysForRequest(requestId: string, limit = 30): Promise<RankedMatch[]> {
  const { rows } = await pool.query(`${JOURNEY_PAIR} WHERE r.id = $1 LIMIT 200`, [requestId]);
  return rows.map((r) => ({ id: r.journey_id as string, res: scoreMatch(journeyInput(r)) })).filter((x) => !x.res.excluded)
    .map((x) => ({ id: x.id, score: x.res.score, level: x.res.level, reasons: x.res.reasons, warnings: x.res.warnings, metrics: x.res.metrics }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Open public requests a driver could serve on this journey. */
export async function requestsForJourney(journeyId: string, limit = 30): Promise<RankedMatch[]> {
  const { rows } = await pool.query(`${JOURNEY_PAIR} AND r.visibility='public' WHERE j.id = $1 LIMIT 200`, [journeyId]);
  return rows.map((r) => ({ id: r.request_id as string, res: scoreMatch(journeyInput(r)) })).filter((x) => !x.res.excluded)
    .map((x) => ({ id: x.id, score: x.res.score, level: x.res.level, reasons: x.res.reasons, warnings: x.res.warnings, metrics: x.res.metrics }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Direct fit check for one journey and one request (used when validating an offer). */
export async function checkFit(requestId: string, journeyId: string): Promise<MatchResult | null> {
  const { rows } = await pool.query(
    `SELECT j.id AS journey_id, j.driver_id, j.vehicle_type, j.remaining_kg, j.remaining_m3, j.max_length_cm, j.max_width_cm, j.max_height_cm, j.item_restrictions,
      j.price_cents, j.price_type, j.helps_loading, j.max_detour_km, j.departure_at, j.arrival_at, j.distance_km, ${REQ_COLS},
      ST_Distance(j.route, r.origin)/1000 AS pickup_off_km, ST_Distance(j.route, r.dest)/1000 AS drop_off_km,
      ST_LineLocatePoint(j.route::geometry, r.origin::geometry) AS pf, ST_LineLocatePoint(j.route::geometry, r.dest::geometry) AS df,
      ST_Distance(r.origin, r.dest)/1000 AS leg_km, ${RATING('j.driver_id')}
     FROM journeys j, transport_requests r WHERE j.id=$1 AND r.id=$2`, [journeyId, requestId]);
  return rows[0] ? scoreMatch(journeyInput(rows[0])) : null;
}

const SERVICE_PAIR = `SELECT s.id AS service_id, s.provider_id, s.vehicle_type, s.capacity_kg, s.max_length_cm, s.max_width_cm, s.max_height_cm, s.item_restrictions, s.price_cents, s.price_type,
    s.helps_loading, s.service_radius_km, ${REQ_COLS},
    ST_Distance(s.service_center, r.origin)/1000 AS pickup_off_km, ST_Distance(s.service_center, r.dest)/1000 AS drop_off_km, ST_Distance(r.origin, r.dest)/1000 AS leg_km, ${RATING('s.provider_id')}
  FROM transport_services s JOIN transport_requests r ON s.status='active' AND r.status='open' AND s.provider_id <> r.requester_id
    AND ST_DWithin(s.service_center, r.origin, s.service_radius_km*1000) AND (s.intercity OR ST_DWithin(s.service_center, r.dest, s.service_radius_km*1000))
    AND ${NOT_BLOCKED('s.provider_id', 'r.requester_id')}`;

function serviceInput(r: any): MatchInput {
  return {
    kind: 'service', weightKg: Number(r.weight_kg), quantity: r.quantity, lengthCm: r.length_cm, widthCm: r.width_cm, heightCm: r.height_cm, fragile: r.fragile, category: r.item_category,
    preferredVehicles: r.preferred_vehicles, budgetCents: r.budget_cents, pickupFrom: r.pickup_from, pickupTo: r.pickup_to, deliverBy: r.deliver_by, needsLoadingHelp: r.needs_loading_help,
    vehicle: r.vehicle_type, remainingKg: r.capacity_kg, remainingM3: null, maxLengthCm: r.max_length_cm, maxWidthCm: r.max_width_cm, maxHeightCm: r.max_height_cm,
    restrictions: r.item_restrictions, priceCents: r.price_cents, priceType: r.price_type, helpsLoading: r.helps_loading, detourKm: r.service_radius_km, departure: null, arrival: null,
    pickupOffKm: Number(r.pickup_off_km), dropOffKm: Number(r.drop_off_km), coverage: 1, directionOk: true,
    ratingAvg: r.rating_avg === null ? null : Number(r.rating_avg), ratingCount: r.rating_count, completed: r.completed,
  };
}

export async function servicesForRequest(requestId: string, limit = 30): Promise<RankedMatch[]> {
  const { rows } = await pool.query(`${SERVICE_PAIR} WHERE r.id = $1 LIMIT 200`, [requestId]);
  return rows.map((r) => ({ id: r.service_id as string, res: scoreMatch(serviceInput(r)) })).filter((x) => !x.res.excluded)
    .map((x) => ({ id: x.id, score: x.res.score, level: x.res.level, reasons: x.res.reasons, warnings: x.res.warnings, metrics: x.res.metrics }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function checkServiceFit(requestId: string, serviceId: string): Promise<MatchResult | null> {
  const { rows } = await pool.query(
    `SELECT s.id AS service_id, s.provider_id, s.vehicle_type, s.capacity_kg, s.max_length_cm, s.max_width_cm, s.max_height_cm, s.item_restrictions, s.price_cents, s.price_type,
      s.helps_loading, s.service_radius_km, ${REQ_COLS},
      ST_Distance(s.service_center, r.origin)/1000 AS pickup_off_km, ST_Distance(s.service_center, r.dest)/1000 AS drop_off_km, ST_Distance(r.origin, r.dest)/1000 AS leg_km, ${RATING('s.provider_id')}
     FROM transport_services s, transport_requests r WHERE s.id=$1 AND r.id=$2`, [serviceId, requestId]);
  return rows[0] ? scoreMatch(serviceInput(rows[0])) : null;
}
