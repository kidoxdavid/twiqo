import { describe, expect, it } from 'vitest';
import { api, auth, bookJourney, makeJourney, makeRequest, makeUser, ymd, type TestUser } from './helpers.js';
import { pool } from '../src/db/pool.js';

const ids = (r: any[]) => r.map((x) => x.id);
const mine = (u: TestUser) => api().get('/api/offers').set(auth(u)).query({ role: 'sent', state: 'active' });
const dims = { length_cm: 40, width_cm: 40, height_cm: 40 };

describe('trip manifest (one plan for several shipments)', () => {
  async function plan() {
    const driver = await makeUser('mfd', 'Toronto'); const j = await makeJourney(driver, { capacity_kg: 400 });
    const mk = async (title: string, from: string, to: string, kg: number) => { const s = await makeUser('mfs', 'Toronto'); const r = await makeRequest(s, { title, origin_city: from, dest_city: to, weight_kg: kg, ...dims }); const bid = await bookJourney(s, driver, r, j, 9000); return { s, r, bid }; };
    const A = await mk('Load A', 'Toronto', 'Winnipeg', 100), B = await mk('Load B', 'Thunder Bay', 'Calgary', 50), C = await mk('Load C', 'Winnipeg', 'Regina', 80);
    return { driver, j, A, B, C };
  }
  it('orders pick-ups and drop-offs along the route, frees space before loading more, and tracks the load', async () => {
    const { driver, j, A, B } = await plan();
    await api().put(`/api/bookings/${A.bid}/address`).set(auth(A.s)).send({ pickup_address: '1 Start St', delivery_address: '2 Finish Ave', contact_phone: '4165550100' });
    const m = (await api().get(`/api/transport/journeys/${j.id}/manifest`).set(auth(driver))).body;
    expect(m.stops.map((s: any) => `${s.type} ${s.title.slice(-1)}`)).toEqual(['pickup A', 'pickup B', 'delivery A', 'pickup C', 'delivery C', 'delivery B']);
    expect(m.stops.map((s: any) => s.load_after_kg)).toEqual([100, 150, 50, 130, 50, 0]);
    expect(m.stops.map((s: any) => s.km_along)).toEqual([...m.stops.map((s: any) => s.km_along)].sort((a: number, b: number) => a - b));
    expect(m.summary).toMatchObject({ shipments: 3, total_agreed_cents: 27000, peak_kg: 150, loaded_kg: 230, utilisation_pct: 38, active: 3 });
    expect(m.next_stop).toMatchObject({ type: 'pickup', title: 'Load A' }); expect(m.warnings).toEqual([]);
    const a1 = m.stops[0]; expect(a1.address).toBe('1 Start St'); expect(a1.phone).toBe('4165550100'); expect(a1.eta_estimate).toBeTruthy();
    // doing the first pick-up moves "next" along
    const pins = (await api().get(`/api/bookings/${A.bid}`).set(auth(A.s))).body.pins; await api().post(`/api/bookings/${A.bid}/pickup`).set(auth(driver)).send({ pin: pins.pickup });
    const m2 = (await api().get(`/api/transport/journeys/${j.id}/manifest`).set(auth(driver))).body; expect(m2.next_stop).toMatchObject({ type: 'pickup', title: 'Load B' }); expect(m2.stops[0].done).toBe(true);
    expect((await api().get(`/api/transport/journeys/${j.id}/manifest`).set(auth(B.s))).status).toBe(404);   // only the driver
    expect((await api().get(`/api/transport/journeys/${j.id}/manifest`)).status).toBe(401);
  });
  it('warns about opposite-direction shipments and pick-up windows the trip cannot meet, and hides addresses once a job is complete', async () => {
    const { driver, j, A, C } = await plan();
    await pool.query(`UPDATE transport_requests SET origin=dest, dest=origin, origin_city=dest_city, dest_city=origin_city WHERE id=$1`, [C.r.id]);   // now travels Regina → Winnipeg: against the journey
    await pool.query(`UPDATE transport_requests SET pickup_from=$2, pickup_to=$3 WHERE id=$1`, [A.r.id, ymd(30), ymd(33)]);
    const m = (await api().get(`/api/transport/journeys/${j.id}/manifest`).set(auth(driver))).body;
    expect(m.warnings.some((w: string) => w.includes('against the direction'))).toBe(true); expect(m.warnings.some((w: string) => w.includes('outside the pick-up window'))).toBe(true);
    expect(m.stops.filter((s: any) => s.out_of_order).length).toBe(2);
    await api().put(`/api/bookings/${A.bid}/address`).set(auth(A.s)).send({ pickup_address: '1 Start St' });
    await pool.query(`UPDATE bookings SET status='completed' WHERE id=$1`, [A.bid]);
    const done = (await api().get(`/api/transport/journeys/${j.id}/manifest`).set(auth(driver))).body.stops.find((s: any) => s.booking_id === A.bid && s.type === 'pickup'); expect(done.address).toBeUndefined();
  });
});

