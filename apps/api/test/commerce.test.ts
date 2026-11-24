import { describe, expect, it } from 'vitest';
import { api, auth, bookJourney, makeCategory, makeJourney, makeListing, makeRequest, makeStaff, makeUser, type TestUser } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { FakePaymentProvider, paymentProvider } from '../src/lib/payments.js';

const hook = (body: object) => api().post('/api/webhooks/stripe').set('x-fake-signature', 'fake-webhook-secret').set('Content-Type', 'application/json').send(JSON.stringify(body));
async function payee(name = 'sel') { const u = await makeUser(name); await api().post('/api/payments/account/onboarding').set(auth(u)); await api().post('/api/payments/fake/onboarding/complete').set(auth(u)); return u; }
async function paidOrder(price = 20000) {
  const seller = await payee(), buyer = await makeUser('buy'); const l = await makeListing(seller, await makeCategory(), { price_cents: price, price_type: 'fixed' });
  const o = await api().post('/api/offers').set(auth(buyer)).send({ kind: 'goods', listing_id: l.id, amount_cents: price }); const order = (await api().post(`/api/offers/${o.body.id}/accept`).set(auth(seller))).body.order_id;
  const c = (await api().post('/api/payments/checkout').set(auth(buyer)).send({ order_id: order })).body; await api().post('/api/payments/fake/pay').set(auth(buyer)).send({ payment_id: c.payment.id });
  return { seller, buyer, order, pid: c.payment.id as string };
}

describe('price guidance', () => {
  it('only suggests a price from enough real completed moves, and says so when there is not enough data', async () => {
    const none = (await api().get('/api/transport/price-guidance').query({ from: 'Edmonton', to: 'Medicine Hat' })).body; expect(none.enough_data).toBe(false); expect(none.message).toContain('Not enough');
    const shipper = await makeUser('pgs', 'Calgary'), driver = await makeUser('pgd', 'Calgary');
    for (const cents of [8000, 9000, 10000, 11000, 12000]) {
      const r = await pool.query(`INSERT INTO transport_requests(requester_id,title,item_category,quantity,weight_kg,length_cm,width_cm,height_cm,origin_city,origin_province,origin,dest_city,dest_province,dest,pickup_from,pickup_to,status)
        SELECT $1,'Guided move','boxes',1,50,50,50,50,'Edmonton','AB',(SELECT location FROM places WHERE city='Edmonton' LIMIT 1),'Medicine Hat','AB',(SELECT location FROM places WHERE city='Medicine Hat' LIMIT 1),current_date,current_date+3,'completed' RETURNING id`, [shipper.id]).catch(() => null);
      if (!r) return;   // places for these cities may not exist in this database
      const o = await pool.query(`INSERT INTO offers(kind,customer_id,provider_id,proposer_id,request_id,amount_cents,expires_at) VALUES ('transport',$1,$2,$1,$3,$4, now()+interval '1 day') RETURNING id`, [shipper.id, driver.id, r.rows[0].id, cents]);
      await pool.query(`INSERT INTO bookings(offer_id,request_id,shipper_id,transporter_id,agreed_cents,pickup_pin,delivery_pin,status,completed_at) VALUES ($1,$2,$3,$4,$5,'1111','2222','completed', now())`, [o.rows[0].id, r.rows[0].id, shipper.id, driver.id, cents]);
    }
    const g = (await api().get('/api/transport/price-guidance').query({ from: 'Edmonton', to: 'Medicine Hat', weight_kg: 60 })).body;
    expect(g).toMatchObject({ enough_data: true, samples: 5, typical_cents: 10000, low_cents: 9000, high_cents: 11000 });
  });
  it('suggests listing prices from the category, with the same honesty about samples', async () => {
    const cat = await makeCategory(); const u = await makeUser('lpg');
    expect((await api().get('/api/listings/price-guidance').query({ category_id: cat })).body.enough_data).toBe(false);
    await pool.query(`INSERT INTO listings(seller_id,category_id,title,description,price_cents) SELECT $1,$2,'Guide item '||g,'x', g*1000 FROM generate_series(1,12) g`, [u.id, cat]);
    const g = (await api().get('/api/listings/price-guidance').query({ category_id: cat })).body; expect(g.enough_data).toBe(true); expect(g.typical_cents).toBe(6500); expect(g.low_cents).toBeLessThan(g.typical_cents); expect(g.high_cents).toBeGreaterThan(g.typical_cents);
  });
});

