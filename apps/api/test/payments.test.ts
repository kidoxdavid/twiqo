import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, auth, bookJourney, makeCategory, makeJourney, makeListing, makeRequest, makeService, makeStaff, makeUser, until, type TestUser } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { computeFee, FakePaymentProvider, paymentProvider, StripePaymentProvider } from '../src/lib/payments.js';
import { handleEvent } from '../src/modules/payments.js';
import { runHousekeeping } from '../src/lib/jobs.js';

const fake = () => paymentProvider() as FakePaymentProvider;
const hook = (body: object, secret = 'fake-webhook-secret') => api().post('/api/webhooks/stripe').set('x-fake-signature', secret).set('Content-Type', 'application/json').send(JSON.stringify(body));
let evt = 0; const eid = () => `evt_test_${Date.now()}_${evt++}`;

beforeAll(async () => { await pool.query(`UPDATE fee_rules SET percent_bps=1000, fixed_cents=0, min_cents=NULL, max_cents=NULL WHERE scope IN ('product_sale','transport_booking')`); });
afterAll(async () => { await pool.query(`UPDATE fee_rules SET percent_bps=0, fixed_cents=0 WHERE scope IN ('product_sale','transport_booking')`); });

async function payee(name = 'sel') {
  const u = await makeUser(name);
  expect((await api().post('/api/payments/account/onboarding').set(auth(u))).status).toBe(200);
  expect((await api().post('/api/payments/fake/onboarding/complete').set(auth(u))).status).toBe(200);
  return u;
}
async function order(seller: TestUser, buyer: TestUser, price = 10000) {
  const listing = await makeListing(seller, await makeCategory(), { price_cents: price, price_type: 'fixed' });
  const o = await api().post('/api/offers').set(auth(buyer)).send({ kind: 'goods', listing_id: listing.id, amount_cents: price });
  const acc = await api().post(`/api/offers/${o.body.id}/accept`).set(auth(seller));
  return acc.body.order_id as string;
}
const checkout = (u: TestUser, body: object) => api().post('/api/payments/checkout').set(auth(u)).send(body);
const pay = (u: TestUser, id: string, outcome = 'succeeded') => api().post('/api/payments/fake/pay').set(auth(u)).send({ payment_id: id, outcome });

describe('fee calculation', () => {
  it('rounds, adds fixed fees, clamps to min/max and never exceeds the amount', () => {
    expect(computeFee({ percent_bps: 1000, fixed_cents: 0 }, 10000)).toBe(1000);
    expect(computeFee({ percent_bps: 250, fixed_cents: 30 }, 999)).toBe(55);           // 24.975 → 25 + 30
    expect(computeFee({ percent_bps: 100, fixed_cents: 0, min_cents: 50 }, 1000)).toBe(50);
    expect(computeFee({ percent_bps: 1000, fixed_cents: 0, max_cents: 500 }, 100000)).toBe(500);
    expect(computeFee({ percent_bps: 0, fixed_cents: 5000 }, 1000)).toBe(1000);
    expect(computeFee(null, 1000)).toBe(0);
  });
});

