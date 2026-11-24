import { describe, expect, it } from 'vitest';
import { api, auth, bookJourney, makeJourney, makeRequest, makeUser, PNG, until } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runHousekeeping } from '../src/lib/jobs.js';

async function setup() {
  const shipper = await makeUser('bsh', 'Toronto'), driver = await makeUser('bdr', 'Toronto'), outsider = await makeUser('bou');
  const request = await makeRequest(shipper), journey = await makeJourney(driver);
  const id = await bookJourney(shipper, driver, request, journey);
  const get = async (u: any) => (await api().get(`/api/bookings/${id}`).set(auth(u))).body;
  return { shipper, driver, outsider, request, journey, id, get };
}

describe('booking lifecycle (acceptance J)', () => {
  it('walks pickup → transit → delivery → completion with PINs, photos and a full timeline', async () => {
    const { shipper, driver, id, get } = await setup();
    let b = await get(shipper);
    expect(b.status).toBe('confirmed'); expect(b.pins.pickup).toMatch(/^\d{4}$/); expect(b.pins.delivery).toMatch(/^\d{4}$/); expect(b.pins.pickup).not.toBe(undefined);
    const dView = await get(driver);
    expect(dView.pins).toBeNull();                                  // the driver never sees the PINs
    expect(dView.actions).toEqual(expect.arrayContaining(['confirm_pickup', 'cancel']));
    // pickup needs the shipper's PIN
    expect((await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: b.pins.pickup === '1234' ? '4321' : '1234' })).status).toBe(403);
    const photo = (await api().post('/api/media').set(auth(driver)).attach('file', PNG, 'p.png')).body;
    const pk = await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: b.pins.pickup, photo_media_id: photo.id });
    expect(pk.status).toBe(200); expect(pk.body.status).toBe('pickup_confirmed');
    expect(pk.body.timeline.find((e: any) => e.kind === 'pickup_confirmed').photo_url).toContain('/media/');
    // transit updates
    const t1 = await api().post(`/api/bookings/${id}/transit`).set(auth(driver)).send({ note: 'Left Toronto', location_label: 'Toronto, ON' });
    expect(t1.body.status).toBe('in_transit');
    await api().post(`/api/bookings/${id}/transit`).set(auth(driver)).send({ note: 'Fuel stop', location_label: 'Sudbury, ON' });
    // the shipper cannot confirm delivery; wrong PIN fails; right PIN delivers
    expect((await api().post(`/api/bookings/${id}/deliver`).set(auth(shipper)).send({ pin: b.pins.delivery })).status).toBe(403);
    expect((await api().post(`/api/bookings/${id}/complete`).set(auth(shipper))).status).toBe(409);   // not delivered yet
    const dl = await api().post(`/api/bookings/${id}/deliver`).set(auth(driver)).send({ pin: b.pins.delivery });
    expect(dl.body.status).toBe('delivered');
    expect((await api().post(`/api/bookings/${id}/complete`).set(auth(driver))).status).toBe(403);
    const done = await api().post(`/api/bookings/${id}/complete`).set(auth(shipper));
    expect(done.body.status).toBe('completed');
    b = await get(shipper);
    expect(b.timeline.map((e: any) => e.kind)).toEqual(['booked', 'pickup_confirmed', 'in_transit', 'in_transit', 'delivered', 'completed']);
    expect((await pool.query(`SELECT status FROM transport_requests WHERE id=$1`, [b.shipment.request_id])).rows[0].status).toBe('completed');
    // no going back
    expect((await api().post(`/api/bookings/${id}/cancel`).set(auth(shipper)).send({ reason: 'changed my mind' })).status).toBe(409);
    expect((await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: '0000' })).status).toBe(409);
  });

  it('enforces the order of steps', async () => {
    const { driver, shipper, id, get } = await setup();
    const b = await get(shipper);
    expect((await api().post(`/api/bookings/${id}/transit`).set(auth(driver)).send({})).status).toBe(409);                       // before pickup
    expect((await api().post(`/api/bookings/${id}/deliver`).set(auth(driver)).send({ pin: b.pins.delivery })).status).toBe(409);   // before pickup
    expect((await api().post(`/api/bookings/${id}/pickup`).set(auth(shipper)).send({ pin: b.pins.pickup })).status).toBe(403);    // wrong party
    expect((await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: 'abcd' })).status).toBe(400);
  });

  it('locks out PIN guessing after repeated failures, even for the right PIN, until the lock expires', async () => {
    const { driver, shipper, id, get } = await setup();
    const real = (await get(shipper)).pins.pickup; const wrong = real === '0000' ? '1111' : '0000';
    for (let i = 0; i < 4; i++) expect((await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: wrong })).status).toBe(403);
    const fifth = await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: wrong });
    expect(fifth.status).toBe(429);
    expect((await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: real })).status).toBe(429);              // brute force can't win by timing
    expect((await get(shipper)).timeline.some((e: any) => e.kind === 'pin_locked')).toBe(true);
    await pool.query(`UPDATE bookings SET pin_locked_until = now() - interval '1 second' WHERE id=$1`, [id]);
    expect((await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: real })).status).toBe(200);
  });

  it('keeps addresses and PINs private to the two parties', async () => {
    const { shipper, driver, outsider, id, get, request } = await setup();
    expect((await api().get(`/api/bookings/${id}`).set(auth(outsider))).status).toBe(404);
    expect((await api().put(`/api/bookings/${id}/address`).set(auth(outsider)).send({ pickup_address: 'x' })).status).toBe(404);
    expect((await api().put(`/api/bookings/${id}/address`).set(auth(driver)).send({ pickup_address: 'x' })).status).toBe(403);
    const set = await api().put(`/api/bookings/${id}/address`).set(auth(shipper)).send({ pickup_address: '123 Maple St, Toronto', delivery_address: '55 Elm Ave, Calgary', contact_phone: '416-555-0100', pickup_notes: 'Side door' });
    expect(set.status).toBe(200);
    expect((await get(driver)).address).toMatchObject({ pickup_address: '123 Maple St, Toronto', delivery_address: '55 Elm Ave, Calgary', contact_phone: '416-555-0100' });
    // nothing leaks through any public surface
    for (const path of [`/api/transport/requests/${request.id}`, '/api/feed?tab=for_you&limit=30', '/api/transport/requests?limit=50', `/api/users/${shipper.username}`]) {
      const txt = JSON.stringify((await api().get(path)).body);
      expect(txt, path).not.toMatch(/123 Maple|55 Elm|416-555|pickup_pin|delivery_pin/);
    }
    const list = JSON.stringify((await api().get('/api/bookings').set(auth(driver))).body);
    expect(list).not.toMatch(/123 Maple|pickup_pin/);   // list view omits addresses and PINs entirely
  });

  it('cancelling before pickup frees the space; cancelling after pickup is not allowed', async () => {
    const { shipper, driver, id, get, journey } = await setup();
    const cancelled = await api().post(`/api/bookings/${id}/cancel`).set(auth(driver)).send({ reason: 'Truck broke down' });
    expect(cancelled.body.status).toBe('cancelled'); expect(cancelled.body.cancel).toMatchObject({ by: 'you', reason: 'Truck broke down' });
    expect((await get(shipper)).cancel.by).toBe('them');
    expect((await api().get(`/api/transport/journeys/${journey.id}`)).body.remaining_kg).toBe(400);
    expect((await api().post(`/api/bookings/${id}/cancel`).set(auth(driver)).send({ reason: 'again' })).status).toBe(409);
    // a transporter who cancels shows up in their reliability stats
    const stats = (await api().get(`/api/users/${driver.username}/transport`).set(auth(driver))).body.stats;
    expect(stats.cancelled_by_them).toBe(1);
    // fresh booking: after pickup, cancel is refused
    const s2 = await setup();
    const pin = (await s2.get(s2.shipper)).pins.pickup;
    await api().post(`/api/bookings/${s2.id}/pickup`).set(auth(s2.driver)).send({ pin });
    expect((await api().post(`/api/bookings/${s2.id}/cancel`).set(auth(s2.shipper)).send({ reason: 'too late' })).status).toBe(409);
  });

  it('reviews: both sides after completion, once each, and ratings feed reputation and matching', async () => {
    const { shipper, driver, outsider, id, get } = await setup();
    expect((await api().post(`/api/bookings/${id}/reviews`).set(auth(shipper)).send({ rating: 5 })).status).toBe(409);
    const b = await get(shipper);
    await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: b.pins.pickup });
    await api().post(`/api/bookings/${id}/deliver`).set(auth(driver)).send({ pin: b.pins.delivery });
    await api().post(`/api/bookings/${id}/complete`).set(auth(shipper));
    expect((await get(shipper)).actions).toContain('review');
    expect((await api().post(`/api/bookings/${id}/reviews`).set(auth(outsider)).send({ rating: 1 })).status).toBe(404);
    expect((await api().post(`/api/bookings/${id}/reviews`).set(auth(shipper)).send({ rating: 6 })).status).toBe(400);
    expect((await api().post(`/api/bookings/${id}/reviews`).set(auth(shipper)).send({ rating: 5, comment: 'Careful and on time' })).status).toBe(201);
    expect((await api().post(`/api/bookings/${id}/reviews`).set(auth(shipper)).send({ rating: 4 })).status).toBe(409);
    expect((await api().post(`/api/bookings/${id}/reviews`).set(auth(driver)).send({ rating: 4, comment: 'Easy handover' })).status).toBe(201);
    const dRev = (await api().get(`/api/users/${driver.username}/reviews`)).body;
    expect(dRev.summary).toEqual({ average: 5, count: 1 }); expect(dRev.items[0]).toMatchObject({ role: 'transporter', comment: 'Careful and on time' });
    expect((await api().get(`/api/users/${shipper.username}/reviews`).query({ role: 'shipper' })).body.summary.average).toBe(4);
    const profile = (await api().get(`/api/users/${driver.username}/transport`).set(auth(driver))).body;
    expect(profile.stats).toMatchObject({ rating_avg: 5, rating_count: 1, completed_as_transporter: 1 });
    // a new journey from this driver now shows the rating to shippers
    const j = await makeJourney(driver);
    expect((await api().get(`/api/transport/journeys/${j.id}`)).body.driver).toMatchObject({ rating_avg: 5, rating_count: 1, completed: 1 });
    // moderators can remove an abusive review and it stops counting
    const mod = await makeUser('rmod'); await pool.query(`INSERT INTO user_roles(user_id, role_key) VALUES ($1,'moderator')`, [mod.id]);
    const rid = dRev.items[0].id;
    expect((await api().post(`/api/admin/content/review/${rid}/remove`).set(auth(mod)).send({ reason: 'Abusive language' })).status).toBe(204);
    expect((await api().get(`/api/users/${driver.username}/reviews`)).body.summary.count).toBe(0);
  });

  it('hides transport history unless the user chooses to display it', async () => {
    const { shipper, driver } = await setup(); const viewer = await makeUser('hv');
    const pub = (await api().get(`/api/users/${driver.username}/transport`).set(auth(viewer))).body;
    expect(pub.history_visible).toBe(false); expect(pub.stats.completed_as_transporter).toBeUndefined();
    await api().patch('/api/me/profile').set(auth(driver)).send({ privacy: { show_transport_history: true } });
    const shown = (await api().get(`/api/users/${driver.username}/transport`).set(auth(viewer))).body;
    expect(shown.history_visible).toBe(true); expect(shown.stats.completed_as_transporter).toBe(0);
    expect(shown.upcoming_journeys.length).toBeGreaterThan(0);
    void shipper;
  });

  it('auto-completes delivered bookings after the configured delay', async () => {
    const { shipper, driver, id, get } = await setup();
    const b = await get(shipper);
    await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: b.pins.pickup });
    await api().post(`/api/bookings/${id}/deliver`).set(auth(driver)).send({ pin: b.pins.delivery });
    expect((await runHousekeeping()).bookings).toBe(0);
    await pool.query(`UPDATE bookings SET delivered_at = now() - interval '80 hours' WHERE id=$1`, [id]);
    expect((await runHousekeeping()).bookings).toBeGreaterThanOrEqual(1);
    const done = await get(shipper);
    expect(done.status).toBe('completed'); expect(done.timeline.at(-1).note).toMatch(/automatically/);
  });

  it('sends booking updates to the other party as notifications and chat cards', async () => {
    const { shipper, driver, id, get } = await setup();
    const b = await get(shipper);
    await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: b.pins.pickup });
    const notes = (await api().get('/api/notifications').set(auth(shipper))).body.items;
    expect(notes.some((n: any) => n.type === 'booking_update' && n.target_id === id)).toBe(true);
    const convs = (await api().get('/api/conversations').set(auth(shipper))).body.items;
    const msgs = (await api().get(`/api/conversations/${convs[0].id}/messages`).set(auth(shipper))).body.items;
    expect(msgs.filter((m: any) => m.kind === 'booking').map((m: any) => m.payload.event)).toContain('pickup_confirmed');
    await until(async () => true);
  });
});
