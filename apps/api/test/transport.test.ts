import { describe, expect, it } from 'vitest';
import { api, auth, bookJourney, iso, makeCategory, makeJourney, makeListing, makeRequest, makeService, makeUser, until, ymd } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runHousekeeping } from '../src/lib/jobs.js';

describe('transport listings', () => {
  it('validates requests: weight, dates, cities', async () => {
    const u = await makeUser('v');
    const post = (o: Record<string, unknown>) => api().post('/api/transport/requests').set(auth(u)).send({ title: 'Boxes', weight_kg: 10, origin_city: 'Toronto', dest_city: 'Calgary', pickup_from: ymd(2), pickup_to: ymd(4), ...o });
    expect((await post({})).status).toBe(201);
    expect((await post({ weight_kg: 0 })).status).toBe(400);
    expect((await post({ pickup_to: ymd(1) })).status).toBe(400);
    expect((await post({ pickup_from: ymd(-9), pickup_to: ymd(-8) })).status).toBe(400);
    expect((await post({ deliver_by: ymd(1) })).status).toBe(400);
    const bad = await post({ dest_city: 'Atlantis' }); expect(bad.status).toBe(400); expect(bad.body.error.code).toBe('unknown_place');
    expect((await api().post('/api/transport/requests').send({})).status).toBe(401);
  });

  it('exposes only city-level places publicly; exact addresses never appear', async () => {
    const u = await makeUser('priv'); const r = await makeRequest(u, { pickup_area: 'Beltline' });
    const pub = JSON.stringify((await api().get(`/api/transport/requests/${r.id}`)).body);
    expect(pub).toContain('Beltline'); expect(pub).not.toMatch(/pickup_address|delivery_address|contact_phone/);
    expect(r.origin).toMatchObject({ city: 'Toronto', province: 'ON' });
  });

  it('private requests are visible only to their owner and never in browse or the feed', async () => {
    const owner = await makeUser('po'), other = await makeUser('pv');
    const r = await makeRequest(owner, { visibility: 'private', title: 'Secret couch move' });
    expect((await api().get(`/api/transport/requests/${r.id}`).set(auth(other))).status).toBe(404);
    expect((await api().get(`/api/transport/requests/${r.id}`).set(auth(owner))).status).toBe(200);
    expect((await api().get('/api/transport/requests').query({ q: 'Secret' }).set(auth(other))).body.items).toHaveLength(0);
    expect((await api().get('/api/transport/requests').query({ mine: '1' }).set(auth(owner))).body.items.map((x: any) => x.id)).toContain(r.id);
    const feed = (await api().get('/api/feed').query({ tab: 'for_you', limit: 30 }).set(auth(other))).body.items;
    expect(feed.find((i: any) => i.id === r.id)).toBeUndefined();
  });

  it('shows journeys, requests and services in the home feed', async () => {
    const d = await makeUser('fd'), s = await makeUser('fs'), p = await makeUser('fp');
    const j = await makeJourney(d), r = await makeRequest(s), v = await makeService(p);
    const feed = (await api().get('/api/feed').query({ tab: 'for_you', limit: 30 })).body.items;
    expect(feed.find((i: any) => i.id === j.id)?.type).toBe('journey');
    expect(feed.find((i: any) => i.id === r.id)?.type).toBe('transport_request');
    expect(feed.find((i: any) => i.id === v.id)?.type).toBe('transport_service');
  });

  it('browses requests by route, date, category and weight', async () => {
    const u = await makeUser('br');
    const r = await makeRequest(u, { title: 'Browsable fridge', item_category: 'appliances', weight_kg: 80, origin_city: 'Calgary', dest_city: 'Edmonton', pickup_from: ymd(10), pickup_to: ymd(12) });
    const ids = async (q: Record<string, string>) => (await api().get('/api/transport/requests').query({ limit: 50, ...q })).body.items.map((x: any) => x.id);
    expect(await ids({ from: 'Airdrie', to: 'Red Deer', radius_km: '200' })).toContain(r.id);
    expect(await ids({ from: 'Vancouver' })).not.toContain(r.id);
    expect(await ids({ category: 'appliances', q: 'fridge' })).toContain(r.id);
    expect(await ids({ category: 'tires', q: 'fridge' })).not.toContain(r.id);
    expect(await ids({ date_from: ymd(13) })).not.toContain(r.id);
    expect(await ids({ date_to: ymd(11), date_from: ymd(9) })).toContain(r.id);
    expect(await ids({ max_weight_kg: '50', q: 'fridge' })).not.toContain(r.id);
  });

  it('publishes a Toronto → Calgary journey with a real route and searchable capacity (acceptance D)', async () => {
    const d = await makeUser('dd', 'Toronto');
    const j = await makeJourney(d);
    expect(j.distance_km).toBeGreaterThan(2500); expect(j.distance_km).toBeLessThan(3600);
    expect(j.remaining_kg).toBe(400); expect(j.origin.city).toBe('Toronto'); expect(j.destination.city).toBe('Calgary');
    expect(j.waypoints.map((w: any) => w.city)).toEqual(['Thunder Bay', 'Winnipeg', 'Regina']);
    expect((await api().post('/api/transport/journeys').set(auth(d)).send({ origin_city: 'Toronto', dest_city: 'Toronto', departure_at: iso(3), vehicle_type: 'car', capacity_kg: 50, price_cents: 100 })).status).toBe(400);
    expect((await api().post('/api/transport/journeys').set(auth(d)).send({ origin_city: 'Toronto', dest_city: 'Calgary', departure_at: iso(-1), vehicle_type: 'car', capacity_kg: 50, price_cents: 100 })).status).toBe(400);
  });

  it('only the driver can edit; capacity cannot drop below what is reserved', async () => {
    const d = await makeUser('ed'), s = await makeUser('es'), x = await makeUser('ex');
    const j = await makeJourney(d, { capacity_kg: 100 }); const r = await makeRequest(s, { weight_kg: 40 });
    expect((await api().patch(`/api/transport/journeys/${j.id}`).set(auth(x)).send({ price_cents: 1 })).status).toBe(404);
    await bookJourney(s, d, r, j);
    expect((await api().patch(`/api/transport/journeys/${j.id}`).set(auth(d)).send({ capacity_kg: 30 })).status).toBe(409);
    const ok = await api().patch(`/api/transport/journeys/${j.id}`).set(auth(d)).send({ capacity_kg: 150 });
    expect(ok.body.capacity_kg).toBe(150); expect(ok.body.remaining_kg).toBe(110);
    expect((await api().patch(`/api/transport/journeys/${j.id}`).set(auth(d)).send({ departure_at: iso(9) })).status).toBe(409);
    expect((await api().delete(`/api/transport/journeys/${j.id}`).set(auth(d))).status).toBe(409);   // has an active booking
  });

  it('lets a pickup-truck owner advertise a local service and receive a booking (acceptance E)', async () => {
    const p = await makeUser('sp', 'Calgary'), s = await makeUser('ss', 'Calgary');
    const svc = await makeService(p);
    const r = await makeRequest(s, { title: 'Sofa across town', item_category: 'furniture', weight_kg: 60, origin_city: 'Calgary', dest_city: 'Airdrie', length_cm: 220, width_cm: 90, height_cm: 90, needs_loading_help: true });
    const m = (await api().get(`/api/transport/requests/${r.id}/matches`).set(auth(s))).body.services;
    const hit = m.find((x: any) => x.service.id === svc.id);
    expect(hit.match.reasons.join(' ')).toMatch(/inside the service area/); expect(hit.match.reasons.join(' ')).toMatch(/Offers loading help/);
    const o = await api().post('/api/offers').set(auth(s)).send({ kind: 'transport', request_id: r.id, service_id: svc.id, amount_cents: 7000 });
    expect(o.status).toBe(201);
    const acc = await api().post(`/api/offers/${o.body.id}/accept`).set(auth(p));
    expect(acc.status).toBe(200); expect(acc.body.booking_id).toBeTruthy();
    const b = (await api().get(`/api/bookings/${acc.body.booking_id}`).set(auth(p))).body;
    expect(b.carrier.type).toBe('service'); expect(b.agreed_cents).toBe(7000);
    // a request far outside the service area is not bookable
    const far = await makeRequest(s, { origin_city: 'Vancouver', dest_city: 'Kelowna' });
    expect((await api().post('/api/offers').set(auth(s)).send({ kind: 'transport', request_id: far.id, service_id: svc.id, amount_cents: 7000 })).status).toBe(422);
  });

  it('negotiates space for four tyres, separately from the price of the tyres (acceptance D + A)', async () => {
    const cat = await makeCategory();
    const seller = await makeUser('ts', 'Toronto'), buyer = await makeUser('tb', 'Calgary'), driver = await makeUser('td', 'Toronto');
    const listing = await makeListing(seller, cat, { title: 'Winter tires', price_cents: 52000, city: 'Toronto' });
    // 1) negotiate the goods
    const g = (await api().post('/api/offers').set(auth(buyer)).send({ kind: 'goods', listing_id: listing.id, amount_cents: 45000 })).body;
    const gAcc = await api().post(`/api/offers/${g.id}/accept`).set(auth(seller)); expect(gAcc.body.order_id).toBeTruthy();
    // 2) request transport linked to that listing, then negotiate with a driver
    const req = await makeRequest(buyer, { linked_listing_id: listing.id, origin_city: 'Toronto', dest_city: 'Calgary' });
    expect(req.linked_listing.id).toBe(listing.id);
    const j = await makeJourney(driver);
    const o = (await api().post('/api/offers').set(auth(buyer)).send({ kind: 'transport', request_id: req.id, journey_id: j.id, amount_cents: 7000, message: 'Four tires, 36 kg' })).body;
    const c = (await api().post(`/api/offers/${o.id}/counter`).set(auth(driver)).send({ amount_cents: 8500 })).body;
    const c2 = (await api().post(`/api/offers/${c.id}/counter`).set(auth(buyer)).send({ amount_cents: 8000 })).body;
    const acc = (await api().post(`/api/offers/${c2.id}/accept`).set(auth(driver))).body;
    const order = (await api().get(`/api/orders/${gAcc.body.order_id}`).set(auth(buyer))).body;
    const booking = (await api().get(`/api/bookings/${acc.booking_id}`).set(auth(buyer))).body;
    expect(order.total_cents).toBe(45000); expect(booking.agreed_cents).toBe(8000);          // two independent prices
    expect(order.transport_request.id).toBe(req.id);
    expect((await api().get(`/api/transport/journeys/${j.id}`)).body.remaining_kg).toBe(364);   // 400 - 36
  });

  it('refuses offers that do not fit, and counts fixed prices', async () => {
    const d = await makeUser('fd2'), s = await makeUser('fs2');
    const j = await makeJourney(d, { capacity_kg: 30, price_type: 'fixed', price_cents: 5000 });
    const big = await makeRequest(s, { weight_kg: 36 });
    const r = await api().post('/api/offers').set(auth(s)).send({ kind: 'transport', request_id: big.id, journey_id: j.id, amount_cents: 5000 });
    expect(r.status).toBe(422); expect(r.body.error.message).toMatch(/Needs 36 kg but only 30 kg/);
    const j2 = await makeJourney(d, { price_type: 'fixed', price_cents: 5000 });
    expect((await api().post('/api/offers').set(auth(s)).send({ kind: 'transport', request_id: big.id, journey_id: j2.id, amount_cents: 4000 })).status).toBe(422);
    expect((await api().post('/api/offers').set(auth(s)).send({ kind: 'transport', request_id: big.id, journey_id: j2.id, amount_cents: 5000 })).status).toBe(201);
    expect((await api().post('/api/offers').set(auth(d)).send({ kind: 'transport', request_id: big.id, journey_id: j2.id, amount_cents: 5000 })).status).toBe(409);   // an open offer for this exact shipment and journey already exists
  });

  it('lets a transporter offer on a public request, and the shipper accepts', async () => {
    const s = await makeUser('rs2'), d = await makeUser('rd2'); const j = await makeJourney(d);
    const r = await makeRequest(s);
    const o = await api().post('/api/offers').set(auth(d)).send({ kind: 'transport', request_id: r.id, journey_id: j.id, amount_cents: 8800, message: 'I pass through that way' });
    expect(o.status).toBe(201); expect(o.body.my_role).toBe('provider');
    expect((await api().post(`/api/offers/${o.body.id}/accept`).set(auth(d))).status).toBe(403);   // proposer cannot accept their own
    const acc = await api().post(`/api/offers/${o.body.id}/accept`).set(auth(s));
    expect(acc.status).toBe(200);
    const priv = await makeRequest(await makeUser('pr3'), { visibility: 'private' });
    expect((await api().post('/api/offers').set(auth(d)).send({ kind: 'transport', request_id: priv.id, amount_cents: 5000 })).status).toBe(404);
  });

  it('prevents double booking of one shipment: concurrent accepts from two drivers yield exactly one booking', async () => {
    const s = await makeUser('db-s'), d1 = await makeUser('db-1'), d2 = await makeUser('db-2');
    const j1 = await makeJourney(d1), j2 = await makeJourney(d2); const r = await makeRequest(s);
    const o1 = (await api().post('/api/offers').set(auth(s)).send({ kind: 'transport', request_id: r.id, journey_id: j1.id, amount_cents: 9000 })).body;
    const o2 = (await api().post('/api/offers').set(auth(s)).send({ kind: 'transport', request_id: r.id, journey_id: j2.id, amount_cents: 9000 })).body;
    const res = await Promise.all([api().post(`/api/offers/${o1.id}/accept`).set(auth(d1)), api().post(`/api/offers/${o2.id}/accept`).set(auth(d2))]);
    expect(res.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await pool.query(`SELECT count(*)::int n FROM bookings WHERE request_id=$1 AND status <> 'cancelled'`, [r.id])).rows[0].n).toBe(1);
    const loser = res[0].status === 200 ? j2 : j1;
    expect((await api().get(`/api/transport/journeys/${loser.id}`)).body.remaining_kg).toBe(400);   // the loser's capacity was untouched
    await expect(pool.query(`INSERT INTO bookings(offer_id,request_id,shipper_id,transporter_id,agreed_cents,pickup_pin,delivery_pin) SELECT id, request_id, customer_id, provider_id, 1, '0000','0000' FROM offers WHERE id=$1`, [res[0].status === 200 ? o2.id : o1.id])).rejects.toThrow(/bookings_one_active_per_request/);
  });

  it('never over-reserves capacity: two shippers racing for the last space', async () => {
    const d = await makeUser('oc-d'), a = await makeUser('oc-a'), b = await makeUser('oc-b');
    const j = await makeJourney(d, { capacity_kg: 50 });
    const ra = await makeRequest(a, { weight_kg: 30 }), rb = await makeRequest(b, { weight_kg: 30 });
    const oa = (await api().post('/api/offers').set(auth(a)).send({ kind: 'transport', request_id: ra.id, journey_id: j.id, amount_cents: 8000 })).body;
    const ob = (await api().post('/api/offers').set(auth(b)).send({ kind: 'transport', request_id: rb.id, journey_id: j.id, amount_cents: 8000 })).body;
    const res = await Promise.all([api().post(`/api/offers/${oa.id}/accept`).set(auth(d)), api().post(`/api/offers/${ob.id}/accept`).set(auth(d))]);
    expect(res.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await pool.query('SELECT remaining_kg FROM journeys WHERE id=$1', [j.id])).rows[0].remaining_kg).toBe(20);
  });

  it('marks a journey full when space runs out, and reopens it when a booking is cancelled', async () => {
    const d = await makeUser('fl-d'), s = await makeUser('fl-s'), s2 = await makeUser('fl-s2'); const j = await makeJourney(d, { capacity_kg: 36 });
    const r = await makeRequest(s, { weight_kg: 36 });
    const bid = await bookJourney(s, d, r, j);
    expect((await api().get(`/api/transport/journeys/${j.id}`)).body.status).toBe('full');
    expect((await api().get('/api/transport/journeys').query({ from: 'Toronto', limit: 50 })).body.items.map((x: any) => x.id)).not.toContain(j.id);
    const r2 = await makeRequest(s2, { weight_kg: 5 });
    expect((await api().post('/api/offers').set(auth(s2)).send({ kind: 'transport', request_id: r2.id, journey_id: j.id, amount_cents: 5000 })).status).toBe(404);
    await api().post(`/api/bookings/${bid}/cancel`).set(auth(s)).send({ reason: 'Plans changed' });
    const after = (await api().get(`/api/transport/journeys/${j.id}`)).body; expect(after.status).toBe('open'); expect(after.remaining_kg).toBe(36);
    expect((await api().get(`/api/transport/requests/${r.id}`).set(auth(s))).body.status).toBe('open');   // shipment is bookable again
  });

  it('closes pending offers when a request is cancelled or a journey departs', async () => {
    const d = await makeUser('cl-d'), s = await makeUser('cl-s'); const j = await makeJourney(d); const r = await makeRequest(s);
    const o = (await api().post('/api/offers').set(auth(s)).send({ kind: 'transport', request_id: r.id, journey_id: j.id, amount_cents: 9000 })).body;
    expect((await api().post(`/api/transport/journeys/${j.id}/depart`).set(auth(d))).status).toBe(204);
    expect((await api().get(`/api/offers/${o.id}`).set(auth(s))).body.offer.status).toBe('rejected');
    const r2 = await makeRequest(s); const j2 = await makeJourney(d);
    const o2 = (await api().post('/api/offers').set(auth(s)).send({ kind: 'transport', request_id: r2.id, journey_id: j2.id, amount_cents: 9000 })).body;
    expect((await api().delete(`/api/transport/requests/${r2.id}`).set(auth(s))).status).toBe(204);
    expect((await api().get(`/api/offers/${o2.id}`).set(auth(s))).body.offer.status).toBe('rejected');
  });

  it('comments, likes and saves work on transport objects', async () => {
    const d = await makeUser('cm-d'), u = await makeUser('cm-u'); const j = await makeJourney(d);
    expect((await api().post('/api/comments').set(auth(u)).send({ target_type: 'journey', target_id: j.id, body: 'Can you take a bike?' })).status).toBe(201);
    expect((await api().put(`/api/reactions/journey/${j.id}`).set(auth(u))).body.like_count).toBe(1);
    expect((await api().put(`/api/saves/journey/${j.id}`).set(auth(u))).status).toBe(204);
    const got = (await api().get(`/api/transport/journeys/${j.id}`).set(auth(u))).body;
    expect(got.counts).toMatchObject({ likes: 1, comments: 1, saves: 1 }); expect(got.viewer.saved).toBe(true);
    expect((await api().get('/api/me/saved').set(auth(u))).body.items.map((x: any) => x.id)).toContain(j.id);
  });

  it('notifies matching drivers, matching shippers and followers — and respects preferences (acceptance I)', async () => {
    const driver = await makeUser('nt-d', 'Toronto'), shipper = await makeUser('nt-s', 'Toronto'), fan = await makeUser('nt-f'), quiet = await makeUser('nt-q');
    await api().post(`/api/follows/user/${driver.id}`).set(auth(fan)); await api().post(`/api/follows/user/${driver.id}`).set(auth(quiet));
    await api().put('/api/me/notification-preferences').set(auth(quiet)).send({ type: 'journey_posted', enabled: false });
    const r = await makeRequest(shipper);
    const j = await makeJourney(driver);
    const types = async (u: any) => (await api().get('/api/notifications').set(auth(u))).body.items;
    await until(async () => (await types(shipper)).some((n: any) => n.type === 'match' && n.target_id === j.id));
    expect((await types(fan)).some((n: any) => n.type === 'journey_posted' && n.target_id === j.id)).toBe(true);
    expect((await types(quiet)).some((n: any) => n.type === 'journey_posted')).toBe(false);
    const prefs = (await api().get('/api/me/notification-preferences').set(auth(quiet))).body.items;
    expect(prefs.find((p: any) => p.type === 'journey_posted').enabled).toBe(false);
    const driver2 = await makeUser('nt-d2', 'Toronto');
    await makeJourney(driver2);   // posted AFTER the request exists → the request owner also hears about it, deduped per pair
    await until(async () => (await types(shipper)).filter((n: any) => n.type === 'match').length >= 2);
    void r;
  });

  it('expires stale requests and departed journeys via housekeeping', async () => {
    const d = await makeUser('hk-d'), s = await makeUser('hk-s'); const j = await makeJourney(d); const r = await makeRequest(s);
    await pool.query(`UPDATE journeys SET departure_at = now() - interval '1 hour' WHERE id=$1`, [j.id]);
    await pool.query(`UPDATE transport_requests SET pickup_from = current_date - 10, pickup_to = current_date - 5 WHERE id=$1`, [r.id]);
    const out = await runHousekeeping();
    expect(out.journeys).toBeGreaterThanOrEqual(1); expect(out.requests).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT status FROM journeys WHERE id=$1', [j.id])).rows[0].status).toBe('departed');
    expect((await pool.query('SELECT status FROM transport_requests WHERE id=$1', [r.id])).rows[0].status).toBe('expired');
  });
});