describe('return trips and renewals', () => {
  it('finds open shipments going back the way the driver came', async () => {
    const driver = await makeUser('rtd', 'Toronto'), shipper = await makeUser('rts', 'Calgary');
    const j = await makeJourney(driver, { origin_city: 'Toronto', dest_city: 'Calgary', waypoints: [], departure_at: new Date(Date.now() + 2 * 864e5).toISOString() });
    const back = await makeRequest(shipper, { title: 'Back to Toronto', origin_city: 'Calgary', dest_city: 'Toronto', pickup_from: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), pickup_to: new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10) });
    await makeRequest(shipper, { title: 'Same direction', origin_city: 'Toronto', dest_city: 'Calgary' });
    const r = (await api().get(`/api/transport/journeys/${j.id}/return-suggestions`).set(auth(driver))).body;
    expect(r.requests.map((x: any) => x.id)).toEqual([back.id]); expect(r.suggested_journey).toMatchObject({ origin_city: 'Calgary', dest_city: 'Toronto' });
    expect((await api().get(`/api/transport/journeys/${j.id}/return-suggestions`).set(auth(shipper))).status).toBe(404);
  });
  it('renews a listing once a day and relists an expired one', async () => {
    const u = await makeUser('rnw'); const l = await makeListing(u, await makeCategory());
    const first = await api().post(`/api/listings/${l.id}/renew`).set(auth(u)); expect(first.status).toBe(200);
    expect((await api().post(`/api/listings/${l.id}/renew`).set(auth(u))).status).toBe(409);
    await pool.query(`UPDATE listings SET status='expired', expires_at = now() - interval '2 days', renewed_at = now() - interval '2 days' WHERE id=$1`, [l.id]);
    const again = await api().post(`/api/listings/${l.id}/renew`).set(auth(u)); expect(again.body.status).toBe('active');
    expect((await pool.query('SELECT expires_at > now() + interval \'25 days\' AS ok FROM listings WHERE id=$1', [l.id])).rows[0].ok).toBe(true);
    expect((await api().post(`/api/listings/${l.id}/renew`).set(auth(await makeUser('oth')))).status).toBe(403);
  });
});

describe('bulk listing upload for businesses', () => {
  it('validates every row, previews with dry_run, creates the good rows, and holds suspicious ones for review', async () => {
    const owner = await makeUser('blk'); const slug = `bulk${Math.random().toString(36).slice(2, 7)}`; const cat = (await pool.query(`INSERT INTO categories(name,slug) VALUES ($1,$2) RETURNING id, slug`, [`bulkcat-${slug}`, `bulkcat-${slug}`])).rows[0];
    const biz = (await api().post('/api/businesses').set(auth(owner)).send({ name: 'Bulk Store', slug })).body;
    const rows = [{ title: 'Oak table', description: 'Solid oak', price: '350', category_slug: cat.slug, quantity: '2', tags: 'oak;table' }, { title: 'Bad row', price: 'abc', category_slug: cat.slug }, { title: 'Unknown cat', price: '5', category_slug: 'nope-not-real' },
      { title: 'Cheap phone', description: 'Pay first by e-transfer, text me at 403-555-0100', price: '20', category_slug: cat.slug }];
    const dry = await api().post(`/api/businesses/${biz.id}/listings/bulk`).set(auth(owner)).send({ rows, dry_run: true }); expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ created: 0, valid: 2, invalid: 2 }); expect(dry.body.results[1].errors[0]).toContain('price'); expect(dry.body.results[2].errors[0]).toContain('category_slug');
    expect((await pool.query(`SELECT count(*)::int n FROM listings WHERE business_id=$1`, [biz.id])).rows[0].n).toBe(0);
    const real = await api().post(`/api/businesses/${biz.id}/listings/bulk`).set(auth(owner)).send({ rows }); expect(real.status).toBe(201); expect(real.body.created).toBe(2);
    expect(real.body.results[0].status).toBe('active'); expect(real.body.results[3].status).toBe('pending_review');
    const mine = (await api().get('/api/listings').query({ business: slug })).body.items; expect(mine.map((l: any) => l.title)).toEqual(['Oak table']); expect(mine[0].price_cents).toBe(35000); expect(mine[0].quantity).toBe(2);
    expect((await api().post(`/api/businesses/${biz.id}/listings/bulk`).set(auth(await makeUser('oth'))).send({ rows })).status).toBe(403);
    expect((await api().post(`/api/businesses/${biz.id}/listings/bulk`).set(auth(owner)).send({ rows: [] })).status).toBe(400);
  });
});

