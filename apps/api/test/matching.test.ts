import { describe, expect, it } from 'vitest';
import { scoreMatch, type MatchInput } from '../src/lib/matching.js';
import { api, auth, iso, makeJourney, makeRequest, makeUser, ymd } from './helpers.js';

const base: MatchInput = {
  kind: 'journey', weightKg: 36, quantity: 1, lengthCm: 70, widthCm: 70, heightCm: 60, fragile: false, category: 'tires', preferredVehicles: [], budgetCents: 12000,
  pickupFrom: '2030-01-10', pickupTo: '2030-01-12', deliverBy: null, needsLoadingHelp: false,
  vehicle: 'pickup_truck', remainingKg: 400, remainingM3: 3, maxLengthCm: 240, maxWidthCm: 180, maxHeightCm: 100, restrictions: [], priceCents: 9000, priceType: 'negotiable', helpsLoading: false,
  detourKm: 15, departure: '2030-01-11T12:00:00Z', arrival: '2030-01-14T12:00:00Z', pickupOffKm: 2, dropOffKm: 3, coverage: 1, directionOk: true, ratingAvg: 4.9, ratingCount: 12, completed: 12,
};

describe('scoreMatch (pure)', () => {
  it('scores an excellent match highly and explains why', () => {
    const r = scoreMatch(base);
    expect(r.excluded).toBeUndefined();
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.level).toBe('great');
    expect(r.reasons.join(' ')).toMatch(/Departs inside your pickup window/);
    expect(r.reasons.join(' ')).toMatch(/Within your budget/);
    expect(r.reasons.join(' ')).toMatch(/4\.9★ from 12 reviews/);
  });

  it('excludes on hard capacity limits', () => {
    expect(scoreMatch({ ...base, weightKg: 500 }).excluded?.code).toBe('capacity');
    expect(scoreMatch({ ...base, weightKg: 30, quantity: 20 }).excluded?.reason).toMatch(/Needs 600 kg/);
    expect(scoreMatch({ ...base, lengthCm: 300 }).excluded?.code).toBe('capacity');
    expect(scoreMatch({ ...base, lengthCm: 200, widthCm: 150, heightCm: 100, quantity: 40, weightKg: 5 }).excluded?.code).toBe('capacity'); // volume
  });

  it('respects item restrictions', () => {
    expect(scoreMatch({ ...base, restrictions: ['tires'] }).excluded?.code).toBe('restriction');
    expect(scoreMatch({ ...base, fragile: true, restrictions: ['fragile'] }).excluded?.code).toBe('restriction');
    expect(scoreMatch({ ...base, fragile: true, restrictions: ['appliances'] }).excluded).toBeUndefined();
  });

  it('rejects wrong direction and far-away routes, keeps near misses as partial matches', () => {
    expect(scoreMatch({ ...base, directionOk: false }).excluded?.code).toBe('direction');
    expect(scoreMatch({ ...base, pickupOffKm: 80 }).excluded?.code).toBe('distance');
    const partial = scoreMatch({ ...base, pickupOffKm: 25 });
    expect(partial.excluded).toBeUndefined();
    expect(partial.warnings.join(' ')).toMatch(/10 km beyond the driver's 15 km detour limit/);
    expect(partial.score).toBeLessThan(scoreMatch(base).score);
  });

  it('handles dates: small gaps warn, large gaps exclude, deadlines matter', () => {
    expect(scoreMatch({ ...base, departure: '2030-01-14T12:00:00Z' }).warnings.join(' ')).toMatch(/2 days after/);
    expect(scoreMatch({ ...base, departure: '2030-01-20T12:00:00Z' }).excluded?.code).toBe('date');
    expect(scoreMatch({ ...base, deliverBy: '2030-01-13', arrival: '2030-01-15T00:00:00Z' }).excluded?.code).toBe('date');
    expect(scoreMatch({ ...base, deliverBy: '2030-01-20', arrival: null }).warnings.join(' ')).toMatch(/Arrival time not provided/);
  });

  it('prices: budget, negotiable and fixed behave differently', () => {
    const over = { ...base, priceCents: 15000 };
    expect(scoreMatch({ ...over, priceType: 'negotiable' }).warnings.join(' ')).toMatch(/negotiable/);
    expect(scoreMatch({ ...over, priceType: 'fixed' }).score).toBeLessThan(scoreMatch({ ...over, priceType: 'negotiable' }).score);
    expect(scoreMatch({ ...base, priceCents: 40000, priceType: 'fixed' }).warnings.join(' ')).toMatch(/Well above/);
  });

  it('rewards reliable transporters and treats newcomers neutrally', () => {
    const veteran = scoreMatch(base).score;
    const newbie = scoreMatch({ ...base, ratingAvg: null, ratingCount: 0, completed: 0 });
    const poor = scoreMatch({ ...base, ratingAvg: 2.0, ratingCount: 3, completed: 1 }).score;
    expect(veteran).toBeGreaterThan(newbie.score); expect(newbie.score).toBeGreaterThan(poor - 10);
    expect(newbie.reasons.join(' ')).toMatch(/New transporter/);
    expect(veteran).toBeGreaterThan(poor);
  });

  it('services only need the pickup inside the area', () => {
    const svc = { ...base, kind: 'service' as const, detourKm: 30, pickupOffKm: 12, departure: null, arrival: null };
    expect(scoreMatch(svc).excluded).toBeUndefined();
    expect(scoreMatch({ ...svc, pickupOffKm: 45 }).excluded?.code).toBe('distance');
  });
});