describe('connected accounts and checkout', () => {
  it('sellers must finish payout setup before buyers can pay by card', async () => {
    const seller = await makeUser('sel'), buyer = await makeUser('buy');
    const id = await order(seller, buyer);
    const r = await checkout(buyer, { order_id: id });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('payee_not_ready');
    expect((await api().get('/api/payments/account').set(auth(seller))).body.status).toBe('not_started');
    await api().post('/api/payments/account/onboarding').set(auth(seller));
    expect((await api().get('/api/payments/account').set(auth(seller))).body.status).toBe('incomplete');
    await api().post('/api/payments/fake/onboarding/complete').set(auth(seller));
    expect((await api().get('/api/payments/account').set(auth(seller))).body.status).toBe('active');
  });

  it('creates one payment per order with a fee snapshot, and only the buyer can pay', async () => {
    const seller = await payee(), buyer = await makeUser('buy'), other = await makeUser('oth');
    const id = await order(seller, buyer, 20000);
    expect((await checkout(other, { order_id: id })).status).toBe(404);
    expect((await checkout(seller, { order_id: id })).status).toBe(404);
    expect((await checkout(buyer, {})).status).toBe(400);
    const c = await checkout(buyer, { order_id: id });
    expect(c.status).toBe(201); expect(c.body.client_secret).toMatch(/_secret_/); expect(c.body.publishable_key).toBe('pk_fake');
    expect(c.body.payment.status).toBe('requires_payment'); expect(c.body.payment.amount_cents).toBe(20000);
    expect(c.body.payment.fee_cents).toBeUndefined();                                  // buyers don't see the commission line
    const again = await checkout(buyer, { order_id: id });
    expect(again.status).toBe(200); expect(again.body.payment.id).toBe(c.body.payment.id);   // reused, not duplicated
    expect((await pool.query('SELECT count(*)::int n FROM payments WHERE order_id=$1', [id])).rows[0].n).toBe(1);
    const row = (await pool.query('SELECT fee_cents, fee_percent_bps, fee_scope FROM payments WHERE id=$1', [c.body.payment.id])).rows[0];
    expect(row).toMatchObject({ fee_cents: 2000, fee_percent_bps: 1000, fee_scope: 'product_sale' });
    // changing the fee later does not change an existing payment
    await pool.query(`UPDATE fee_rules SET percent_bps=2000 WHERE scope='product_sale'`);
    try { expect((await pool.query('SELECT fee_cents FROM payments WHERE id=$1', [c.body.payment.id])).rows[0].fee_cents).toBe(2000); } finally { await pool.query(`UPDATE fee_rules SET percent_bps=1000 WHERE scope='product_sale'`); }
  });

  it('marks the order paid on the success event, notifies both sides, and tells the seller what they receive', async () => {
    const seller = await payee(), buyer = await makeUser('buy');
    const id = await order(seller, buyer, 10000);
    const c = (await checkout(buyer, { order_id: id })).body;
    const done = await pay(buyer, c.payment.id);
    expect(done.body.status).toBe('succeeded');
    expect((await api().get(`/api/orders/${id}`).set(auth(buyer))).body.payment_status).toBe('paid');
    const sv = (await api().get(`/api/payments/${c.payment.id}`).set(auth(seller))).body;
    expect(sv).toMatchObject({ amount_cents: 10000, fee_cents: 1000, net_cents: 9000, my_role: 'payee' });
    expect((await api().get('/api/notifications').set(auth(seller))).body.items.some((n: any) => n.type === 'payment_update')).toBe(true);
    expect((await checkout(buyer, { order_id: id })).status).toBe(409);               // already paid
    const earn = (await api().get('/api/payments/earnings').set(auth(seller))).body;
    expect(earn).toMatchObject({ gross_cents: 10000, fee_cents: 1000, net_cents: 9000 });
  });

  it('a declined card leaves the order unpaid and lets the buyer try again', async () => {
    const seller = await payee(), buyer = await makeUser('buy');
    const id = await order(seller, buyer);
    const c = (await checkout(buyer, { order_id: id })).body;
    const f = await pay(buyer, c.payment.id, 'failed');
    expect(f.body.status).toBe('failed'); expect(f.body.failure_reason).toMatch(/declined/);
    expect((await api().get(`/api/orders/${id}`).set(auth(buyer))).body.payment_status).toBe('unpaid');
    const retry = await checkout(buyer, { order_id: id });
    expect(retry.status).toBe(201); expect(retry.body.payment.id).not.toBe(c.payment.id);
  });

  it('pays for a transport booking and can gate pickup on payment', async () => {
    const shipper = await makeUser('bsh', 'Toronto'), driver = await payee('bdr');
    const bid = await bookJourney(shipper, driver, await makeRequest(shipper), await makeJourney(driver), 9000);
    const c = (await checkout(shipper, { booking_id: bid })).body;
    expect(c.payment.amount_cents).toBe(9000);
    const pin = (await api().get(`/api/bookings/${bid}`).set(auth(shipper))).body.pins.pickup;
    await pool.query(`UPDATE platform_settings SET value='true' WHERE key='payments.required_for_pickup'`);
    try {
      const blocked = await api().post(`/api/bookings/${bid}/pickup`).set(auth(driver)).send({ pin });
      expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('payment_required');
      await pay(shipper, c.payment.id);
      expect((await api().post(`/api/bookings/${bid}/pickup`).set(auth(driver)).send({ pin })).status).toBe(200);
    } finally { await pool.query(`UPDATE platform_settings SET value='false' WHERE key='payments.required_for_pickup'`); }
    expect((await api().get(`/api/bookings/${bid}`).set(auth(shipper))).body.payment_status).toBe('paid');
  });
});

