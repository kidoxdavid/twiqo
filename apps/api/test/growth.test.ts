import { describe, expect, it } from 'vitest';
import { api, auth, makeCategory, makeListing, makeStaff, makeUser, makeCircle, type TestUser } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runHousekeeping } from '../src/lib/jobs.js';
import { clearGrowthCache } from '../src/modules/growth.js';
import { StripePaymentProvider, FakePaymentProvider, paymentProvider } from '../src/lib/payments.js';

const hook = (body: object) => api().post('/api/webhooks/stripe').set('x-fake-signature', 'fake-webhook-secret').set('Content-Type', 'application/json').send(JSON.stringify(body));
async function order(seller: TestUser, buyer: TestUser, price = 20000, cat?: string) {
  const listing = await makeListing(seller, cat ?? (await makeCategory()), { price_cents: price, price_type: 'fixed' });
  const o = await api().post('/api/offers').set(auth(buyer)).send({ kind: 'goods', listing_id: listing.id, amount_cents: price });
  const acc = await api().post(`/api/offers/${o.body.id}/accept`).set(auth(seller));
  return { id: acc.body.order_id as string, listing };
}
const complete = (u: TestUser, id: string) => api().post(`/api/orders/${id}/complete`).set(auth(u));
const credit = async (u: TestUser) => (await api().get('/api/credits').set(auth(u))).body.balance_cents as number;
const giveCredit = (userId: string, cents: number) => pool.query(`INSERT INTO credit_ledger(user_id,amount_cents,reason,note) VALUES ($1,$2,'admin_adjustment','test')`, [userId, cents]);
async function register(ref?: string) {
  const username = `ref${Math.random().toString(36).slice(2, 8)}`;
  const r = await api().post('/api/auth/register').send({ email: `${username}@t.test`, username, password: 'password123', display_name: 'Ref', accept_terms: true, ...(ref ? { ref } : {}) });
  expect(r.status).toBe(201); return { id: r.body.user.id as string, username, token: r.body.access_token as string, refresh: '', code: r.body.user.referral_code as string };
}

describe('trending and discovery', () => {
  it('trends listings that have real recent activity, hides blocked sellers, and counts repeated tags', async () => {
    const seller = await makeUser('tre'), fan = await makeUser('fan'), fan2 = await makeUser('fn2'), viewer = await makeUser('vwr');
    const cat = await makeCategory(); const tag = `zq${Math.random().toString(36).slice(2, 7)}`;
    const hot = await makeListing(seller, cat, { title: 'Hot item', tags: [tag] }); const cold = await makeListing(seller, cat, { title: 'Cold item', tags: [tag] });
    for (const f of [fan, fan2]) { await api().put(`/api/reactions/listing/${hot.id}`).set(auth(f)); await api().put(`/api/saves/listing/${hot.id}`).set(auth(f)); }
    clearGrowthCache();
    const d = (await api().get('/api/discover').set(auth(viewer))).body;
    const ids = d.listings.map((l: any) => l.id);
    expect(ids).toContain(hot.id); expect(ids).not.toContain(cold.id);
    expect(d.tags.find((t: any) => t.tag === tag)?.uses).toBe(2);
    await api().post(`/api/blocks/${seller.id}`).set(auth(viewer));
    expect((await api().get('/api/discover').set(auth(viewer))).body.listings.map((l: any) => l.id)).not.toContain(hot.id);
    expect((await api().get('/api/discover')).status).toBe(200);                       // public
  });
  it('lists circles that gained members', async () => {
    const owner = await makeUser('own'); const c = await makeCircle(owner);
    for (let i = 0; i < 9; i++) await api().post(`/api/circles/${c.slug}/join`).set(auth(await makeUser('joi')));   // enough to rank among other circles growing in parallel tests
    clearGrowthCache();
    const d = (await api().get('/api/discover')).body; expect(d.circles.some((x: any) => x.slug === c.slug)).toBe(true);
  });
});

