import { describe, expect, it } from 'vitest';
import { api, auth, bookJourney, makeCategory, makeJourney, makeListing, makeRequest, makeStaff, makeUser, PNG, type TestUser } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runHousekeeping } from '../src/lib/jobs.js';
import { runQueue } from '../src/lib/queue.js';
import { scanText } from '../src/lib/risk.js';
import { assertDriverAllowed, driverTrust, missingDriverRequirements } from '../src/modules/trust.js';

const drain = async () => { for (let i = 0; i < 20; i++) { const r = await runQueue(200, { kinds: ['send_email', 'deliver_notification'] }); if (!r.ran && !r.failed) break; } };
const old = (u: TestUser) => pool.query(`UPDATE users SET created_at = now() - interval '30 days' WHERE id=$1`, [u.id]);
const verifyEmail = (u: TestUser) => pool.query(`UPDATE users SET email_verified_at=now() WHERE id=$1`, [u.id]);
const uploadDoc = (u: TestUser, kind = 'drivers_licence', expires = '2099-01-01') => api().post('/api/driver/documents').set(auth(u)).field('kind', kind).field('expires_on', expires).attach('file', PNG, 'licence.png');

describe('scam heuristics, review queue and limits', () => {
  it('explains what it found in text', () => {
    expect(scanText('Pay me first by e-transfer and I will ship').reasons).toContain('offplatform_payment');
    expect(scanText("I'm out of the country, my agent will pick it up").reasons).toEqual(expect.arrayContaining(['shipping_scam']));
    expect(scanText('Call 403-555-0100 or email me@x.com').reasons).toEqual(expect.arrayContaining(['phone_number', 'email_address']));
    expect(scanText('Solid oak desk, two drawers, good condition').score).toBe(0);
  });
  it('holds suspicious listings for review, lists them for staff, and lets staff resolve them', async () => {
    const u = await makeUser('scm'); const mod = await makeStaff('moderator'); const cat = await makeCategory();
    const bad = await makeListing(u, cat, { title: 'iPhone 15 cheap', description: 'Pay me first by e-transfer, I am out of the country and my agent will pick it up' });
    expect(bad.status).toBe('pending_review');
    const ok = await makeListing(u, cat, { title: 'Oak desk', description: 'Solid oak desk with two drawers' }); expect(ok.status).toBe('active');
    const q = (await api().get('/api/admin/risk').set(auth(mod))).body.items.find((r: any) => r.entity_id === bad.id);
    expect(q.reasons).toEqual(expect.arrayContaining(['offplatform_payment', 'shipping_scam'])); expect(q.username).toBe(u.username);
    expect((await api().get('/api/admin/risk').set(auth(u))).status).toBe(403);
    expect((await api().post(`/api/admin/risk/${q.id}/resolve`).set(auth(mod)).send({ status: 'actioned', note: 'Removed' })).status).toBe(204);
    expect((await api().post(`/api/admin/risk/${q.id}/resolve`).set(auth(mod)).send({ status: 'dismissed' })).status).toBe(404);
  });
  it('flags a long description copied from another seller, and a price far below market', async () => {
    const a = await makeUser('dup'), b = await makeUser('dub'); const cat = await makeCategory(); const desc = 'Barely used espresso machine with milk frother, steam wand and two portafilters. Includes the original box.';
    const first = await makeListing(a, cat, { title: 'Espresso machine Gaggia', description: desc }); expect(first.status).toBe('active');
    expect((await makeListing(b, cat, { title: 'Espresso machine Gaggia', description: desc })).status).toBe('pending_review');
    await pool.query(`INSERT INTO listings(seller_id,category_id,title,description,price_cents) SELECT $1,$2,'Market item '||g,'x',100000 FROM generate_series(1,12) g`, [a.id, cat]);
    expect((await makeListing(b, cat, { title: 'Cheap camera body', description: 'Camera body with charger', price_cents: 8000 })).status).toBe('active');   // a low price alone is not enough to hold a listing
    expect((await makeListing(b, cat, { title: 'Brand new camera body', description: 'Camera body, text me at 403-555-0199', price_cents: 8000 })).status).toBe('pending_review');   // low price plus contact details is
    expect((await makeListing(b, cat, { title: 'Fair priced camera lens', description: 'A lens', price_cents: 90000 })).status).toBe('active');
  });
  it('limits how many identical listings and how many listings a new account can post', async () => {
    const u = await makeUser('spm'); const cat = await makeCategory(); await old(u);
    for (let i = 0; i < 5; i++) expect((await api().post('/api/listings').set(auth(u)).send({ title: 'Same chair', description: 'x', category_id: cat, price_cents: 1000, price_type: 'fixed' })).status).toBe(201);
    const sixth = await api().post('/api/listings').set(auth(u)).send({ title: 'Same chair', description: 'x', category_id: cat, price_cents: 1000, price_type: 'fixed' }); expect(sixth.status).toBe(409);
    const fresh = await makeUser('new'); const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await api().post('/api/listings').set(auth(fresh)).send({ title: `Fresh thing ${i}`, description: 'x', category_id: cat, price_cents: 1000, price_type: 'fixed' })).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
  });
  it('warns only the receiver of a message that asks to pay outside twiqo, and queues it for staff', async () => {
    const a = await makeUser('msa'), b = await makeUser('msb'); const conv = (await api().post('/api/conversations').set(auth(a)).send({ recipient_id: b.id })).body.id;
    await api().post(`/api/conversations/${conv}/messages`).set(auth(a)).send({ body: 'Please e-transfer first, then my agent will collect it' });
    await api().post(`/api/conversations/${conv}/messages`).set(auth(a)).send({ body: 'Is it still available?' });
    const seen = (u: TestUser) => api().get(`/api/conversations/${conv}/messages`).set(auth(u)).then((r) => r.body.items);
    const forB = await seen(b); expect(forB[0].warning).toContain('outside twiqo'); expect(forB[1].warning).toBeUndefined();
    expect((await seen(a))[0].warning).toBeUndefined();
    expect((await pool.query(`SELECT count(*)::int n FROM risk_events WHERE entity_type='message' AND user_id=$1`, [a.id])).rows[0].n).toBe(1);
  });
});