describe('webhooks', () => {
  it('rejects bad signatures and applies each event exactly once', async () => {
    const seller = await payee(), buyer = await makeUser('buy');
    const id = await order(seller, buyer);
    const c = (await checkout(buyer, { order_id: id })).body;
    const pid = (await pool.query('SELECT provider_payment_id FROM payments WHERE id=$1', [c.payment.id])).rows[0].provider_payment_id;
    const ev = { id: eid(), type: 'payment.succeeded', paymentId: pid, chargeId: 'ch_1' };
    expect((await hook(ev, 'wrong-secret-value!')).status).toBe(400);
    expect((await pool.query('SELECT status FROM payments WHERE id=$1', [c.payment.id])).rows[0].status).toBe('requires_payment');
    const first = await hook(ev); expect(first.status).toBe(200); expect(first.body.outcome).toBe('applied');
    const replay = await hook(ev); expect(replay.status).toBe(200); expect(replay.body.outcome).toBe('duplicate');
    // two deliveries racing: one applies, the other is a duplicate
    const ev2 = { id: eid(), type: 'refund.updated', paymentId: pid, refundId: 're_x', refundStatus: 'succeeded', refundAmount: 500 };
    const outs = await Promise.all([hook(ev2), hook(ev2), hook(ev2)]);
    expect(outs.map((o) => o.body.outcome).sort()).toEqual(['applied', 'duplicate', 'duplicate']);
    expect((await pool.query('SELECT refunded_cents, status FROM payments WHERE id=$1', [c.payment.id])).rows[0]).toMatchObject({ refunded_cents: 500, status: 'partially_refunded' });
    expect((await hook({ id: eid(), type: 'ignored' })).body.outcome).toBe('ignored');
    expect((await pool.query('SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type=\'payment_update\' AND data->>\'event\'=\'paid\'', [buyer.id])).rows[0].n).toBe(1);
  });

  it('an event for an unknown payment is recorded and ignored without error', async () => {
    expect((await hook({ id: eid(), type: 'payment.succeeded', paymentId: 'pi_unknown' })).status).toBe(200);
  });

  it('stores payouts from the provider and shows them in earnings', async () => {
    const seller = await payee();
    const acct = (await pool.query('SELECT provider_account_id FROM payment_accounts WHERE user_id=$1', [seller.id])).rows[0].provider_account_id;
    await hook({ id: eid(), type: 'payout.updated', accountId: acct, payout: { id: 'po_1', amount: 4200, status: 'paid', currency: 'cad' } });
    const earn = (await api().get('/api/payments/earnings').set(auth(seller))).body;
    expect(earn.payouts).toHaveLength(1); expect(earn.payouts[0]).toMatchObject({ id: 'po_1', amount_cents: 4200, status: 'paid' });
  });
});

