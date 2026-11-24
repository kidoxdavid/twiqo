import { describe, expect, it } from 'vitest';
import { api, auth, makeCategory, makeListing, makeUser } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runHousekeeping } from '../src/lib/jobs.js';

const offer = (u: any, listing: string, amount: number, extra: Record<string, unknown> = {}) =>
  api().post('/api/offers').set(auth(u)).send({ kind: 'goods', listing_id: listing, amount_cents: amount, ...extra });

describe('goods offers and negotiation', () => {
  it('walks offer → counter → counter → accept and keeps the full history', async () => {
    const seller = await makeUser('os'), buyer = await makeUser('ob'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { title: 'Walnut desk', price_cents: 50000 });
    const o1 = await offer(buyer, l.id, 38000, { message: 'Can you do 380?' });
    expect(o1.status).toBe(201); expect(o1.body.can_withdraw).toBe(true); expect(o1.body.can_respond).toBe(false);
    const c1 = await api().post(`/api/offers/${o1.body.id}/counter`).set(auth(seller)).send({ amount_cents: 45000 });
    expect(c1.status).toBe(201); expect(c1.body.proposer_id).toBe(seller.id); expect(c1.body.parent_offer_id).toBe(o1.body.id);
    const c2 = await api().post(`/api/offers/${c1.body.id}/counter`).set(auth(buyer)).send({ amount_cents: 41000 });
    const acc = await api().post(`/api/offers/${c2.body.id}/accept`).set(auth(seller));
    expect(acc.status).toBe(200); expect(acc.body.order_id).toBeTruthy(); expect(acc.body.offer.status).toBe('accepted');
    const hist = await api().get(`/api/offers/${c2.body.id}`).set(auth(buyer));
    expect(hist.body.history.map((h: any) => h.amount_cents)).toEqual([38000, 45000, 41000]);
    expect(hist.body.history.map((h: any) => h.status)).toEqual(['countered', 'countered', 'accepted']);
    expect(hist.body.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['created', 'countered', 'accepted']));
    const order = (await api().get(`/api/orders/${acc.body.order_id}`).set(auth(buyer))).body;
    expect(order.total_cents).toBe(41000); expect(order.status).toBe('agreed');
    expect((await api().get(`/api/listings/${l.id}`)).body.status).toBe('sold');
  });

  it('only the recipient can respond and only the author can withdraw', async () => {
    const seller = await makeUser('rs'), buyer = await makeUser('rb'), x = await makeUser('rx'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { price_cents: 20000 });
    const o = (await offer(buyer, l.id, 15000)).body;
    expect((await api().post(`/api/offers/${o.id}/accept`).set(auth(buyer))).status).toBe(403);
    expect((await api().post(`/api/offers/${o.id}/counter`).set(auth(buyer)).send({ amount_cents: 16000 })).status).toBe(403);
    expect((await api().post(`/api/offers/${o.id}/withdraw`).set(auth(seller))).status).toBe(403);
    for (const path of ['', '/accept', '/reject', '/withdraw']) expect((await (path ? api().post(`/api/offers/${o.id}${path}`) : api().get(`/api/offers/${o.id}`)).set(auth(x))).status, `outsider ${path}`).toBe(404);
    expect((await api().post(`/api/offers/${o.id}/withdraw`).set(auth(buyer))).body.status).toBe('withdrawn');
    expect((await api().post(`/api/offers/${o.id}/accept`).set(auth(seller))).status).toBe(409);
  });

  it('enforces fixed, free and negotiable price rules', async () => {
    const seller = await makeUser('ps'), buyer = await makeUser('pb'); const cat = await makeCategory();
    const fixed = await makeListing(seller, cat, { price_type: 'fixed', price_cents: 10000 });
    expect((await offer(buyer, fixed.id, 8000)).status).toBe(422);
    const ok = await offer(buyer, fixed.id, 10000); expect(ok.status).toBe(201);
    expect((await api().post(`/api/offers/${ok.body.id}/counter`).set(auth(seller)).send({ amount_cents: 9000 })).status).toBe(409);
    const free = await makeListing(seller, cat, { price_type: 'free' });
    expect((await offer(buyer, free.id, 500)).status).toBe(400); expect((await offer(buyer, free.id, 0)).status).toBe(201);
    const neg = await makeListing(seller, cat, { price_cents: 10000 });
    expect((await offer(buyer, neg.id, 0)).status).toBe(400); expect((await offer(buyer, neg.id, 10001)).status).toBe(400);
    expect((await offer(buyer, neg.id, 7000)).status).toBe(201);
    expect((await offer(buyer, neg.id, 7500)).status).toBe(409);   // one open offer per buyer per listing
    expect((await offer(seller, neg.id, 7500)).status).toBe(400);  // not your own listing
  });

  it('allows several simultaneous offers; accepting one on a single item closes the rest', async () => {
    const seller = await makeUser('ms'), a = await makeUser('ma'), b = await makeUser('mb'), c = await makeUser('mc'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { price_cents: 30000 });
    const [oa, ob, oc] = [(await offer(a, l.id, 20000)).body, (await offer(b, l.id, 22000)).body, (await offer(c, l.id, 25000)).body];
    expect((await api().get('/api/offers').query({ role: 'received', state: 'active' }).set(auth(seller))).body.items).toHaveLength(3);
    expect((await api().post(`/api/offers/${ob.id}/accept`).set(auth(seller))).status).toBe(200);
    for (const o of [oa, oc]) expect((await api().get(`/api/offers/${o.id}`).set(auth(seller))).body.offer.status).toBe('rejected');
    expect((await api().get(`/api/offers/${oa.id}`).set(auth(a))).body.events.map((e: any) => e.kind)).toContain('auto_rejected');
    expect((await offer(await makeUser('late'), l.id, 20000)).status).toBe(404);   // sold items cannot be bid on
  });

  it('never oversells: concurrent accepts on a single item yield exactly one order', async () => {
    const seller = await makeUser('cs'), a = await makeUser('ca'), b = await makeUser('cb'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { price_cents: 30000 });
    const oa = (await offer(a, l.id, 20000)).body, ob = (await offer(b, l.id, 21000)).body;
    const [r1, r2] = await Promise.all([api().post(`/api/offers/${oa.id}/accept`).set(auth(seller)), api().post(`/api/offers/${ob.id}/accept`).set(auth(seller))]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await pool.query('SELECT count(*)::int n FROM orders WHERE listing_id=$1', [l.id])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT quantity FROM listings WHERE id=$1', [l.id])).rows[0].quantity).toBe(0);
  });

  it('handles quantities: partial sales keep the listing live and reject offers that no longer fit', async () => {
    const seller = await makeUser('qs'), a = await makeUser('qa'), b = await makeUser('qb'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { price_cents: 1000, quantity: 5 });
    expect((await offer(a, l.id, 6000, { quantity: 6 })).status).toBe(422);
    const oa = (await offer(a, l.id, 3000, { quantity: 3 })).body; const ob = (await offer(b, l.id, 4000, { quantity: 4 })).body;
    expect((await api().post(`/api/offers/${oa.id}/accept`).set(auth(seller))).status).toBe(200);
    expect((await pool.query('SELECT quantity, status FROM listings WHERE id=$1', [l.id])).rows[0]).toEqual({ quantity: 2, status: 'active' });
    expect((await api().get(`/api/offers/${ob.id}`).set(auth(b))).body.offer.status).toBe('rejected');   // wanted 4, only 2 left
    const c = (await offer(await makeUser('qc'), l.id, 2000, { quantity: 2 })).body;
    expect((await api().post(`/api/offers/${c.id}/accept`).set(auth(seller))).status).toBe(200);
    expect((await pool.query('SELECT status FROM listings WHERE id=$1', [l.id])).rows[0].status).toBe('sold');
  });

  it('expires offers and refuses to act on expired ones', async () => {
    const seller = await makeUser('es'), buyer = await makeUser('eb'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { price_cents: 10000 });
    const o = (await offer(buyer, l.id, 6000, { expires_in_hours: 1 })).body;
    await pool.query(`UPDATE offers SET expires_at = now() - interval '1 minute' WHERE id=$1`, [o.id]);
    const acc = await api().post(`/api/offers/${o.id}/accept`).set(auth(seller));
    expect(acc.status).toBe(409); expect(acc.body.error.code).toBe('expired');
    expect((await api().get(`/api/offers/${o.id}`).set(auth(buyer))).body.offer.status).toBe('expired');
    expect((await pool.query('SELECT count(*)::int n FROM orders WHERE listing_id=$1', [l.id])).rows[0].n).toBe(0);
    const o2 = (await offer(buyer, l.id, 6500)).body;   // expired offer no longer blocks a new one
    await pool.query(`UPDATE offers SET expires_at = now() - interval '1 minute' WHERE id=$1`, [o2.id]);
    expect((await runHousekeeping()).offers).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT status FROM offers WHERE id=$1', [o2.id])).rows[0].status).toBe('expired');
  });

  it('cancelling an agreed order puts the item back on sale', async () => {
    const seller = await makeUser('xs'), buyer = await makeUser('xb'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { price_cents: 10000, title: 'Cancellable thing' });
    const o = (await offer(buyer, l.id, 8000)).body;
    const { order_id } = (await api().post(`/api/offers/${o.id}/accept`).set(auth(seller))).body;
    expect((await api().get('/api/listings').query({ q: 'Cancellable' })).body.items).toHaveLength(0);
    expect((await api().post(`/api/orders/${order_id}/cancel`).set(auth(buyer))).body.status).toBe('cancelled');
    expect((await api().get('/api/listings').query({ q: 'Cancellable' })).body.items).toHaveLength(1);
    expect((await api().post(`/api/orders/${order_id}/cancel`).set(auth(buyer))).status).toBe(409);
  });

  it('puts offers in the chat as cards, separate from text, and notifies the other side', async () => {
    const seller = await makeUser('ns'), buyer = await makeUser('nb'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { price_cents: 10000 });
    const o = (await offer(buyer, l.id, 7000, { message: 'Hi' })).body;
    const convs = (await api().get('/api/conversations').set(auth(seller))).body.items;
    const msgs = (await api().get(`/api/conversations/${convs[0].id}/messages`).set(auth(seller))).body.items;
    const card = msgs.find((m: any) => m.kind === 'offer');
    expect(card.body).toBeNull(); expect(card.offer.id).toBe(o.id); expect(card.offer.amount_cents).toBe(7000);
    expect((await api().get('/api/notifications').set(auth(seller))).body.items.some((n: any) => n.type === 'offer_received')).toBe(true);
    await api().post(`/api/offers/${o.id}/reject`).set(auth(seller)).send({ reason: 'too low' });
    expect((await api().get('/api/notifications').set(auth(buyer))).body.items.some((n: any) => n.type === 'offer_rejected')).toBe(true);
  });

  it('blocked users cannot make offers, and order reviews update reputation', async () => {
    const seller = await makeUser('bs'), buyer = await makeUser('bb'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { price_cents: 10000 });
    await api().post(`/api/blocks/${buyer.id}`).set(auth(seller));
    expect((await offer(buyer, l.id, 5000)).status).toBe(404);
    await api().delete(`/api/blocks/${buyer.id}`).set(auth(seller));
    const o = (await offer(buyer, l.id, 8000)).body;
    const { order_id } = (await api().post(`/api/offers/${o.id}/accept`).set(auth(seller))).body;
    expect((await api().post(`/api/orders/${order_id}/reviews`).set(auth(buyer)).send({ rating: 5 })).status).toBe(409);   // not complete yet
    await api().post(`/api/orders/${order_id}/complete`).set(auth(buyer));
    expect((await api().post(`/api/orders/${order_id}/reviews`).set(auth(buyer)).send({ rating: 5, comment: 'Great seller' })).status).toBe(201);
    expect((await api().post(`/api/orders/${order_id}/reviews`).set(auth(buyer)).send({ rating: 1 })).status).toBe(409);
    expect((await api().get(`/api/users/${seller.username}/reviews`)).body.summary).toEqual({ average: null, count: 0 });   // blind: hidden until the seller reviews too
    expect((await api().post(`/api/orders/${order_id}/reviews`).set(auth(seller)).send({ rating: 4 })).status).toBe(201);
    const reviews = (await api().get(`/api/users/${seller.username}/reviews`)).body;
    expect(reviews.summary).toEqual({ average: 5, count: 1 }); expect(reviews.items[0].role).toBe('seller');
  });
});