describe('identity verification', () => {
  it('starts a check, marks the profile verified when the provider says so, and is idempotent', async () => {
    const u = await makeUser('idv'); expect((await api().get('/api/identity/status').set(auth(u))).body.verified).toBe(false);
    const s = await api().post('/api/identity/start').set(auth(u)); expect(s.body.url).toContain('fake_identity=vs_fake_');
    expect((await api().post('/api/identity/fake/complete').set(auth(u)).send({ outcome: 'requires_input' })).status).toBe(200);
    expect((await pool.query('SELECT verification_level FROM user_profiles WHERE user_id=$1', [u.id])).rows[0].verification_level).not.toBe('identity');
    await api().post('/api/identity/start').set(auth(u));
    const sid = (await pool.query(`SELECT provider_session_id FROM identity_verifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [u.id])).rows[0].provider_session_id;
    const ev = { id: `evt_idv_${Date.now()}`, type: 'identity.updated', identity: { sessionId: sid, userId: u.id, status: 'verified' } };
    const hook = () => api().post('/api/webhooks/stripe').set('x-fake-signature', 'fake-webhook-secret').set('Content-Type', 'application/json').send(JSON.stringify(ev));
    expect((await hook()).body.outcome).toBe('applied'); expect((await hook()).body.outcome).toBe('duplicate');
    expect((await api().get('/api/identity/status').set(auth(u))).body.verified).toBe(true); expect((await driverTrust(u.id)).identity).toBe(true);
    expect((await api().post('/api/identity/start').set(auth(u))).status).toBe(409);
    await pool.query(`UPDATE identity_verifications SET status='requires_input' WHERE provider_session_id=$1`, [sid]);   // a late "failed" event never un-verifies
    await api().post('/api/webhooks/stripe').set('x-fake-signature', 'fake-webhook-secret').set('Content-Type', 'application/json').send(JSON.stringify({ id: `evt_idv2_${Date.now()}`, type: 'identity.updated', identity: { sessionId: sid, status: 'requires_input' } }));
    expect((await api().get('/api/identity/status').set(auth(u))).body.verified).toBe(true);
  });
});

describe('driver documents', () => {
  it('keeps documents private, lets reviewers approve or reject, and shows only badges to others', async () => {
    const d = await makeUser('doc'), other = await makeUser('oth'), rev = await makeStaff('moderator');
    expect((await uploadDoc(d, 'drivers_licence', '2020-01-01')).status).toBe(400);
    const up = await uploadDoc(d); expect(up.status).toBe(201);
    const file = await api().get(`/api/driver/documents/${up.body.id}/file`).set(auth(d)); expect(file.status).toBe(200); expect(file.headers['content-type']).toBe('image/jpeg'); expect(file.headers['cache-control']).toContain('no-store');
    expect((await api().get(`/api/driver/documents/${up.body.id}/file`).set(auth(other))).status).toBe(404); expect((await api().get(`/api/driver/documents/${up.body.id}/file`)).status).toBe(401);
    expect((await api().get(`/api/driver/documents/${up.body.id}/file`).set(auth(rev))).status).toBe(200);
    expect((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE action='document.viewed' AND target_id=$1`, [up.body.id])).rows[0].n).toBe(1);
    expect((await driverTrust(d.id)).licence).toBe(false);                                                    // pending is not a badge
    expect((await api().get('/api/admin/driver-documents').set(auth(d))).status).toBe(403);
    expect((await api().get('/api/admin/driver-documents').set(auth(rev))).body.items.some((x: any) => x.id === up.body.id)).toBe(true);
    expect((await api().post(`/api/admin/driver-documents/${up.body.id}/review`).set(auth(rev)).send({ decision: 'reject' })).status).toBe(400);   // reject needs a reason
    expect((await api().post(`/api/admin/driver-documents/${up.body.id}/review`).set(auth(rev)).send({ decision: 'reject', note: 'Photo is blurry' })).status).toBe(204);
    const up2 = await uploadDoc(d); expect((await api().post(`/api/admin/driver-documents/${up2.body.id}/review`).set(auth(rev)).send({ decision: 'approve' })).status).toBe(204);
    expect((await api().post(`/api/admin/driver-documents/${up2.body.id}/review`).set(auth(rev)).send({ decision: 'approve' })).status).toBe(409);
    expect((await driverTrust(d.id)).licence).toBe(true);
    const up3 = await uploadDoc(d, 'drivers_licence', '2098-01-01'); await api().post(`/api/admin/driver-documents/${up3.body.id}/review`).set(auth(rev)).send({ decision: 'approve' });
    expect((await pool.query(`SELECT status FROM driver_documents WHERE id=$1`, [up2.body.id])).rows[0].status).toBe('replaced');
    await drain(); expect((await api().get('/api/notifications').set(auth(d))).body.items.filter((n: any) => n.type === 'document_review').length).toBeGreaterThanOrEqual(2);
    const bad = await api().post('/api/driver/documents').set(auth(d)).field('kind', 'insurance').field('expires_on', '2099-01-01').attach('file', Buffer.from('not an image'), 'x.png'); expect(bad.status).toBe(422);
  });
  it('shows badges on journeys, computes missing requirements, and expires old documents in housekeeping', async () => {
    const d = await makeUser('bdg'), rev = await makeStaff('admin'); const j = await makeJourney(d);
    expect((await api().get(`/api/transport/journeys/${j.id}`)).body.driver.trust).toEqual({ identity: false, licence: false, insurance: false });
    expect(await missingDriverRequirements(d.id)).toEqual(['identity', 'drivers_licence']);
    await expect(assertDriverAllowed(d.id, pool, true)).rejects.toMatchObject({ code: 'driver_verification_required' }); await assertDriverAllowed(d.id, pool, false);
    const up = await uploadDoc(d); await api().post(`/api/admin/driver-documents/${up.body.id}/review`).set(auth(rev)).send({ decision: 'approve' });
    await pool.query(`UPDATE user_profiles SET verification_level='identity', identity_verified_at=now() WHERE user_id=$1`, [d.id]);
    expect(await missingDriverRequirements(d.id)).toEqual([]); await assertDriverAllowed(d.id, pool, true);
    const t = (await api().get(`/api/transport/journeys/${j.id}`)).body.driver.trust; expect(t).toMatchObject({ identity: true, licence: true, insurance: false });
    await pool.query(`UPDATE driver_documents SET expires_on = current_date + 5 WHERE id=$1`, [up.body.id]); await runHousekeeping();
    expect((await pool.query(`SELECT expiry_warned_at FROM driver_documents WHERE id=$1`, [up.body.id])).rows[0].expiry_warned_at).toBeTruthy();
    await pool.query(`UPDATE driver_documents SET expires_on = current_date - 1 WHERE id=$1`, [up.body.id]); expect((await runHousekeeping()).docs_expired).toBeGreaterThanOrEqual(1);
    expect((await driverTrust(d.id)).licence).toBe(false);
  });
});