describe('consolidation: the best set of shipments for the space left', () => {
  it('suggests the combination that fits and earns the most, never over capacity', async () => {
    const driver = await makeUser('cod', 'Toronto'); const j = await makeJourney(driver, { capacity_kg: 200, capacity_m3: 3 });
    const mk = async (title: string, kg: number, budget: number) => { const s = await makeUser('cos', 'Toronto'); return { s, r: await makeRequest(s, { title, weight_kg: kg, budget_cents: budget, ...dims }) }; };
    const A = await mk('Heavy', 150, 14000), B = await mk('Medium', 100, 9000), C = await mk('Light', 90, 8500), D = await mk('Too heavy', 250, 30000);
    const c = (await api().get(`/api/transport/journeys/${j.id}/consolidation`).set(auth(driver))).body;
    expect(ids(c.candidates)).toEqual(expect.arrayContaining([A.r.id, B.r.id, C.r.id])); expect(ids(c.candidates)).not.toContain(D.r.id);
    expect(c.best_bundle).toMatchObject({ shipments: 2, total_kg: 190, total_cents: 17500 }); expect(c.best_bundle.request_ids.sort()).toEqual([B.r.id, C.r.id].sort());
    expect(c.candidates.find((x: any) => x.id === A.r.id).in_best_bundle).toBe(false); expect(c.remaining.kg).toBe(200);
    expect((await api().get(`/api/transport/journeys/${j.id}/consolidation`).set(auth(A.s))).status).toBe(404);
  });
  it('driver offers the bundle in one action; the shippers see one bundle and the driver accept-all books every shipment', async () => {
    const driver = await makeUser('obd', 'Toronto'); const j = await makeJourney(driver, { capacity_kg: 300 });
    const mk = async (kg: number) => { const s = await makeUser('obs', 'Toronto'); return { s, r: await makeRequest(s, { weight_kg: kg, ...dims }) }; };
    const A = await mk(100), B = await mk(120);
    expect((await api().post(`/api/transport/journeys/${j.id}/offer-bundle`).set(auth(driver)).send({ items: [{ request_id: A.r.id, amount_cents: 9000 }] })).status).toBe(400);   // a bundle needs two or more
    const big = await mk(250); expect((await api().post(`/api/transport/journeys/${j.id}/offer-bundle`).set(auth(driver)).send({ items: [{ request_id: A.r.id, amount_cents: 9000 }, { request_id: big.r.id, amount_cents: 20000 }] })).body.error.code).toBe('does_not_fit');
    const b = await api().post(`/api/transport/journeys/${j.id}/offer-bundle`).set(auth(driver)).send({ items: [{ request_id: A.r.id, amount_cents: 9000 }, { request_id: B.r.id, amount_cents: 11000 }] }); expect(b.status).toBe(201);
    const bundleId = b.body.bundle_id; expect(b.body.offers).toHaveLength(2);
    const seen = (await api().get('/api/offers').set(auth(A.s)).query({ role: 'received', state: 'active' })).body.items.find((o: any) => o.bundle); expect(seen.bundle).toMatchObject({ id: bundleId, count: 2, total_cents: 20000 });
    // the first shipper accepts only their own offer through the normal route; the rest of the bundle stays open
    const one = b.body.offers.find((o: any) => o.customer.username === A.s.username); expect((await api().post(`/api/offers/${one.id}/accept`).set(auth(A.s))).status).toBe(200);
    expect((await api().post(`/api/offers/bundle/${bundleId}/accept`).set(auth(driver))).status).toBe(404);   // the driver proposed it, so can't accept it
    expect((await api().post(`/api/offers/bundle/${bundleId}/accept`).set(auth(B.s))).body.accepted).toHaveLength(1);
    expect((await pool.query('SELECT remaining_kg FROM journeys WHERE id=$1', [j.id])).rows[0].remaining_kg).toBe(80);
    expect((await api().post(`/api/offers/bundle/${bundleId}/accept`).set(auth(B.s))).status).toBe(404);   // nothing left to accept
  });
});

