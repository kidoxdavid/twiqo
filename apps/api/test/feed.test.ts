import { describe, expect, it } from 'vitest';
import { api, auth, makeUser, makeCategory, makeListing } from './helpers.js';

const ids = (r: any) => r.body.items.map((i: any) => i.id);

describe('feed', () => {
  it('following tab contains only followed accounts', async () => {
    const me = await makeUser('fme'), a = await makeUser('fua'), b = await makeUser('fub');
    const pa = (await api().post('/api/posts').set(auth(a)).send({ body: 'from a' })).body;
    const pb = (await api().post('/api/posts').set(auth(b)).send({ body: 'from b' })).body;
    await api().post(`/api/follows/user/${a.id}`).set(auth(me));
    const f = await api().get('/api/feed').query({ tab: 'following' }).set(auth(me));
    expect(ids(f)).toContain(pa.id);
    expect(ids(f)).not.toContain(pb.id);
    expect((await api().get('/api/feed').query({ tab: 'following' })).status).toBe(400);
  });

  it('mixes posts and listings and links them to the source records', async () => {
    const u = await makeUser('mix'), cat = await makeCategory();
    const l = await makeListing(u, cat, { title: 'Feed lamp', price_cents: 4200 });
    const post = (await api().post('/api/posts').set(auth(u)).send({ kind: 'share', body: 'Selling!', attachment_type: 'listing', attachment_id: l.id })).body;
    const f = await api().get('/api/feed').query({ tab: 'following', limit: 30 }).set(auth(await (async () => { const v = await makeUser('mixv'); await api().post(`/api/follows/user/${u.id}`).set(auth(v)); return v; })()));
    const types = f.body.items.map((i: any) => i.type);
    expect(types).toContain('listing'); expect(types).toContain('post');
    // price change shows up in the shared post immediately: the post only references the listing
    await api().patch(`/api/listings/${l.id}`).set(auth(u)).send({ price_cents: 3100 });
    const got = (await api().get(`/api/posts/${post.id}`)).body;
    expect(got.attachment.listing.price_cents).toBe(3100);
  });

  it('nearby tab filters by distance', async () => {
    const calg = await makeUser('nc', 'Calgary'), tor = await makeUser('nt', 'Toronto'), viewer = await makeUser('nv', 'Calgary');
    const pc = (await api().post('/api/posts').set(auth(calg)).send({ body: 'calgary news' })).body;
    const pt = (await api().post('/api/posts').set(auth(tor)).send({ body: 'toronto news' })).body;
    const f = await api().get('/api/feed').query({ tab: 'nearby', limit: 30 }).set(auth(viewer));
    expect(ids(f)).toContain(pc.id); expect(ids(f)).not.toContain(pt.id);
    const t = await api().get('/api/feed').query({ tab: 'nearby', city: 'Toronto' }).set(auth(viewer));
    expect(ids(t)).toContain(pt.id); expect(ids(t)).not.toContain(pc.id);
    expect((await api().get('/api/feed').query({ tab: 'nearby' })).status).toBe(400);
  });

  it('excludes blocked accounts and removed content, and paginates', async () => {
    const me = await makeUser('xme'), bad = await makeUser('xbad'), a = await makeUser('xa');
    const posts = [];
    for (let i = 0; i < 5; i++) posts.push((await api().post('/api/posts').set(auth(a)).send({ body: `page post ${i}` })).body.id);
    const hidden = (await api().post('/api/posts').set(auth(bad)).send({ body: 'blocked person post' })).body;
    await api().post(`/api/blocks/${bad.id}`).set(auth(me));
    await api().post(`/api/follows/user/${a.id}`).set(auth(me));
    await api().delete(`/api/posts/${posts[4]}`).set(auth(a));
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await api().get('/api/feed').query({ tab: 'following', limit: 2, cursor }).set(auth(me));
      seen.push(...ids(r)); cursor = r.body.next_cursor; if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(posts[4]);
    expect(seen.sort()).toEqual(posts.slice(0, 4).sort());
    const all = await api().get('/api/feed').query({ tab: 'for_you', limit: 30 }).set(auth(me));
    expect(ids(all)).not.toContain(hidden.id);
  });

  it('for_you ranks followed accounts above strangers of the same age', async () => {
    const me = await makeUser('rme'), friend = await makeUser('rfr'), stranger = await makeUser('rst');
    const s = (await api().post('/api/posts').set(auth(stranger)).send({ body: 'stranger post' })).body;
    const f = (await api().post('/api/posts').set(auth(friend)).send({ body: 'friend post' })).body;
    await api().post(`/api/follows/user/${friend.id}`).set(auth(me));
    const r = await api().get('/api/feed').query({ tab: 'for_you', limit: 30 }).set(auth(me));
    expect(ids(r).indexOf(f.id)).toBeLessThan(ids(r).indexOf(s.id));
  });

  it('circles tab is honest about not being available yet', async () => {
    const r = await api().get('/api/feed').query({ tab: 'circles' });
    expect(r.body.items).toEqual([]); expect(r.body.notice).toBeTruthy();
  });
});