describe('instant book', () => {
  it('only trusted drivers can offer it, and only eligible shippers get an instant booking at the fixed price', async () => {
    const driver = await makeUser('ibd', 'Toronto'), shipper = await makeUser('ibs', 'Toronto');
    const nope = await api().post('/api/transport/journeys').set(auth(driver)).send({ origin_city: 'Toronto', dest_city: 'Calgary', departure_at: new Date(Date.now() + 4 * 864e5).toISOString(), vehicle_type: 'pickup_truck', capacity_kg: 400, price_cents: 9000, price_type: 'fixed', instant_book: true });
    expect(nope.status).toBe(422); expect(nope.body.error.code).toBe('not_trusted');
    await pool.query(`UPDATE user_profiles SET verification_level='identity', identity_verified_at=now() WHERE user_id=$1`, [driver.id]);
    const j = await makeJourney(driver, { price_type: 'fixed', price_cents: 9000, instant_book: true }); expect(j.instant_book).toBe(true);
    const request = await makeRequest(shipper); const body = { kind: 'transport', request_id: request.id, journey_id: j.id, amount_cents: 9000 };
    const first = await api().post('/api/offers').set(auth(shipper)).send(body); expect(first.status).toBe(201); expect(first.body.instant_booked).toBe(false); expect(first.body.status).toBe('pending');   // email not verified
    await api().post(`/api/offers/${first.body.id}/reject`).set(auth(driver)).send({});
    await verifyEmail(shipper); await old(shipper);
    const second = await api().post('/api/offers').set(auth(shipper)).send(body); expect(second.body.instant_booked).toBe(true); expect(second.body.booking_id).toBeTruthy(); expect(second.body.status).toBe('accepted');
    const bk = (await api().get(`/api/bookings/${second.body.booking_id}`).set(auth(shipper))).body; expect(bk.status).toBe('confirmed'); expect(bk.agreed_cents).toBe(9000);
    const other = await makeUser('ib2', 'Toronto'); await verifyEmail(other); await old(other); const r2 = await makeRequest(other);
    expect((await api().post('/api/offers').set(auth(other)).send({ ...body, request_id: r2.id, amount_cents: 8000 })).status).toBe(422);   // fixed price only
  });
});

