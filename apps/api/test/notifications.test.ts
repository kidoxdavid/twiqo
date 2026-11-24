import { beforeEach, describe, expect, it } from 'vitest';
import { api, auth, makeCategory, makeJourney, makeListing, makeUser, type TestUser } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runQueue } from '../src/lib/queue.js';
import { emailProvider, FakeEmailProvider } from '../src/lib/email.js';
import { FakePushSender, setPushSender } from '../src/lib/push.js';
import { sendDigests, unsubscribeToken } from '../src/lib/delivery.js';

const KINDS = ['deliver_notification', 'match_saved_searches', 'price_drop', 'send_email'];
const drain = async () => { for (let i = 0; i < 30; i++) { const r = await runQueue(200, { kinds: KINDS }); if (!r.ran && !r.failed) break; } };
let push: FakePushSender;
beforeEach(() => { push = new FakePushSender(); setPushSender(push); (emailProvider() as FakeEmailProvider).fail = false; });
const verified = (u: TestUser) => pool.query(`UPDATE users SET email_verified_at=now() WHERE id=$1`, [u.id]);
const sub = (u: TestUser, endpoint = `https://push.example/${Math.random().toString(36).slice(2)}`) => api().post('/api/push/subscribe').set(auth(u)).send({ endpoint, keys: { p256dh: 'p', auth: 'a' } }).then((r) => ({ r, endpoint }));
const emails = async (u: TestUser, template = 'notification') => (await pool.query(`SELECT * FROM outbox_emails WHERE user_id=$1 AND template=$2 ORDER BY id`, [u.id, template])).rows;
const offer = async (buyer: TestUser, seller: TestUser, price = 20000) => { const l = await makeListing(seller, await makeCategory(), { price_cents: price, price_type: 'fixed' }); await api().post('/api/offers').set(auth(buyer)).send({ kind: 'goods', listing_id: l.id, amount_cents: price }); return l; };

describe('push and email delivery', () => {
  it('pushes and emails important notifications, in the recipient\'s language, only to verified emails', async () => {
    const seller = await makeUser('sel'), buyer = await makeUser('buy'); const { r, endpoint } = await sub(seller); expect(r.status).toBe(204);
    await offer(buyer, seller); await drain();
    const p = push.sent.filter((x) => x.endpoint === endpoint); expect(p).toHaveLength(1); expect(p[0].payload.title).toContain('New offer'); expect(p[0].payload.url).toBe('/offers');
    expect(await emails(seller)).toHaveLength(0);                                              // email not verified yet
    await verified(seller); await offer(buyer, seller); await drain();
    const m = await emails(seller); expect(m).toHaveLength(1); expect(m[0].unsubscribe_url).toContain('/api/email/unsubscribe?t='); expect(m[0].body_text).toContain('Unsubscribe');
    await api().patch('/api/me/locale').set(auth(seller)).send({ locale: 'fr' }); await offer(buyer, seller); await drain();
    expect((await emails(seller)).pop().subject).toContain('Nouvelle offre');
  });
  it('respects per-channel settings and defaults (social noise is not emailed)', async () => {
    const a = await makeUser('cha'), b = await makeUser('chb'); await verified(a); const { endpoint } = await sub(a);
    await api().post(`/api/follows/user/${a.id}`).set(auth(b)); await drain();
    expect(await emails(a)).toHaveLength(0); expect(push.sent.some((x) => x.endpoint === endpoint && x.payload.title.includes('followed you'))).toBe(true);
    await api().put('/api/me/notification-channels').set(auth(a)).send({ type: 'follow', channel: 'email', enabled: true });
    await api().put('/api/me/notification-channels').set(auth(a)).send({ type: 'offer_received', channel: 'push', enabled: false });
    const c = await makeUser('chc'); await api().post(`/api/follows/user/${a.id}`).set(auth(c)); await drain(); expect(await emails(a)).toHaveLength(1);
    const before = push.sent.length; await offer(b, a); await drain(); expect(push.sent.length).toBe(before);   // push for offers is off now
    const prefs = (await api().get('/api/me/notification-channels').set(auth(a))).body; expect(prefs.items.find((i: any) => i.type === 'offer_received')).toMatchObject({ push: false, email: true });
    expect((await api().put('/api/me/notification-channels').set(auth(a)).send({ type: 'nope', channel: 'email', enabled: true })).status).toBe(400);
  });
  it('drops dead push subscriptions, counts failures, and rejects subscriptions when push is not configured', async () => {
    const s = await makeUser('psh'), b = await makeUser('psb'); const a = await sub(s); const bad = await sub(s); push.gone.add(a.endpoint);
    await offer(b, s); await drain();
    expect((await pool.query('SELECT count(*)::int n FROM push_subscriptions WHERE endpoint=$1', [a.endpoint])).rows[0].n).toBe(0);
    push.fail = true; await offer(b, s); await drain();
    expect((await pool.query('SELECT failures FROM push_subscriptions WHERE endpoint=$1', [bad.endpoint])).rows[0].failures).toBe(1);
    push.enabled = false; expect((await sub(s)).r.status).toBe(409);
    expect((await api().get('/api/push/config')).body).toMatchObject({ enabled: false });
  });
  it('one-click unsubscribe only changes anything on POST with a valid signed token', async () => {
    const u = await makeUser('uns'), b = await makeUser('unb'); await verified(u); const t = unsubscribeToken(u.id);
    expect((await api().get(`/api/email/unsubscribe?t=${t}`)).text).toContain('<form'); expect((await pool.query('SELECT email_notifications_off FROM users WHERE id=$1', [u.id])).rows[0].email_notifications_off).toBe(false);
    expect((await api().post('/api/email/unsubscribe?t=bad.token')).status).toBe(400); expect((await api().post(`/api/email/unsubscribe?t=${unsubscribeToken(b.id).replace(/.$/, 'x')}`)).status).toBe(400);
    expect((await api().post(`/api/email/unsubscribe?t=${t}`)).status).toBe(200);
    await offer(b, u); await drain(); expect(await emails(u)).toHaveLength(0);
    await api().put('/api/me/email-notifications').set(auth(u)).send({ off: false }); await offer(b, u); await drain(); expect(await emails(u)).toHaveLength(1);
  });
  it('sends one digest to people who have unread notifications and have been away', async () => {
    const u = await makeUser('dig'), b = await makeUser('dib'); await verified(u); await offer(b, u); await drain();
    expect(await emails(u, 'digest')).toHaveLength(0);
    await pool.query(`UPDATE users SET last_seen_at = now() - interval '2 days' WHERE id=$1`, [u.id]);
    expect(await sendDigests()).toBeGreaterThanOrEqual(1); expect(await emails(u, 'digest')).toHaveLength(1);
    await sendDigests(); expect(await emails(u, 'digest')).toHaveLength(1);                    // not again within 24 hours
  });
});