describe('refunds', () => {
  async function paid(price = 10000) {
    const seller = await payee(), buyer = await makeUser('buy');
    const id = await order(seller, buyer, price);
    const c = (await checkout(buyer, { order_id: id })).body; await pay(buyer, c.payment.id);
    return { seller, buyer, id, pid: c.payment.id as string };
  }
  it('lets the seller refund partially then fully, never more than was paid', async () => {
    const { seller, buyer, id, pid } = await paid();
    const before = fake().refunds.length;
    const r1 = await api().post(`/api/payments/${pid}/refund`).set(auth(seller)).send({ amount_cents: 3000, reason: 'Small scratch' });
    expect(r1.status).toBe(200); expect(r1.body.payment).toMatchObject({ status: 'partially_refunded', refunded_cents: 3000 });
    expect(fake().refunds[before]).toMatchObject({ amountCents: 3000, hasTransfer: true, refundFee: true });
    expect((await api().get(`/api/orders/${id}`).set(auth(buyer))).body.payment_status).toBe('partially_refunded');
    expect((await api().post(`/api/payments/${pid}/refund`).set(auth(seller)).send({ amount_cents: 7001, reason: 'Too much' })).status).toBe(409);
    const r2 = await api().post(`/api/payments/${pid}/refund`).set(auth(seller)).send({ reason: 'Rest of it' });
    expect(r2.body.payment).toMatchObject({ status: 'refunded', refunded_cents: 10000 });
    expect((await api().post(`/api/payments/${pid}/refund`).set(auth(seller)).send({ reason: 'Again please' })).status).toBe(409);
    expect((await api().post(`/api/payments/${pid}/refund`).set(auth(buyer)).send({ reason: 'I want it' })).status).toBe(404);   // buyers cannot self-refund
    expect((await api().get('/api/payments/earnings').set(auth(seller))).body.net_cents).toBe(0);
  });

  it('concurrent refund requests cannot exceed the amount paid', async () => {
    const { seller, pid } = await paid(10000);
    const rs = await Promise.all([1, 2, 3, 4].map(() => api().post(`/api/payments/${pid}/refund`).set(auth(seller)).send({ amount_cents: 4000, reason: 'Concurrent' })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
    expect((await pool.query('SELECT refunded_cents FROM payments WHERE id=$1', [pid])).rows[0].refunded_cents).toBe(8000);
  });

  it('a provider outage changes nothing and can be retried', async () => {
    const { seller, pid } = await paid();
    fake().failNextRefund = true;
    const f = await api().post(`/api/payments/${pid}/refund`).set(auth(seller)).send({ reason: 'Outage test' });
    expect(f.status).toBe(502);
    expect((await pool.query('SELECT refunded_cents, status FROM payments WHERE id=$1', [pid])).rows[0]).toMatchObject({ refunded_cents: 0, status: 'succeeded' });
    expect((await api().post(`/api/payments/${pid}/refund`).set(auth(seller)).send({ reason: 'Outage test' })).status).toBe(200);
  });

  it('cancelling a paid order refunds it automatically; cancelling an unpaid one voids the charge', async () => {
    const { buyer, id, pid } = await paid();
    expect((await api().post(`/api/orders/${id}/cancel`).set(auth(buyer))).status).toBe(200);
    const p = (await pool.query('SELECT status, refunded_cents FROM payments WHERE id=$1', [pid])).rows[0];
    expect(p).toMatchObject({ status: 'refunded', refunded_cents: 10000 });
    const seller = await payee(), b2 = await makeUser('buy'); const id2 = await order(seller, b2);
    const c = (await checkout(b2, { order_id: id2 })).body;
    await api().post(`/api/orders/${id2}/cancel`).set(auth(b2));
    expect((await pool.query('SELECT status FROM payments WHERE id=$1', [c.payment.id])).rows[0].status).toBe('canceled');
    expect((await checkout(b2, { order_id: id2 })).status).toBe(409);
  });

  it('a payment that lands after cancellation is refunded', async () => {
    const seller = await payee(), buyer = await makeUser('buy'); const id = await order(seller, buyer);
    const c = (await checkout(buyer, { order_id: id })).body;
    await api().post(`/api/orders/${id}/cancel`).set(auth(buyer));
    await pool.query(`UPDATE payments SET status='requires_payment' WHERE id=$1`, [c.payment.id]);     // simulate the card being charged just before cancel
    const pid = (await pool.query('SELECT provider_payment_id FROM payments WHERE id=$1', [c.payment.id])).rows[0].provider_payment_id;
    await handleEvent({ id: eid(), type: 'payment.succeeded', paymentId: pid });
    await until(async () => (await pool.query('SELECT status FROM payments WHERE id=$1', [c.payment.id])).rows[0].status === 'refunded');
  });

  it('housekeeping retries a failed automatic refund', async () => {
    const { buyer, id, pid } = await paid();
    fake().failNextRefund = true;
    await api().post(`/api/orders/${id}/cancel`).set(auth(buyer));
    expect((await pool.query('SELECT status FROM payments WHERE id=$1', [pid])).rows[0].status).toBe('succeeded');   // refund failed, money still with the seller
    const out = await runHousekeeping(); expect(out.retried_refunds).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT status FROM payments WHERE id=$1', [pid])).rows[0].status).toBe('refunded');
  });

  it('cancelling a confirmed booking refunds the shipper', async () => {
    const shipper = await makeUser('bsh', 'Toronto'), driver = await payee('bdr');
    const bid = await bookJourney(shipper, driver, await makeRequest(shipper), await makeJourney(driver), 9000);
    const c = (await checkout(shipper, { booking_id: bid })).body; await pay(shipper, c.payment.id);
    expect((await api().post(`/api/bookings/${bid}/cancel`).set(auth(driver)).send({ reason: 'Van broke down' })).status).toBe(200);
    expect((await pool.query('SELECT status FROM payments WHERE id=$1', [c.payment.id])).rows[0].status).toBe('refunded');
    expect((await api().get(`/api/bookings/${bid}`).set(auth(shipper))).body.payment_status).toBe('refunded');
  });
});

describe('disputes', () => {
  async function delivered() {
    const shipper = await makeUser('bsh', 'Toronto'), driver = await payee('bdr'), admin = await makeStaff('admin');
    const bid = await bookJourney(shipper, driver, await makeRequest(shipper), await makeJourney(driver), 10000);
    const c = (await checkout(shipper, { booking_id: bid })).body; await pay(shipper, c.payment.id);
    const pins = (await api().get(`/api/bookings/${bid}`).set(auth(shipper))).body.pins;
    await api().post(`/api/bookings/${bid}/pickup`).set(auth(driver)).send({ pin: pins.pickup });
    await api().post(`/api/bookings/${bid}/deliver`).set(auth(driver)).send({ pin: pins.delivery });
    return { shipper, driver, admin, bid, pid: c.payment.id as string };
  }
  const open = (u: TestUser, bid: string) => api().post('/api/disputes').set(auth(u)).send({ booking_id: bid, reason: 'damaged', description: 'The table arrived with a cracked leg.' });

  it('blocks completion while open, and resolves with a partial refund', async () => {
    const { shipper, driver, admin, bid, pid } = await delivered();
    const d = await open(shipper, bid); expect(d.status).toBe(201); expect(d.body.status).toBe('open');
    expect((await open(driver, bid)).status).toBe(409);                                                            // one open dispute per booking
    expect((await api().post(`/api/bookings/${bid}/complete`).set(auth(shipper))).body.error.code).toBe('dispute_open');
    expect((await api().get(`/api/bookings/${bid}`).set(auth(shipper))).body.dispute_id).toBe(d.body.id);
    await runHousekeeping();                                                                                       // auto-complete must skip it too
    await pool.query(`UPDATE bookings SET delivered_at = now() - interval '10 days' WHERE id=$1`, [bid]);
    await runHousekeeping();
    expect((await api().get(`/api/bookings/${bid}`).set(auth(shipper))).body.status).toBe('delivered');
    // the other party can respond, outsiders and non-staff cannot resolve
    expect((await api().post(`/api/disputes/${d.body.id}/messages`).set(auth(driver)).send({ body: 'It was fine when I handed it over.' })).status).toBeLessThan(300);
    expect((await api().get(`/api/disputes/${d.body.id}`).set(auth(await makeUser('out')))).status).toBe(404);
    expect((await api().post(`/api/admin/disputes/${d.body.id}/resolve`).set(auth(shipper)).send({ resolution: 'refund_full', note: 'I would like it' })).status).toBe(403);
    expect((await api().get('/api/admin/disputes').set(auth(admin))).body.items.some((x: any) => x.id === d.body.id)).toBe(true);
    const r = await api().post(`/api/admin/disputes/${d.body.id}/resolve`).set(auth(admin)).send({ resolution: 'refund_partial', refund_cents: 2500, note: 'Partial refund for the damage' });
    expect(r.status).toBe(200); expect(r.body.status).toBe('resolved');
    expect((await pool.query('SELECT refunded_cents, status FROM payments WHERE id=$1', [pid])).rows[0]).toMatchObject({ refunded_cents: 2500, status: 'partially_refunded' });
    expect((await api().get(`/api/bookings/${bid}`).set(auth(shipper))).body.status).toBe('completed');
    expect((await api().post(`/api/admin/disputes/${d.body.id}/resolve`).set(auth(admin)).send({ resolution: 'no_refund', note: 'Second attempt' })).status).toBe(409);
    expect((await pool.query(`SELECT 1 FROM audit_logs WHERE action='dispute.resolve' AND target_id=$1`, [d.body.id])).rowCount).toBe(1);
  });

  it('can be withdrawn by the opener and cannot be opened before pickup', async () => {
    const { shipper, driver, bid } = await delivered();
    const d = (await open(driver, bid)).body;
    expect((await api().post(`/api/disputes/${d.id}/withdraw`).set(auth(shipper))).status).toBeGreaterThanOrEqual(400);
    expect((await api().post(`/api/disputes/${d.id}/withdraw`).set(auth(driver))).status).toBeLessThan(300);
    expect((await api().post(`/api/bookings/${bid}/complete`).set(auth(shipper))).status).toBe(200);
    const s2 = await makeUser('bsh', 'Toronto'), d2 = await makeUser('bdr', 'Toronto');
    const b2 = await bookJourney(s2, d2, await makeRequest(s2), await makeJourney(d2));
    expect((await open(s2, b2)).status).toBe(409);
  });
});

describe('boosts', () => {
  it('prices come from fee rules and boosts activate on payment, then expire', async () => {
    const seller = await makeUser('sel'), buyer = await makeUser('buy');
    const listing = await makeListing(seller, await makeCategory());
    const price = (await api().get('/api/boosts/pricing')).body;
    expect(price.options.find((o: any) => o.target_type === 'listing' && o.placement === 'featured').price_cents).toBe(499);
    expect((await api().post('/api/boosts').set(auth(buyer)).send({ target_type: 'listing', target_id: listing.id, placement: 'featured' })).status).toBe(404);   // not yours
    const b = await api().post('/api/boosts').set(auth(seller)).send({ target_type: 'listing', target_id: listing.id, placement: 'featured' });
    expect(b.status).toBe(201); expect(b.body.payment.amount_cents).toBe(499);
    const again = await api().post('/api/boosts').set(auth(seller)).send({ target_type: 'listing', target_id: listing.id, placement: 'featured' });
    expect(again.body.boost_id).toBe(b.body.boost_id);                                                              // no duplicate pending boosts
    expect((await api().get(`/api/listings/${listing.id}`)).body.featured).toBe(false);
    await pay(seller, b.body.payment.id);
    expect((await api().get('/api/boosts').set(auth(seller))).body.items[0]).toMatchObject({ status: 'active', placement: 'featured' });
    expect((await api().get(`/api/listings/${listing.id}`)).body.featured).toBe(true);
    expect((await api().post('/api/boosts').set(auth(seller)).send({ target_type: 'listing', target_id: listing.id, placement: 'featured' })).status).toBe(409);
    // featured listings sort first in newest order
    const newer = await makeListing(seller, await makeCategory(), { title: 'Newer unboosted' });
    const list = (await api().get(`/api/listings?seller=${seller.username}&sort=newest`)).body.items.map((i: any) => i.id);
    expect(list.indexOf(listing.id)).toBeLessThan(list.indexOf(newer.id));
    await pool.query(`UPDATE boosts SET ends_at = now() - interval '1 minute' WHERE id=$1`, [b.body.boost_id]);
    expect((await runHousekeeping()).boosts).toBeGreaterThanOrEqual(1);
    expect((await api().get(`/api/listings/${listing.id}`)).body.featured).toBe(false);
  });

  it('sponsored posts appear labelled in the feed, never to their owner, and stop when the boost ends', async () => {
    const owner = await makeUser('adv'), viewer = await makeUser('vw');
    const post = (await api().post('/api/posts').set(auth(owner)).send({ body: 'Grand opening sale this weekend', visibility: 'public' })).body;
    const b = (await api().post('/api/boosts').set(auth(owner)).send({ target_type: 'post', target_id: post.id, placement: 'sponsored' })).body;
    expect(b.payment.amount_cents).toBe(1499); await pay(owner, b.payment.id);
    await pool.query(`UPDATE platform_settings SET value='1' WHERE key='ads.every_n'`);
    try {
      const seen = async (u: TestUser) => (await api().get('/api/feed?tab=for_you&limit=5').set(auth(u))).body.items.filter((i: any) => i.sponsored);
      const items = await seen(viewer);
      expect(items.length).toBeLessThanOrEqual(1);
      if (items.length) expect(items[0]).toMatchObject({ id: post.id, sponsored: true });
      expect((await seen(owner)).filter((i: any) => i.id === post.id)).toHaveLength(0);
      await pool.query(`UPDATE boosts SET status='expired' WHERE id=$1`, [b.boost_id]);
      expect((await seen(viewer)).filter((i: any) => i.id === post.id)).toHaveLength(0);
    } finally { await pool.query(`UPDATE platform_settings SET value='8' WHERE key='ads.every_n'`); }
  });

  it('refunding a boost cancels it, and unpaid boosts can be cancelled by the owner', async () => {
    const owner = await makeUser('adv'), admin = await makeStaff('admin');
    const svc = await makeService(owner);
    const b = (await api().post('/api/boosts').set(auth(owner)).send({ target_type: 'transport_service', target_id: svc.id, placement: 'featured' })).body;
    expect(b.payment.amount_cents).toBe(999);
    expect((await api().delete(`/api/boosts/${b.boost_id}`).set(auth(owner))).status).toBe(204);
    expect((await pool.query('SELECT status FROM payments WHERE id=$1', [b.payment.id])).rows[0].status).toBe('canceled');
    const b2 = (await api().post('/api/boosts').set(auth(owner)).send({ target_type: 'transport_service', target_id: svc.id, placement: 'featured' })).body;
    await pay(owner, b2.payment.id);
    expect((await api().post(`/api/payments/${b2.payment.id}/refund`).set(auth(admin)).send({ reason: 'Goodwill refund' })).status).toBe(200);
    expect((await pool.query('SELECT status FROM boosts WHERE id=$1', [b2.boost_id])).rows[0].status).toBe('canceled');
  });

  it('abandoned unpaid payments and their boosts are cleaned up', async () => {
    const owner = await makeUser('adv'); const listing = await makeListing(owner, await makeCategory());
    const b = (await api().post('/api/boosts').set(auth(owner)).send({ target_type: 'listing', target_id: listing.id, placement: 'sponsored' })).body;
    await pool.query(`UPDATE payments SET created_at = now() - interval '2 days' WHERE id=$1`, [b.payment.id]);
    expect((await runHousekeeping()).abandoned_payments).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT status FROM boosts WHERE id=$1', [b.boost_id])).rows[0].status).toBe('canceled');
  });
});

describe('admin payments and revenue', () => {
  it('is restricted to staff with manage.payments and reports net platform revenue', async () => {
    const admin = await makeStaff('admin'), mod = await makeStaff('moderator'), user = await makeUser('usr');
    for (const path of ['/api/admin/payments', '/api/admin/revenue', '/api/admin/boosts', '/api/admin/disputes', '/api/admin/webhook-events']) {
      expect((await api().get(path).set(auth(user))).status).toBe(403); expect((await api().get(path).set(auth(mod))).status).toBe(403);
      expect((await api().get(path).set(auth(admin))).status).toBe(200);
    }
    const seller = await payee(), buyer = await makeUser('buy'); const id = await order(seller, buyer, 10000);
    const c = (await checkout(buyer, { order_id: id })).body; await pay(buyer, c.payment.id);
    await api().post(`/api/payments/${c.payment.id}/refund`).set(auth(seller)).send({ amount_cents: 5000, reason: 'Half back' });
    const rev = (await api().get('/api/admin/revenue?days=1').set(auth(admin))).body;
    expect(rev.gross_cents).toBeGreaterThanOrEqual(10000); expect(rev.fees_returned_cents).toBeGreaterThanOrEqual(500);
    expect(rev.net_platform_revenue_cents).toBe(rev.platform_fees_cents - rev.fees_returned_cents);
    expect(rev.by_scope.some((s: any) => s.scope === 'product_sale')).toBe(true);
    expect(rev.note).toMatch(/tax/i);
    const list = (await api().get('/api/admin/payments?kind=order').set(auth(admin))).body.items;
    expect(list.every((p: any) => p.kind === 'order')).toBe(true);
    expect((await api().get(`/api/payments/${c.payment.id}`).set(auth(admin))).body.my_role).toBe('staff');
  });
});

describe('stripe adapter (mocked client)', () => {
  const calls: any[] = [];
  const client: any = {
    accounts: { create: async (p: any) => (calls.push(['accounts.create', p]), { id: 'acct_1' }), update: async (id: string, p: any) => (calls.push(['accounts.update', id, p]), {}),
      retrieve: async () => ({ charges_enabled: true, payouts_enabled: false, details_submitted: true, requirements: { currently_due: ['external_account'] } }), createLoginLink: async () => ({ url: 'https://dash' }) },
    accountLinks: { create: async (p: any) => (calls.push(['accountLinks.create', p]), { url: 'https://onboard' }) },
    paymentIntents: { create: async (p: any, o: any) => (calls.push(['pi.create', p, o]), { id: 'pi_1', client_secret: 'pi_1_secret' }), retrieve: async () => ({ client_secret: 's', status: 'requires_payment_method' }), cancel: async () => ({}) },
    refunds: { create: async (p: any, o: any) => (calls.push(['refund.create', p, o]), { id: 're_1', status: 'succeeded' }) },
    webhooks: { constructEvent: (_raw: any, _sig: any, secret: string) => { if (secret !== 'whsec_ok') throw new Error('bad'); return { id: 'evt_s1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', latest_charge: 'ch_1' } } }; } },
  };
  const stripe = new StripePaymentProvider(client, 'pk_test', ['whsec_bad', 'whsec_ok']);

  it('creates Express accounts for Canada and sends destination-charge parameters', async () => {
    expect(await stripe.createAccount({ userId: 'u1', email: 'a@b.c' })).toEqual({ accountId: 'acct_1' });
    expect(calls.find((c) => c[0] === 'accounts.create')[1]).toMatchObject({ type: 'express', country: 'CA', capabilities: { transfers: { requested: true }, card_payments: { requested: true } } });
    await stripe.createPayment({ amountCents: 10000, currency: 'cad', feeCents: 1000, destinationAccountId: 'acct_9', idempotencyKey: 'pay:1', description: 'd', metadata: { twiqo_payment_id: 'p1' } });
    const [, params, opts] = calls.find((c) => c[0] === 'pi.create');
    expect(params).toMatchObject({ amount: 10000, currency: 'cad', application_fee_amount: 1000, transfer_data: { destination: 'acct_9' }, metadata: { twiqo_payment_id: 'p1' } });
    expect(opts).toMatchObject({ idempotencyKey: 'pay:1' });
  });
  it('boosts are plain charges with no transfer', async () => {
    calls.length = 0;
    await stripe.createPayment({ amountCents: 499, currency: 'cad', feeCents: 0, destinationAccountId: null, idempotencyKey: 'pay:2', description: 'boost', metadata: {} });
    const params = calls.find((c) => c[0] === 'pi.create')[1];
    expect(params.transfer_data).toBeUndefined(); expect(params.application_fee_amount).toBeUndefined();
  });
  it('refunds reverse the transfer and return the commission only when asked', async () => {
    calls.length = 0;
    await stripe.refund({ paymentId: 'pi_1', amountCents: 500, hasTransfer: true, refundFee: true, idempotencyKey: 'refund:1', metadata: {} });
    expect(calls.find((c) => c[0] === 'refund.create')[1]).toMatchObject({ payment_intent: 'pi_1', amount: 500, reverse_transfer: true, refund_application_fee: true });
    calls.length = 0;
    await stripe.refund({ paymentId: 'pi_1', amountCents: 500, hasTransfer: false, refundFee: false, idempotencyKey: 'refund:2', metadata: {} });
    const p = calls.find((c) => c[0] === 'refund.create')[1]; expect(p.reverse_transfer).toBeFalsy(); expect(p.refund_application_fee).toBeFalsy();
  });
  it('verifies webhooks against both secrets and normalizes events', () => {
    expect(stripe.parseWebhook(Buffer.from('{}'), { 'stripe-signature': 't=1,v1=x' })).toMatchObject({ id: 'evt_s1', type: 'payment.succeeded', paymentId: 'pi_1', chargeId: 'ch_1' });
    const none = new StripePaymentProvider(client, 'pk', ['whsec_nope']);
    expect(() => none.parseWebhook(Buffer.from('{}'), { 'stripe-signature': 'x' })).toThrow();
    expect(() => stripe.parseWebhook(Buffer.from('{}'), {})).toThrow();
  });
});