describe('safety tools', () => {
  async function inTransit() {
    const shipper = await makeUser('sfs', 'Toronto'), driver = await makeUser('sfd', 'Toronto'); const id = await bookJourney(shipper, driver, await makeRequest(shipper), await makeJourney(driver), 9000);
    const pins = (await api().get(`/api/bookings/${id}`).set(auth(shipper))).body.pins;
    return { shipper, driver, id, pins };
  }
  it('manages up to three emergency contacts', async () => {
    const u = await makeUser('emc');
    expect((await api().post('/api/me/emergency-contacts').set(auth(u)).send({ name: 'Nobody' })).status).toBe(400);
    for (const n of ['A', 'B', 'C']) expect((await api().post('/api/me/emergency-contacts').set(auth(u)).send({ name: n, email: `${n.toLowerCase()}@t.test` })).status).toBe(201);
    expect((await api().post('/api/me/emergency-contacts').set(auth(u)).send({ name: 'D', phone: '5551234567' })).status).toBe(409);
    const list = (await api().get('/api/me/emergency-contacts').set(auth(u))).body.items; expect(list).toHaveLength(3);
    expect((await api().delete(`/api/me/emergency-contacts/${list[0].id}`).set(auth(u))).status).toBe(204);
  });
  it('shares a trip with a public link that shows progress but never addresses or PINs, and can be revoked', async () => {
    const { shipper, driver, id, pins } = await inTransit(); const out = await makeUser('out');
    await api().put(`/api/bookings/${id}/address`).set(auth(shipper)).send({ pickup_address: '12 Secret Lane', delivery_address: '9 Hidden Road', contact_phone: '4035550199' });
    expect((await api().post(`/api/bookings/${id}/share`).set(auth(out))).status).toBe(404);
    const s = await api().post(`/api/bookings/${id}/share`).set(auth(shipper)); expect(s.status).toBe(201); expect(s.body.url).toContain(`/trip/${s.body.token}`);
    const pub = await api().get(`/api/trip/${s.body.token}`); expect(pub.status).toBe(200); expect(pub.body.route).toEqual({ from: 'Toronto', to: 'Calgary' });
    const text = JSON.stringify(pub.body); for (const secret of ['Secret Lane', 'Hidden Road', '4035550199', pins.pickup, pins.delivery, shipper.username]) expect(text).not.toContain(secret);
    await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: pins.pickup }); expect((await api().get(`/api/trip/${s.body.token}`)).body.status).toBe('pickup_confirmed');
    expect((await api().get('/api/trip/not-a-real-token')).status).toBe(404);
    expect((await api().delete(`/api/bookings/${id}/shares/${s.body.token}`).set(auth(shipper))).status).toBe(204); expect((await api().get(`/api/trip/${s.body.token}`)).status).toBe(404);
    const s2 = await api().post(`/api/bookings/${id}/share`).set(auth(driver)); await pool.query(`UPDATE trip_shares SET expires_at = now() - interval '1 minute' WHERE token=$1`, [s2.body.token]); expect((await api().get(`/api/trip/${s2.body.token}`)).status).toBe(404);
  });
  it('shares live location only with the driver\'s consent, only while moving, and removes it when switched off', async () => {
    const { shipper, driver, id, pins } = await inTransit(); const loc = { lat: 49.2, lng: -97.1, accuracy_m: 15 };
    expect((await api().put(`/api/bookings/${id}/location/consent`).set(auth(shipper)).send({ enabled: true })).status).toBe(403);
    expect((await api().post(`/api/bookings/${id}/location`).set(auth(driver)).send(loc)).status).toBe(409);        // no consent yet
    await api().put(`/api/bookings/${id}/location/consent`).set(auth(driver)).send({ enabled: true });
    expect((await api().post(`/api/bookings/${id}/location`).set(auth(driver)).send(loc)).status).toBe(409);        // not picked up yet
    await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: pins.pickup });
    expect((await api().post(`/api/bookings/${id}/location`).set(auth(shipper)).send(loc)).status).toBe(403);
    expect((await api().post(`/api/bookings/${id}/location`).set(auth(driver)).send({ ...loc, lat: 99 })).status).toBe(400);
    expect((await api().post(`/api/bookings/${id}/location`).set(auth(driver)).send(loc)).body.recorded).toBe(true);
    expect((await api().post(`/api/bookings/${id}/location`).set(auth(driver)).send(loc)).body.recorded).toBe(false);   // throttled
    const seen = (await api().get(`/api/bookings/${id}/location`).set(auth(shipper))).body; expect(seen).toMatchObject({ live: true, latest: { lat: 49.2, lng: -97.1 } });
    await api().put(`/api/bookings/${id}/location/consent`).set(auth(driver)).send({ enabled: false }); expect((await api().get(`/api/bookings/${id}/location`).set(auth(shipper))).body.latest).toBeNull();
    expect((await api().get(`/api/bookings/${id}/location`).set(auth(await makeUser('oth')))).status).toBe(404);
  });
  it('sends an SOS to the other person, staff and emergency contacts, with limits and a staff workflow', async () => {
    const { shipper, driver, id } = await inTransit(); const staff = await makeStaff('moderator');
    await api().post('/api/me/emergency-contacts').set(auth(shipper)).send({ name: 'Mum', email: 'mum@t.test' });
    const r = await api().post(`/api/bookings/${id}/sos`).set(auth(shipper)).send({ message: 'Driver is going the wrong way', lat: 51.05, lng: -114.07 }); expect(r.status).toBe(201); expect(r.body.contacts_emailed).toBe(1); expect(r.body.note).toContain('911');
    await drain();
    expect((await api().get('/api/notifications').set(auth(driver))).body.items.some((n: any) => n.type === 'safety_alert')).toBe(true); expect((await api().get('/api/notifications').set(auth(staff))).body.items.some((n: any) => n.type === 'safety_alert')).toBe(true);
    const mail = (await pool.query(`SELECT body_text FROM outbox_emails WHERE to_email='mum@t.test' ORDER BY id DESC LIMIT 1`)).rows[0]; expect(mail.body_text).toContain('google.com/maps?q=51.05,-114.07'); expect(mail.body_text).toContain('911');
    expect((await api().post(`/api/bookings/${id}/sos`).set(auth(await makeUser('oth'))).send({})).status).toBe(404);
    for (let i = 0; i < 2; i++) await api().post(`/api/bookings/${id}/sos`).set(auth(shipper)).send({}); expect((await api().post(`/api/bookings/${id}/sos`).set(auth(shipper)).send({})).status).toBe(429);
    const list = (await api().get('/api/admin/safety-incidents').set(auth(staff))).body.items; const inc = list.find((i: any) => i.message === 'Driver is going the wrong way'); expect(inc.username).toBe(shipper.username);
    expect((await api().get('/api/admin/safety-incidents').set(auth(shipper))).status).toBe(403);
    expect((await api().post(`/api/admin/safety-incidents/${inc.id}/resolve`).set(auth(staff)).send({ note: 'Called both parties, resolved' })).status).toBe(204);
  });
  it('records GPS with PIN confirmations, visible on the booking timeline', async () => {
    const { shipper, driver, id, pins } = await inTransit();
    await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: pins.pickup, lat: 43.65, lng: -79.38 });
    const ev = (await api().get(`/api/bookings/${id}`).set(auth(shipper))).body.timeline.find((e: any) => e.kind === 'pickup_confirmed'); expect(ev.gps).toEqual({ lat: 43.65, lng: -79.38 });
    expect((await api().get(`/api/bookings/${id}`).set(auth(shipper))).body.timeline.find((e: any) => e.kind === 'booked').gps).toBeNull();
  });
});

