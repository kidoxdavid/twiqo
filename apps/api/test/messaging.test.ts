import { describe, expect, it } from 'vitest';
import { api, auth, makeUser, makeCategory, makeListing } from './helpers.js';

describe('messaging', () => {
  it('starts a listing conversation, tracks unread and read state', async () => {
    const buyer = await makeUser('mb'), seller = await makeUser('ms'); const cat = await makeCategory();
    const l = await makeListing(seller, cat, { title: 'Chat chair' });
    const c = await api().post('/api/conversations').set(auth(buyer)).send({ recipient_id: seller.id, subject_type: 'listing', subject_id: l.id, message: 'Is it available?' });
    expect(c.status).toBe(201);
    const again = await api().post('/api/conversations').set(auth(buyer)).send({ recipient_id: seller.id, subject_type: 'listing', subject_id: l.id });
    expect(again.body.id).toBe(c.body.id);
    const list = await api().get('/api/conversations').set(auth(seller));
    expect(list.body.items[0].unread).toBe(1);
    expect(list.body.items[0].subject.title).toBe('Chat chair');
    expect((await api().get('/api/me/unread').set(auth(seller))).body.messages).toBe(1);
    expect((await api().get('/api/me/unread').set(auth(buyer))).body.messages).toBe(0);
    await api().post(`/api/conversations/${c.body.id}/read`).set(auth(seller));
    expect((await api().get('/api/me/unread').set(auth(seller))).body.messages).toBe(0);
    const msgs = await api().get(`/api/conversations/${c.body.id}/messages`).set(auth(buyer));
    expect(msgs.body.items[0].read).toBe(true);
    await api().post(`/api/conversations/${c.body.id}/messages`).set(auth(seller)).send({ body: 'Yes!' });
    expect((await api().get('/api/conversations').set(auth(buyer))).body.items[0].unread).toBe(1);
  });

  it('keeps conversations private to members', async () => {
    const a = await makeUser('pa'), b = await makeUser('pb'), x = await makeUser('px');
    const c = (await api().post('/api/conversations').set(auth(a)).send({ recipient_id: b.id, message: 'secret' })).body;
    expect((await api().get(`/api/conversations/${c.id}/messages`).set(auth(x))).status).toBe(404);
    expect((await api().post(`/api/conversations/${c.id}/messages`).set(auth(x)).send({ body: 'hi' })).status).toBe(404);
    expect((await api().get(`/api/conversations/${c.id}/messages`)).status).toBe(401);
  });

  it('enforces blocks and privacy settings', async () => {
    const a = await makeUser('ea'), b = await makeUser('eb'), c = await makeUser('ec');
    await api().patch('/api/me/profile').set(auth(b)).send({ privacy: { allow_messages: 'nobody' } });
    expect((await api().post('/api/conversations').set(auth(a)).send({ recipient_id: b.id, message: 'hi' })).status).toBe(403);
    await api().patch('/api/me/profile').set(auth(b)).send({ privacy: { allow_messages: 'followers' } });
    expect((await api().post('/api/conversations').set(auth(a)).send({ recipient_id: b.id })).status).toBe(403);
    await api().post(`/api/follows/user/${b.id}`).set(auth(a));
    const conv = await api().post('/api/conversations').set(auth(a)).send({ recipient_id: b.id, message: 'hello' });
    expect(conv.status).toBe(201);
    await api().post(`/api/blocks/${a.id}`).set(auth(b));
    expect((await api().post(`/api/conversations/${conv.body.id}/messages`).set(auth(a)).send({ body: 'still there?' })).status).toBe(403);
    expect((await api().get('/api/conversations').set(auth(b))).body.items).toHaveLength(0);
    expect((await api().post('/api/conversations').set(auth(c)).send({ recipient_id: c.id })).status).toBe(400);
  });

  it('lets users report a message from a conversation they are in, but not others', async () => {
    const a = await makeUser('ra'), b = await makeUser('rb'), x = await makeUser('rx');
    const c = (await api().post('/api/conversations').set(auth(a)).send({ recipient_id: b.id, message: 'send me money' })).body;
    const m = (await api().get(`/api/conversations/${c.id}/messages`).set(auth(b))).body.items[0];
    expect((await api().post('/api/reports').set(auth(b)).send({ target_type: 'message', target_id: m.id, reason: 'fraud' })).status).toBe(201);
    expect((await api().post('/api/reports').set(auth(x)).send({ target_type: 'message', target_id: m.id, reason: 'fraud' })).status).toBe(404);
  });

  it('searches conversations', async () => {
    const a = await makeUser('sa'), b = await makeUser('sb');
    await api().post('/api/conversations').set(auth(a)).send({ recipient_id: b.id, message: 'about the piano' });
    expect((await api().get('/api/conversations').query({ q: 'piano' }).set(auth(b))).body.items).toHaveLength(1);
    expect((await api().get('/api/conversations').query({ q: 'zzzz' }).set(auth(b))).body.items).toHaveLength(0);
  });
});