describe('route matching against PostGIS', () => {
  it('matches pickups and drop-offs along the route, not just the endpoints', async () => {
    const driver = await makeUser('md', 'Toronto'), shipper = await makeUser('ms', 'Winnipeg');
    const j = await makeJourney(driver);
    const r = await makeRequest(shipper, { origin_city: 'Winnipeg', dest_city: 'Regina', pickup_from: ymd(3), pickup_to: ymd(6) });
    const m = await api().get(`/api/transport/requests/${r.id}/matches`).set(auth(shipper));
    expect(m.status).toBe(200);
    const hit = m.body.journeys.find((x: any) => x.journey.id === j.id);
    expect(hit).toBeTruthy();
    expect(hit.match.metrics.pickup_off_km).toBeLessThan(1);
    expect(hit.match.metrics.drop_off_km).toBeLessThan(1);
    expect(hit.match.reasons.join(' ')).toMatch(/Passes through your pickup city/);
    expect(hit.match.score).toBeGreaterThan(70);
  });

  it('does not assume a straight line: a waypoint far from the direct line still matches', async () => {
    const driver = await makeUser('wd', 'Toronto'), shipper = await makeUser('ws', 'Ottawa');
    // Toronto → Ottawa → Montreal: Ottawa is nowhere near the straight Toronto–Montreal line? (it's close) so test an obvious detour:
    const j = await makeJourney(driver, { origin_city: 'Toronto', dest_city: 'Vancouver', waypoints: [{ city: 'Sudbury' }, { city: 'Winnipeg' }, { city: 'Edmonton' }] });
    const r = await makeRequest(shipper, { origin_city: 'Edmonton', dest_city: 'Vancouver', weight_kg: 20 });
    const m = (await api().get(`/api/transport/requests/${r.id}/matches`).set(auth(shipper))).body;
    expect(m.journeys.map((x: any) => x.journey.id)).toContain(j.id);
    const straight = await makeJourney(await makeUser('wd2', 'Toronto'), { origin_city: 'Toronto', dest_city: 'Vancouver', waypoints: [] });
    const m2 = (await api().get(`/api/transport/requests/${r.id}/matches`).set(auth(shipper))).body;
    const viaEdmonton = m2.journeys.find((x: any) => x.journey.id === j.id).match.score;
    const direct = m2.journeys.find((x: any) => x.journey.id === straight.id)?.match?.score ?? 0;
    expect(viaEdmonton).toBeGreaterThan(direct);   // the driver who actually passes through Edmonton is the better match
  });

  it('excludes journeys heading the wrong way', async () => {
    const driver = await makeUser('rd', 'Toronto'), shipper = await makeUser('rs', 'Calgary');
    const j = await makeJourney(driver);
    const r = await makeRequest(shipper, { origin_city: 'Calgary', dest_city: 'Winnipeg' });
    const m = (await api().get(`/api/transport/requests/${r.id}/matches`).set(auth(shipper))).body;
    expect(m.journeys.map((x: any) => x.journey.id)).not.toContain(j.id);
  });

  it('keeps near misses as partial matches with a warning, and drops far ones', async () => {
    const driver = await makeUser('pd', 'Toronto'), shipper = await makeUser('ps', 'Regina');
    const j = await makeJourney(driver, { max_detour_km: 25 });
    const near = await makeRequest(shipper, { origin_city: 'Swift Current', dest_city: 'Calgary' });   // ~40 km off the Regina–Calgary leg
    const far = await makeRequest(shipper, { origin_city: 'Edmonton', dest_city: 'Calgary' });
    const mn = (await api().get(`/api/transport/requests/${near.id}/matches`).set(auth(shipper))).body.journeys.find((x: any) => x.journey.id === j.id);
    expect(mn).toBeTruthy(); expect(mn.match.warnings.join(' ')).toMatch(/beyond the driver's 25 km detour limit/);
    expect((await api().get(`/api/transport/requests/${far.id}/matches`).set(auth(shipper))).body.journeys.map((x: any) => x.journey.id)).not.toContain(j.id);
  });

  it('respects dates, capacity and restrictions', async () => {
    const driver = await makeUser('cd', 'Toronto'), shipper = await makeUser('cs', 'Toronto');
    const small = await makeJourney(driver, { capacity_kg: 30, capacity_m3: 1 });
    const later = await makeJourney(driver, { departure_at: iso(40) });
    const noTires = await makeJourney(driver, { item_restrictions: ['tires'] });
    const good = await makeJourney(driver, { departure_at: iso(5) });
    const r = await makeRequest(shipper);
    const ids = (await api().get(`/api/transport/requests/${r.id}/matches`).set(auth(shipper))).body.journeys.map((x: any) => x.journey.id);
    expect(ids).toContain(good.id);
    for (const bad of [small, later, noTires]) expect(ids).not.toContain(bad.id);
  });

  it('shows drivers the requests they could serve, and keeps private requests out', async () => {
    const driver = await makeUser('jd', 'Toronto'), a = await makeUser('ja', 'Toronto'), b = await makeUser('jb', 'Toronto');
    const j = await makeJourney(driver);
    const pub = await makeRequest(a); const priv = await makeRequest(b, { visibility: 'private' });
    const m = (await api().get(`/api/transport/journeys/${j.id}/matches`).set(auth(driver))).body.requests.map((x: any) => x.request.id);
    expect(m).toContain(pub.id); expect(m).not.toContain(priv.id);
    expect((await api().get(`/api/transport/journeys/${j.id}/matches`).set(auth(a))).status).toBe(404);
    expect((await api().get(`/api/transport/requests/${pub.id}/matches`).set(auth(driver))).status).toBe(404);
  });

  it('browse by from/to finds journeys that pass through, in the right order', async () => {
    const driver = await makeUser('bd', 'Toronto'); const j = await makeJourney(driver);
    const q = (p: Record<string, string>) => api().get('/api/transport/journeys').query({ limit: 50, ...p });
    expect((await q({ from: 'Winnipeg', to: 'Calgary' })).body.items.map((x: any) => x.id)).toContain(j.id);
    expect((await q({ from: 'Calgary', to: 'Winnipeg' })).body.items.map((x: any) => x.id)).not.toContain(j.id);
    expect((await q({ from: 'Vancouver', to: 'Calgary', radius_km: '50' })).body.items.map((x: any) => x.id)).not.toContain(j.id);
    expect((await q({ from: 'Atlantis' })).status).toBe(400);
    expect((await q({ from: 'Toronto', to: 'Calgary', vehicle: 'cargo_van' })).body.items.map((x: any) => x.id)).not.toContain(j.id);
    expect((await q({ from: 'Toronto', min_capacity_kg: '1000' })).body.items.map((x: any) => x.id)).not.toContain(j.id);
  });
});