describe('shipper books several shipments together', () => {
  async function setup(over: Record<string, unknown> = {}) {
    const driver = await makeUser('bkd', 'Toronto'); const j = await makeJourney(driver, { capacity_kg: 400, ...over }); const shipper = await makeUser('bks', 'Toronto');
    const r1 = await makeRequest(shipper, { title: 'Sofa', weight_kg: 60, ...dims }), r2 = await makeRequest(shipper, { title: 'Boxes', weight_kg: 140, ...dims }); return { driver, j, shipper, r1, r2 };
  }
  it('splits one price across the shipments by weight and the driver accepts or declines them all at once', async () => {
    const { driver, j, shipper, r1, r2 } = await setup();
    const b = await api().post(`/api/transport/journeys/${j.id}/book-bundle`).set(auth(shipper)).send({ request_ids: [r1.id, r2.id], total_cents: 20001 }); expect(b.status).toBe(201);
    const amounts = b.body.offers.map((o: any) => o.amount_cents); expect(amounts.reduce((a: number, x: number) => a + x, 0)).toBe(20001);
    expect(b.body.offers.find((o: any) => o.subject.request.title === 'Boxes').amount_cents).toBeGreaterThan(b.body.offers.find((o: any) => o.subject.request.title === 'Sofa').amount_cents);   // heavier pays more
    const rej = await api().post(`/api/offers/bundle/${b.body.bundle_id}/reject`).set(auth(driver)).send({ reason: 'Not this week' }); expect(rej.body.rejected).toBe(2);
    const again = await api().post(`/api/transport/journeys/${j.id}/book-bundle`).set(auth(shipper)).send({ request_ids: [r1.id, r2.id], total_cents: 18000 });
    const acc = await api().post(`/api/offers/bundle/${again.body.bundle_id}/accept`).set(auth(driver)); expect(acc.body.accepted).toHaveLength(2); expect(acc.body.failed).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int n FROM bookings WHERE journey_id=$1`, [j.id])).rows[0].n).toBe(2); expect((await pool.query('SELECT remaining_kg FROM journeys WHERE id=$1', [j.id])).rows[0].remaining_kg).toBe(200);
    const m = (await api().get(`/api/transport/journeys/${j.id}/manifest`).set(auth(driver))).body; expect(m.summary).toMatchObject({ shipments: 2, total_agreed_cents: 18000 });
  });
  it('lets the shipper withdraw the whole bundle', async () => {
    const { j, shipper, r1, r2 } = await setup(); const b = await api().post(`/api/transport/journeys/${j.id}/book-bundle`).set(auth(shipper)).send({ request_ids: [r1.id, r2.id], total_cents: 15000 });
    expect((await api().post(`/api/offers/bundle/${b.body.bundle_id}/withdraw`).set(auth(shipper))).body.withdrawn).toBe(2); expect((await mine(shipper)).body.items).toHaveLength(0);
  });
  it('refuses what cannot work: fixed-price mismatch, too heavy together, someone else\'s shipment, and rolls back if one offer fails', async () => {
    const f = await setup({ price_type: 'fixed', price_cents: 8000 });
    const bad = await api().post(`/api/transport/journeys/${f.j.id}/book-bundle`).set(auth(f.shipper)).send({ request_ids: [f.r1.id, f.r2.id], total_cents: 12000 }); expect(bad.status).toBe(422); expect(bad.body.error.code).toBe('fixed_price');
    const ok = await api().post(`/api/transport/journeys/${f.j.id}/book-bundle`).set(auth(f.shipper)).send({ request_ids: [f.r1.id, f.r2.id], total_cents: 16000 }); expect(ok.status).toBe(201); expect(ok.body.offers.map((o: any) => o.amount_cents)).toEqual([8000, 8000]);
    const s = await setup({ capacity_kg: 150 }); expect((await api().post(`/api/transport/journeys/${s.j.id}/book-bundle`).set(auth(s.shipper)).send({ request_ids: [s.r1.id, s.r2.id], total_cents: 9000 })).body.error.code).toBe('does_not_fit');
    const other = await makeUser('oth', 'Toronto'); const theirs = await makeRequest(other, { weight_kg: 10, ...dims });
    expect((await api().post(`/api/transport/journeys/${s.j.id}/book-bundle`).set(auth(s.shipper)).send({ request_ids: [s.r1.id, theirs.id], total_cents: 9000 })).status).toBe(400);
    expect((await api().post(`/api/transport/journeys/${f.j.id}/book-bundle`).set(auth(f.shipper)).send({ request_ids: [f.r1.id, f.r1.id], total_cents: 9000 })).status).toBe(400);
    const r = await setup(); await api().post('/api/offers').set(auth(r.shipper)).send({ kind: 'transport', request_id: r.r2.id, journey_id: r.j.id, amount_cents: 9000 });   // an open offer already exists for the second shipment
    const fail = await api().post(`/api/transport/journeys/${r.j.id}/book-bundle`).set(auth(r.shipper)).send({ request_ids: [r.r1.id, r.r2.id], total_cents: 15000 }); expect(fail.status).toBe(409);
    const open = (await mine(r.shipper)).body.items; expect(open).toHaveLength(1); expect(open[0].bundle).toBeNull();   // only the earlier single offer remains: the bundle's first offer was withdrawn
  });
  it('books every shipment instantly when the driver offers instant book at a fixed price', async () => {
    const driver = await makeUser('ibd', 'Toronto'); await pool.query(`UPDATE user_profiles SET verification_level='identity', identity_verified_at=now() WHERE user_id=$1`, [driver.id]);
    const j = await makeJourney(driver, { price_type: 'fixed', price_cents: 7000, instant_book: true, capacity_kg: 400 }); const shipper = await makeUser('ibs', 'Toronto');
    await pool.query(`UPDATE users SET email_verified_at=now(), created_at = now() - interval '5 days' WHERE id=$1`, [shipper.id]);
    const r1 = await makeRequest(shipper, { weight_kg: 50, ...dims }), r2 = await makeRequest(shipper, { weight_kg: 60, ...dims });
    const b = await api().post(`/api/transport/journeys/${j.id}/book-bundle`).set(auth(shipper)).send({ request_ids: [r1.id, r2.id], total_cents: 14000 });
    expect(b.body.offers.every((o: any) => o.instant_booked && o.booking_id)).toBe(true); expect((await pool.query(`SELECT count(*)::int n FROM bookings WHERE journey_id=$1`, [j.id])).rows[0].n).toBe(2);
  });
});