describe('recommendations', () => {
  it('suggests similar listings by category and tags, never itself or private items', async () => {
    const s = await makeUser('sim'); const cat = await makeCategory(); const other = await makeCategory();
    const a = await makeListing(s, cat, { title: 'Oak desk', tags: ['desk'] }); const b = await makeListing(s, cat, { title: 'Pine desk' });
    const c = await makeListing(s, other, { title: 'Walnut desk', tags: ['desk'] }); const d = await makeListing(s, other, { title: 'Unrelated' });
    const priv = await makeListing(s, cat, { title: 'Private desk', visibility: 'followers' });
    const ids = (await api().get(`/api/listings/${a.id}/similar`)).body.items.map((l: any) => l.id);
    expect(ids).toEqual(expect.arrayContaining([b.id, c.id])); expect(ids).not.toContain(a.id); expect(ids).not.toContain(d.id); expect(ids).not.toContain(priv.id);
    expect((await api().get(`/api/listings/${priv.id}/similar`)).status).toBe(404);   // not public
  });
  it('personalises from saves and excludes what you already saved, own and blocked sellers', async () => {
    const me = await makeUser('rec'), s = await makeUser('sel'), bad = await makeUser('bad'); const cat = await makeCategory();
    const first = await makeListing(s, cat, { title: 'First bike' }), more = await makeListing(s, cat, { title: 'Second bike' }), blocked = await makeListing(bad, cat, { title: 'Blocked bike' }), mine = await makeListing(me, cat, { title: 'My bike' });
    expect((await api().get('/api/recommendations/listings').set(auth(me))).body.basis).toBe('nearby_and_new');
    await api().put(`/api/saves/listing/${first.id}`).set(auth(me)); await api().post(`/api/blocks/${bad.id}`).set(auth(me));
    const r = (await api().get('/api/recommendations/listings').set(auth(me))).body; const ids = r.items.map((l: any) => l.id);
    expect(r.basis).toBe('your_activity'); expect(ids[0]).toBe(more.id);
    for (const x of [first, blocked, mine]) expect(ids).not.toContain(x.id);
    expect((await api().get('/api/recommendations/listings')).status).toBe(401);
  });
  it('suggests people followed by people you follow, with a reason, excluding those you already follow', async () => {
    const me = await makeUser('pme'), friend = await makeUser('frd'), target = await makeUser('tgt'), already = await makeUser('alr');
    await api().post(`/api/follows/user/${friend.id}`).set(auth(me)); await api().post(`/api/follows/user/${target.id}`).set(auth(friend));
    await api().post(`/api/follows/user/${already.id}`).set(auth(me)); await api().post(`/api/follows/user/${already.id}`).set(auth(friend));
    const items = (await api().get('/api/recommendations/people').set(auth(me))).body.items;
    const t = items.find((p: any) => p.id === target.id); expect(t.reason).toContain(`@${friend.username}`);
    expect(items.some((p: any) => p.id === already.id || p.id === me.id || p.id === friend.id)).toBe(false);
  });
});