describe('saved searches and alerts', () => {
  it('alerts when a new listing matches keywords and filters, once, never for own or blocked sellers', async () => {
    const watcher = await makeUser('wat'), seller = await makeUser('sel'), blocked = await makeUser('blk'); const cat = await makeCategory(`desks-${Math.random().toString(36).slice(2, 6)}`);
    expect((await api().post('/api/saved-searches').set(auth(watcher)).send({ kind: 'listing', name: 'empty', params: {} })).status).toBe(400);
    const s = await api().post('/api/saved-searches').set(auth(watcher)).send({ kind: 'listing', name: 'Walnut desks', params: { q: 'walnut desk', max_price: 50000 } }); expect(s.status).toBe(201);
    await api().post(`/api/blocks/${blocked.id}`).set(auth(watcher));
    await makeListing(seller, cat, { title: 'Walnut desk with drawers', price_cents: 30000 });
    await makeListing(seller, cat, { title: 'Walnut desk (too pricey)', price_cents: 90000 });
    await makeListing(seller, cat, { title: 'Oak chair', price_cents: 5000 });
    await makeListing(blocked, cat, { title: 'Walnut desk from blocked seller', price_cents: 20000 });
    await makeListing(watcher, cat, { title: 'My own walnut desk', price_cents: 20000 });
    await drain();
    const n = (await api().get('/api/notifications').set(auth(watcher))).body.items.filter((x: any) => x.type === 'saved_search_match');
    expect(n).toHaveLength(1); expect(n[0].data.title).toBe('Walnut desk with drawers'); expect(n[0].data.search_name).toBe('Walnut desks');
    await api().patch(`/api/saved-searches/${s.body.id}`).set(auth(watcher)).send({ active: false });
    await makeListing(seller, cat, { title: 'Another walnut desk', price_cents: 20000 }); await drain();
    expect((await api().get('/api/notifications').set(auth(watcher))).body.items.filter((x: any) => x.type === 'saved_search_match')).toHaveLength(1);
    expect((await api().delete(`/api/saved-searches/${s.body.id}`).set(auth(await makeUser('oth')))).status).toBe(404);
    expect((await api().delete(`/api/saved-searches/${s.body.id}`).set(auth(watcher))).status).toBe(204);
  });
  it('caps saved searches per person and alerts per search per day', async () => {
    const u = await makeUser('cap'), seller = await makeUser('sel'); const cat = await makeCategory(); await pool.query(`UPDATE platform_settings SET value='2' WHERE key='saved_search.max_per_user'`);
    try {
      expect((await api().post('/api/saved-searches').set(auth(u)).send({ kind: 'listing', name: 'one', params: { q: 'quokka' } })).status).toBe(201);
      expect((await api().post('/api/saved-searches').set(auth(u)).send({ kind: 'listing', name: 'two', params: { q: 'wombat' } })).status).toBe(201);
      expect((await api().post('/api/saved-searches').set(auth(u)).send({ kind: 'listing', name: 'three', params: { q: 'numbat' } })).status).toBe(409);
    } finally { await pool.query(`UPDATE platform_settings SET value='20' WHERE key='saved_search.max_per_user'`); }
    await pool.query(`UPDATE platform_settings SET value='2' WHERE key='saved_search.max_alerts_per_day'`);
    try { for (let i = 0; i < 4; i++) { await makeListing(seller, cat, { title: `quokka number ${i}` }); await drain(); }
      expect((await api().get('/api/notifications').set(auth(u))).body.items.filter((x: any) => x.type === 'saved_search_match')).toHaveLength(2);
    } finally { await pool.query(`UPDATE platform_settings SET value='10' WHERE key='saved_search.max_alerts_per_day'`); }
  });
  it('alerts shippers when a journey is posted along their corridor, and drivers when a request is', async () => {
    const shipper = await makeUser('shp', 'Toronto'), driver = await makeUser('drv', 'Toronto');
    await api().post('/api/saved-searches').set(auth(shipper)).send({ kind: 'journey', name: 'TO to CGY', params: { from: 'Toronto', to: 'Calgary', radius_km: 80 } });
    await api().post('/api/saved-searches').set(auth(shipper)).send({ kind: 'journey', name: 'Montreal to Halifax', params: { from: 'Montreal', to: 'Halifax' } });
    await api().post('/api/saved-searches').set(auth(driver)).send({ kind: 'request', name: 'Loads out of Toronto', params: { from: 'Toronto', to: 'Calgary' } });
    await makeJourney(driver); await drain();
    const mine = (await api().get('/api/notifications').set(auth(shipper))).body.items.filter((x: any) => x.type === 'saved_search_match'); expect(mine).toHaveLength(1); expect(mine[0].data.search_name).toBe('TO to CGY');
    const { makeRequest } = await import('./helpers.js'); await makeRequest(shipper); await drain();
    expect((await api().get('/api/notifications').set(auth(driver))).body.items.filter((x: any) => x.type === 'saved_search_match')).toHaveLength(1);
    expect((await api().post('/api/saved-searches').set(auth(driver)).send({ kind: 'journey', name: 'x', params: { from: 'Nowhereville', to: 'Calgary' } })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('price-drop alerts', () => {
  it('tells people who saved an item about a real price drop, once per price, not for tiny drops or increases', async () => {
    const seller = await makeUser('sel'), saver = await makeUser('sav'), other = await makeUser('oth'); const l = await makeListing(seller, await makeCategory(), { title: 'Road bike', price_cents: 100000, price_type: 'negotiable' });
    await api().put(`/api/saves/listing/${l.id}`).set(auth(saver));
    const patch = (cents: number) => api().patch(`/api/listings/${l.id}`).set(auth(seller)).send({ price_cents: cents });
    const count = async () => (await api().get('/api/notifications').set(auth(saver))).body.items.filter((x: any) => x.type === 'price_drop');
    await patch(99000); await drain(); expect(await count()).toHaveLength(0);           // 1% is not worth an alert
    await patch(120000); await drain(); expect(await count()).toHaveLength(0);           // increases never alert
    await patch(90000); await drain(); const n = await count(); expect(n).toHaveLength(1); expect(n[0].data).toMatchObject({ old_cents: 120000, new_cents: 90000 });
    await patch(90000); await drain(); expect(await count()).toHaveLength(1);
    expect((await api().get('/api/notifications').set(auth(other))).body.items.filter((x: any) => x.type === 'price_drop')).toHaveLength(0);
  });
});
