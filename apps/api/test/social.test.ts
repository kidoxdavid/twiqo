import { describe, expect, it } from 'vitest';
import { api, auth, makeUser } from './helpers.js';

describe('follow / block / privacy', () => {
  it('follows idempotently and keeps counters correct', async () => {
    const a = await makeUser('fa'), b = await makeUser('fb');
    expect((await api().post(`/api/follows/user/${b.id}`).set(auth(a))).status).toBe(204);
    expect((await api().post(`/api/follows/user/${b.id}`).set(auth(a))).status).toBe(204);
    let p = await api().get(`/api/users/${b.username}`).set(auth(a));
    expect(p.body.counts.followers).toBe(1);
    expect(p.body.viewer.following).toBe(true);
    await api().delete(`/api/follows/user/${b.id}`).set(auth(a));
    await api().delete(`/api/follows/user/${b.id}`).set(auth(a));
    p = await api().get(`/api/users/${b.username}`).set(auth(a));
    expect(p.body.counts.followers).toBe(0);
    const me = await api().get('/api/me').set(auth(a));
    expect(me.body.user.following_count).toBe(0);
  });

  it('cannot follow yourself', async () => {
    const a = await makeUser('self');
    expect((await api().post(`/api/follows/user/${a.id}`).set(auth(a))).status).toBe(400);
  });

  it('blocking removes follows, hides the profile and prevents re-following', async () => {
    const a = await makeUser('ba'), b = await makeUser('bb');
    await api().post(`/api/follows/user/${b.id}`).set(auth(a));
    await api().post(`/api/follows/user/${a.id}`).set(auth(b));
    expect((await api().post(`/api/blocks/${b.id}`).set(auth(a))).status).toBe(204);
    expect((await api().get(`/api/users/${a.username}`).set(auth(b))).status).toBe(404);
    expect((await api().get(`/api/users/${b.username}`).set(auth(a))).status).toBe(200);
    expect((await api().post(`/api/follows/user/${a.id}`).set(auth(b))).status).toBe(403);
    expect((await api().get(`/api/users/${b.username}`).set(auth(a))).body.counts.followers).toBe(0);
    expect((await api().get(`/api/users/${a.username}`).set(auth(a))).body.counts.followers).toBe(0);
    expect((await api().get('/api/me/blocks').set(auth(a))).body.items.map((x: any) => x.id)).toContain(b.id);
    await api().delete(`/api/blocks/${b.id}`).set(auth(a));
    expect((await api().get(`/api/users/${a.username}`).set(auth(b))).status).toBe(200);
  });

  it('respects profile privacy settings', async () => {
    const a = await makeUser('pa'), b = await makeUser('pb');
    const r = await api().patch('/api/me/profile').set(auth(a)).send({ privacy: { show_followers: false, show_location: false } });
    expect(r.status).toBe(200);
    const view = await api().get(`/api/users/${a.username}`).set(auth(b));
    expect(view.body.counts.followers).toBeNull();
    expect(view.body.location).toBeNull();
    expect((await api().get(`/api/users/${a.username}/followers`).set(auth(b))).status).toBe(403);
    const own = await api().get(`/api/users/${a.username}`).set(auth(a));
    expect(own.body.location.city).toBe('Calgary');
  });

  it('updates the profile and rejects unknown cities and foreign media', async () => {
    const a = await makeUser('up'), b = await makeUser('ub');
    expect((await api().patch('/api/me/profile').set(auth(a)).send({ bio: 'Hello', city: 'Toronto' })).body.user.city).toBe('Toronto');
    expect((await api().patch('/api/me/profile').set(auth(a)).send({ city: 'Atlantis' })).status).toBe(400);
    expect((await api().patch('/api/me/profile').set(auth(b)).send({ avatar_media_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
  });
});