describe('referrals and credit', () => {
  it('links a signup to a code, ignores bad codes, and shows stats', async () => {
    const referrer = await register(); expect(referrer.code).toMatch(/^[a-f0-9]{8}$/);
    const friend = await register(referrer.code.toUpperCase()); await register('nonsense');
    const me = (await api().get('/api/referrals/me').set({ Authorization: `Bearer ${referrer.token}` })).body;
    expect(me.stats).toMatchObject({ signed_up: 1, qualified: 0 }); expect(me.link).toContain(`ref=${referrer.code}`);
    expect((await pool.query('SELECT referred_by FROM users WHERE id=$1', [friend.id])).rows[0].referred_by).toBe(referrer.id);
    expect((await pool.query('SELECT count(*)::int n FROM referrals WHERE referee_id=$1', [friend.id])).rows[0].n).toBe(1);
  });
  it('rewards the referrer once, only for a real deal with someone else above the minimum', async () => {
    const referrer = await register(), friend = await register(referrer.code); const seller = await makeUser('sel');
    const ru = { id: referrer.id, username: referrer.username, token: referrer.token, refresh: '' } as TestUser, fu = { id: friend.id, username: friend.username, token: friend.token, refresh: '' } as TestUser;
    const small = await order(seller, fu, 500); await complete(fu, small.id);
    expect(await credit(ru)).toBe(0);                                                           // below the minimum deal
    const self = await order(ru, fu, 20000); await complete(fu, self.id);
    expect(await credit(ru)).toBe(0);                                                           // a deal with the referrer himself does not count
    const real = await order(seller, fu, 20000); expect((await complete(fu, real.id)).status).toBe(200);
    expect(await credit(ru)).toBe(500);
    const another = await order(seller, fu, 20000); await complete(fu, another.id);
    expect(await credit(ru)).toBe(500);                                                         // once only
    expect((await api().get('/api/notifications').set(auth(ru))).body.items.some((n: any) => n.type === 'referral_reward')).toBe(true);
    expect((await api().get('/api/referrals/me').set(auth(ru))).body.stats).toMatchObject({ qualified: 1, earned: 500 });
  });
  it('the ledger is append-only and the reward cap is honoured', async () => {
    const u = await makeUser('led'); await giveCredit(u.id, 100);
    await expect(pool.query(`UPDATE credit_ledger SET amount_cents=999 WHERE user_id=$1`, [u.id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM credit_ledger WHERE user_id=$1`, [u.id])).rejects.toThrow(/append-only/);
    await pool.query(`UPDATE platform_settings SET value='1' WHERE key='referral.max_rewards_per_user'`);
    try {
      const referrer = await register(); const seller = await makeUser('sel'); const ru = { id: referrer.id, username: referrer.username, token: referrer.token, refresh: '' } as TestUser;
      for (let i = 0; i < 2; i++) { const f = await register(referrer.code); const fu = { id: f.id, username: f.username, token: f.token, refresh: '' } as TestUser; await complete(fu, (await order(seller, fu)).id); }
      expect(await credit(ru)).toBe(500);
    } finally { await pool.query(`UPDATE platform_settings SET value='20' WHERE key='referral.max_rewards_per_user'`); }
  });
  it('admins can reject a referral and take the reward back', async () => {
    const referrer = await register(), friend = await register(referrer.code), seller = await makeUser('sel'), admin = await makeStaff('admin');
    const fu = { id: friend.id, username: friend.username, token: friend.token, refresh: '' } as TestUser; await complete(fu, (await order(seller, fu)).id);
    const ru = { id: referrer.id, username: referrer.username, token: referrer.token, refresh: '' } as TestUser; expect(await credit(ru)).toBe(500);
    const rid = (await pool.query('SELECT id FROM referrals WHERE referee_id=$1', [friend.id])).rows[0].id;
    expect((await api().post(`/api/admin/referrals/${rid}/reject`).set(auth(ru)).send({ reason: 'fraud' })).status).toBe(403);
    expect((await api().post(`/api/admin/referrals/${rid}/reject`).set(auth(admin)).send({ reason: 'self-referral ring' })).status).toBe(204);
    expect(await credit(ru)).toBe(0); expect((await api().post(`/api/admin/referrals/${rid}/reject`).set(auth(admin)).send({ reason: 'again again' })).status).toBe(409);
  });
  it('credit pays for a boost only when it covers the price, and two boosts cannot spend the same credit', async () => {
    const u = await makeUser('bst'); const cat = await makeCategory();
    const l1 = await makeListing(u, cat, { title: 'Boost one' }), l2 = await makeListing(u, cat, { title: 'Boost two' });
    await giveCredit(u.id, 300);
    const short = await api().post('/api/boosts').set(auth(u)).send({ target_type: 'listing', target_id: l1.id, placement: 'featured' });
    expect(short.body.paid_with_credit).toBeUndefined(); expect(short.body.payment.amount_cents).toBe(499);     // 300 < 499 so the card is used
    await api().delete(`/api/boosts/${short.body.boost_id}`).set(auth(u));
    await giveCredit(u.id, 200);                                                                              // 500 total
    const rs = await Promise.all([l1, l2].map((l) => api().post('/api/boosts').set(auth(u)).send({ target_type: 'listing', target_id: l.id, placement: 'featured' })));
    expect(rs.filter((r) => r.body.paid_with_credit)).toHaveLength(1);
    expect(await credit(u)).toBe(1);
    const mine = (await api().get('/api/boosts').set(auth(u))).body.items; expect(mine.filter((b: any) => b.status === 'active')).toHaveLength(1);
    const admin = await makeStaff('admin'); const bid = rs.find((r) => r.body.paid_with_credit)!.body.boost_id;
    expect((await api().post(`/api/admin/boosts/${bid}/cancel`).set(auth(admin)).send({ refund: true, reason: 'Goodwill' })).status).toBe(204);
    expect(await credit(u)).toBe(500);
  });
});

describe('analytics and insights', () => {
  it('records views once per visitor per 30 minutes, honours Do Not Track, and never counts the owner', async () => {
    const seller = await makeUser('ins'), v1 = await makeUser('vi1'); const l = await makeListing(seller, await makeCategory());
    const get = (h: Record<string, string> = {}) => api().get(`/api/listings/${l.id}`).set(h);
    await get({ 'x-anon-id': 'anon-visitor-aaaa1111' }); await get({ 'x-anon-id': 'anon-visitor-aaaa1111' }); await get(auth(v1)); await get(auth(v1)); await get(auth(seller));
    await get({ 'x-anon-id': 'anon-visitor-dnt', DNT: '1' }); await get();                       // opted out / unidentifiable
    const n = (await pool.query(`SELECT count(*)::int n FROM analytics_events WHERE name='view' AND target_id=$1`, [l.id])).rows[0].n;
    expect(n).toBe(2);
    const ins = (await api().get('/api/insights').set(auth(seller))).body;
    const it = ins.items.find((i: any) => i.id === l.id); expect(it).toMatchObject({ views: 2, visitors: 2 }); expect(ins.pro).toBe(false); expect(ins.daily).toBeUndefined();
  });
  it('accepts client events with validation and rate of at most 20, and ignores them when opted out', async () => {
    const u = await makeUser('evt'); const l = await makeListing(u, await makeCategory());
    const ok = await api().post('/api/analytics/events').set(auth(u)).send({ events: [{ name: 'share', target_type: 'listing', target_id: l.id }, { name: 'search', props: { q_len: 5 } }] });
    expect(ok.status).toBe(202); expect(ok.body.recorded).toBe(2);
    expect((await api().post('/api/analytics/events').send({ events: [{ name: 'signup' }] })).status).toBe(400);   // server-only events cannot be forged
    expect((await api().post('/api/analytics/events').send({ events: Array(21).fill({ name: 'search' }) })).status).toBe(400);
    expect((await api().post('/api/analytics/events').set('Sec-GPC', '1').send({ events: [{ name: 'search' }] })).body.recorded).toBe(0);
  });
  it('admin growth dashboard needs view.growth and reports a real funnel', async () => {
    const admin = await makeStaff('admin'), mod = await makeStaff('moderator'), user = await makeUser('usr');
    expect((await api().get('/api/admin/growth').set(auth(user))).status).toBe(403); expect((await api().get('/api/admin/growth').set(auth(mod))).status).toBe(403);
    const seller = await makeUser('fun'); await makeListing(seller, await makeCategory());
    const g = (await api().get('/api/admin/growth').set(auth(admin))).body;
    expect(g.funnel.signed_up).toBeGreaterThanOrEqual(g.funnel.posted); expect(g.funnel.posted).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(g.signups) && Array.isArray(g.retention)).toBe(true); expect(g.notes.length).toBeGreaterThan(0);
  });
  it('prunes old events in housekeeping', async () => {
    await pool.query(`INSERT INTO analytics_events(name, anon_id, created_at) VALUES ('search','prune-me-anon-1', now() - interval '200 days')`);
    expect((await runHousekeeping()).pruned_events).toBeGreaterThanOrEqual(1);
  });
});

describe('business pro subscription', () => {
  async function seller() { const u = await makeUser('pro'); await api().post('/api/payments/account/onboarding').set(auth(u)); await api().post('/api/payments/fake/onboarding/complete').set(auth(u)); return u; }
  it('activates, discounts the commission snapshot, unlocks pro insights, and cancels at period end', async () => {
    await pool.query(`UPDATE fee_rules SET percent_bps=1000 WHERE scope='product_sale'`);
    try {
      const s = await seller(), buyer = await makeUser('buy');
      expect((await api().get('/api/subscriptions/me').set(auth(s))).body).toMatchObject({ active: false, status: 'none', price_cents: 2900 });
      const co = await api().post('/api/subscriptions/checkout').set(auth(s)); expect(co.body.url).toContain('fake_subscription=1');
      const act = await api().post('/api/subscriptions/fake/activate').set(auth(s)); expect(act.body).toMatchObject({ active: true, status: 'active' });
      expect((await api().post('/api/subscriptions/checkout').set(auth(s))).status).toBe(409);
      const o = await order(s, buyer, 10000); const c = (await api().post('/api/payments/checkout').set(auth(buyer)).send({ order_id: o.id })).body;
      expect((await pool.query('SELECT fee_cents, fee_percent_bps FROM payments WHERE id=$1', [c.payment.id])).rows[0]).toMatchObject({ fee_cents: 900, fee_percent_bps: 900 });   // 10% minus 1 point
      const ins = (await api().get('/api/insights').set(auth(s))).body; expect(ins.pro).toBe(true); expect(ins.daily.length).toBe(30);
      const cancel = await api().post('/api/subscriptions/fake/cancel').set(auth(s)).send({}); expect(cancel.body).toMatchObject({ active: true, cancel_at_period_end: true });
      const end = await api().post('/api/subscriptions/fake/cancel').set(auth(s)).send({ immediately: true }); expect(end.body).toMatchObject({ active: false, status: 'canceled' });
      const o2 = await order(s, buyer, 10000); const c2 = (await api().post('/api/payments/checkout').set(auth(buyer)).send({ order_id: o2.id })).body;
      expect((await pool.query('SELECT fee_cents FROM payments WHERE id=$1', [c2.payment.id])).rows[0].fee_cents).toBe(1000);
      expect((await api().get('/api/notifications').set(auth(s))).body.items.some((n: any) => n.type === 'subscription_update')).toBe(true);
    } finally { await pool.query(`UPDATE fee_rules SET percent_bps=0 WHERE scope='product_sale'`); }
  });
  it('a late "active" event for an already cancelled subscription does not reactivate it', async () => {
    const s = await makeUser('stl'); const sub = { id: 'sub_stale_1', customerId: 'cus_stale_1', userId: s.id, cancelAtPeriodEnd: false };
    const send = (id: string, status: string) => hook({ id, type: 'subscription.updated', subscription: { ...sub, status } });
    await send(`e${Date.now()}a`, 'active'); await send(`e${Date.now()}b`, 'canceled'); await send(`e${Date.now()}c`, 'active');
    expect((await api().get('/api/subscriptions/me').set(auth(s))).body.status).toBe('canceled');
  });
  it('stripe adapter builds a subscription checkout session and parses subscription events (mocked client)', async () => {
    process.env.STRIPE_PRICE_BUSINESS_PRO = 'price_x';
    const { config } = await import('../src/config.js'); (config as any).STRIPE_PRICE_BUSINESS_PRO = 'price_x';
    const calls: any[] = [];
    const client: any = { checkout: { sessions: { create: async (p: any) => (calls.push(p), { url: 'https://checkout.stripe.test/s' }) } }, billingPortal: { sessions: { create: async () => ({ url: 'https://portal' }) } },
      webhooks: { constructEvent: () => ({ id: 'evt_sub', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'trialing', cancel_at_period_end: true, current_period_end: 1900000000, metadata: { twiqo_user_id: 'u-1' } } } }) } };
    const p = new StripePaymentProvider(client, 'pk', ['whsec']);
    const r = await p.createSubscriptionCheckout({ userId: 'u-1', email: 'a@b.c', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
    expect(r.url).toBe('https://checkout.stripe.test/s');
    expect(calls[0]).toMatchObject({ mode: 'subscription', line_items: [{ price: 'price_x', quantity: 1 }], client_reference_id: 'u-1', customer_email: 'a@b.c', subscription_data: { metadata: { twiqo_user_id: 'u-1' } } });
    expect(p.parseWebhook(Buffer.from('{}'), { 'stripe-signature': 's' })).toMatchObject({ type: 'subscription.updated', subscription: { id: 'sub_1', customerId: 'cus_1', userId: 'u-1', status: 'active', cancelAtPeriodEnd: true } });
    expect(await p.subscriptionPortal('cus_1', 'https://x')).toBe('https://portal');
    expect(paymentProvider()).toBeInstanceOf(FakePaymentProvider);
  });
});

describe('locale', () => {
  it('stores a language preference and rejects unsupported ones', async () => {
    const u = await makeUser('loc');
    expect((await api().patch('/api/me/locale').set(auth(u)).send({ locale: 'fr' })).body.locale).toBe('fr');
    expect((await api().get('/api/me').set(auth(u))).body.user.locale).toBe('fr');
    expect((await api().patch('/api/me/locale').set(auth(u)).send({ locale: 'xx' })).status).toBe(400);
  });
});