describe('blind reviews', () => {
  it('hides each review from the other person and from the public until both have reviewed', async () => {
    const shipper = await makeUser('brs', 'Toronto'), driver = await makeUser('brd', 'Toronto'); const id = await bookJourney(shipper, driver, await makeRequest(shipper), await makeJourney(driver), 9000);
    const pins = (await api().get(`/api/bookings/${id}`).set(auth(shipper))).body.pins;
    await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: pins.pickup }); await api().post(`/api/bookings/${id}/deliver`).set(auth(driver)).send({ pin: pins.delivery }); await api().post(`/api/bookings/${id}/complete`).set(auth(shipper));
    await api().post(`/api/bookings/${id}/reviews`).set(auth(shipper)).send({ rating: 5, comment: 'Great driver' });
    const get = (u: TestUser) => api().get(`/api/bookings/${id}`).set(auth(u)).then((r) => r.body.review);
    expect((await get(shipper)).mine.rating).toBe(5); expect((await get(driver)).theirs).toBeNull();
    expect((await api().get(`/api/users/${driver.username}/reviews`)).body.summary.count).toBe(0);
    expect((await api().get('/api/notifications').set(auth(driver))).body.items.find((n: any) => n.type === 'review_received').data).toEqual({ hidden: true });   // no rating leaked
    await api().post(`/api/bookings/${id}/reviews`).set(auth(driver)).send({ rating: 4 });
    expect((await get(driver)).theirs.rating).toBe(5); expect((await get(shipper)).theirs.rating).toBe(4);
    expect((await api().get(`/api/users/${driver.username}/reviews`)).body.summary).toEqual({ average: 5, count: 1 });
  });
  it('reveals a lone review after the window passes', async () => {
    const shipper = await makeUser('rws', 'Toronto'), driver = await makeUser('rwd', 'Toronto'); const id = await bookJourney(shipper, driver, await makeRequest(shipper), await makeJourney(driver), 9000);
    const pins = (await api().get(`/api/bookings/${id}`).set(auth(shipper))).body.pins;
    await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: pins.pickup }); await api().post(`/api/bookings/${id}/deliver`).set(auth(driver)).send({ pin: pins.delivery }); await api().post(`/api/bookings/${id}/complete`).set(auth(shipper));
    await api().post(`/api/bookings/${id}/reviews`).set(auth(shipper)).send({ rating: 3 });
    await pool.query(`UPDATE reviews SET created_at = now() - interval '8 days' WHERE booking_id=$1`, [id]); expect((await runHousekeeping()).reviews_revealed).toBeGreaterThanOrEqual(1);
    expect((await api().get(`/api/users/${driver.username}/reviews`)).body.summary).toEqual({ average: 3, count: 1 });
  });
});