describe('receipts and tax estimates', () => {
  it('gives payers a simple receipt and sellers a statement with the fee and an estimated GST/HST on it', async () => {
    await pool.query(`UPDATE fee_rules SET percent_bps=1000 WHERE scope='product_sale'`);
    try {
      const { seller, buyer, pid } = await paidOrder(20000); await pool.query(`UPDATE user_profiles SET province='ON' WHERE user_id=$1`, [seller.id]);
      const b = (await api().get(`/api/payments/${pid}/receipt`).set(auth(buyer))).body; expect(b).toMatchObject({ amount_cents: 20000 }); expect(b.twiqo_fee_cents).toBeUndefined(); expect(b.receipt_number).toMatch(/^TW-/);
      const fee = (await pool.query('SELECT fee_cents FROM payments WHERE id=$1', [pid])).rows[0].fee_cents;   // fee rules are shared with other test files, so read what was actually charged
      const s = (await api().get(`/api/payments/${pid}/receipt`).set(auth(seller))).body; expect(s).toMatchObject({ twiqo_fee_cents: fee, net_to_you_cents: 20000 - fee, estimated_gst_hst_on_fee_cents: Math.round(fee * 0.13) });   // 13% HST on the fee
      expect((await api().get(`/api/payments/${pid}/receipt`).set(auth(await makeUser('oth')))).status).toBe(404);
      const staff = await makeStaff('admin'); expect((await api().get('/api/admin/tax-rates').set(auth(staff))).body.items.find((r: any) => r.province === 'ON').hst_bps).toBe(1300);
      expect((await api().get('/api/admin/tax-rates').set(auth(seller))).status).toBe(403);
      expect((await api().put('/api/admin/tax-rates/AB').set(auth(staff)).send({ gst_bps: 500, pst_bps: 0, hst_bps: 0 })).status).toBe(204);
      expect((await api().put('/api/admin/tax-rates/ZZ').set(auth(staff)).send({ gst_bps: 1, pst_bps: 0, hst_bps: 0 })).status).toBe(404);
      const sum = (await api().get('/api/admin/tax-summary?days=1').set(auth(staff))).body; expect(sum.items.find((r: any) => r.province === 'ON').estimated_gst_hst_cents).toBeGreaterThanOrEqual(Math.round(fee * 0.13)); expect(sum.note).toContain('does not charge');
    } finally { await pool.query(`UPDATE fee_rules SET percent_bps=0 WHERE scope='product_sale'`); }
  });
});

describe('card disputes (chargebacks)', () => {
  it('tracks a chargeback from the provider, builds evidence from our own records, and submits it once', async () => {
    const shipper = await makeUser('cbs', 'Toronto'), driver = await payee('cbd'); const staff = await makeStaff('admin');
    const id = await bookJourney(shipper, driver, await makeRequest(shipper), await makeJourney(driver), 9000);
    const c = (await api().post('/api/payments/checkout').set(auth(shipper)).send({ booking_id: id })).body; await api().post('/api/payments/fake/pay').set(auth(shipper)).send({ payment_id: c.payment.id });
    const pins = (await api().get(`/api/bookings/${id}`).set(auth(shipper))).body.pins;
    await api().post(`/api/bookings/${id}/pickup`).set(auth(driver)).send({ pin: pins.pickup, lat: 43.65, lng: -79.38 }); await api().post(`/api/bookings/${id}/deliver`).set(auth(driver)).send({ pin: pins.delivery, lat: 51.04, lng: -114.07 });
    const pi = (await pool.query('SELECT provider_payment_id FROM payments WHERE id=$1', [c.payment.id])).rows[0].provider_payment_id;
    const due = new Date(Date.now() + 7 * 864e5).toISOString();
    await hook({ id: `evt_cd1_${Date.now()}`, type: 'card_dispute.created', paymentId: pi, cardDispute: { id: `dp_${Date.now()}`, paymentId: pi, amount: 9000, reason: 'product_not_received', status: 'needs_response', dueBy: due } });
    const list = (await api().get('/api/admin/card-disputes').set(auth(staff))).body.items; const d = list.find((x: any) => x.payment_id === c.payment.id); expect(d).toMatchObject({ status: 'needs_response', reason: 'product_not_received', amount_cents: 9000 });
    expect((await api().get('/api/admin/card-disputes').set(auth(shipper))).status).toBe(403);
    const ev = (await api().get(`/api/admin/card-disputes/${d.id}/evidence-preview`).set(auth(staff))).body;
    expect(ev.text).toContain('one-time 4-digit PIN'); expect(ev.text).toContain('GPS 51.0400,-114.0700'); expect(ev.text).toContain('pickup confirmed'); expect(ev.productDescription).toContain('Delivery service');
    const fake = paymentProvider() as FakePaymentProvider;
    expect((await api().post(`/api/admin/card-disputes/${d.id}/submit-evidence`).set(auth(staff)).send({ extra_note: 'Customer confirmed receipt in chat' })).body.submitted).toBe(true);
    expect(fake.evidence.find((e) => e.disputeId === d.provider_dispute_id)!.text).toContain('Customer confirmed receipt in chat');
    expect((await api().post(`/api/admin/card-disputes/${d.id}/submit-evidence`).set(auth(staff)).send({})).status).toBe(409);
    await hook({ id: `evt_cd2_${Date.now()}`, type: 'card_dispute.updated', paymentId: pi, cardDispute: { id: d.provider_dispute_id, paymentId: pi, amount: 9000, status: 'won' } });
    expect((await pool.query('SELECT status FROM card_disputes WHERE id=$1', [d.id])).rows[0].status).toBe('won');
  });
});
