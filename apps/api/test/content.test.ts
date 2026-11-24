import { describe, expect, it } from 'vitest';
import { api, auth, makeUser, makeStaff, PNG } from './helpers.js';
import { pool } from '../src/db/pool.js';

describe('posts, comments, reactions', () => {
  it('uploads re-encoded images and rejects non-images by content', async () => {
    const u = await makeUser('img');
    const ok = await api().post('/api/media').set(auth(u)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(ok.status).toBe(201);
    expect(ok.body.url).toMatch(/\.webp$/);
    const fake = await api().post('/api/media').set(auth(u)).attach('file', Buffer.from('<?php echo 1; ?>'), { filename: 'evil.png', contentType: 'image/png' });
    expect(fake.status).toBe(415);
    expect((await api().post('/api/media').attach('file', PNG, 'a.png')).status).toBe(401);
  });

  it('creates posts with photos and enforces per-kind rules', async () => {
    const u = await makeUser('post');
    const img = await api().post('/api/media').set(auth(u)).attach('file', PNG, 'a.png');
    const p = await api().post('/api/posts').set(auth(u)).send({ kind: 'photo', body: 'Look', media_ids: [img.body.id] });
    expect(p.status).toBe(201);
    expect(p.body.media).toHaveLength(1);
    expect((await api().post('/api/posts').set(auth(u)).send({ kind: 'photo' })).status).toBe(400);
    expect((await api().post('/api/posts').set(auth(u)).send({ kind: 'text' })).status).toBe(400);
    expect((await api().post('/api/posts').set(auth(u)).send({ kind: 'video', body: 'x' })).status).toBe(422);
    const other = await makeUser('post2');
    expect((await api().post('/api/posts').set(auth(other)).send({ kind: 'photo', media_ids: [img.body.id] })).status).toBe(400);
  });

  it('likes are idempotent and counters never go negative', async () => {
    const a = await makeUser('la'), b = await makeUser('lb');
    const p = (await api().post('/api/posts').set(auth(a)).send({ body: 'hello' })).body;
    await api().put(`/api/reactions/post/${p.id}`).set(auth(b));
    const r = await api().put(`/api/reactions/post/${p.id}`).set(auth(b));
    expect(r.body.like_count).toBe(1);
    expect((await api().delete(`/api/reactions/post/${p.id}`).set(auth(b))).body.like_count).toBe(0);
    expect((await api().delete(`/api/reactions/post/${p.id}`).set(auth(b))).body.like_count).toBe(0);
    expect((await api().get(`/api/posts/${p.id}`).set(auth(b))).body.viewer.liked).toBe(false);
  });

  it('threads comments one level deep and notifies the author', async () => {
    const a = await makeUser('ca'), b = await makeUser('cb');
    const p = (await api().post('/api/posts').set(auth(a)).send({ body: 'hello' })).body;
    const c1 = (await api().post('/api/comments').set(auth(b)).send({ target_type: 'post', target_id: p.id, body: 'first' })).body;
    const r1 = (await api().post('/api/comments').set(auth(a)).send({ target_type: 'post', target_id: p.id, parent_id: c1.id, body: 'reply' })).body;
    const r2 = await api().post('/api/comments').set(auth(b)).send({ target_type: 'post', target_id: p.id, parent_id: r1.id, body: 'reply to reply' });
    expect(r2.body.parent_id).toBe(c1.id);
    const list = await api().get('/api/comments').query({ target_type: 'post', target_id: p.id });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].replies).toHaveLength(2);
    expect((await api().get(`/api/posts/${p.id}`)).body.counts.comments).toBe(3);
    const notes = await api().get('/api/notifications').set(auth(a));
    expect(notes.body.items.some((n: any) => n.type === 'comment')).toBe(true);
  });

  it('only authors or moderators can delete; moderator removals are audited', async () => {
    const a = await makeUser('da'), b = await makeUser('db'), mod = await makeStaff('moderator');
    const p = (await api().post('/api/posts').set(auth(a)).send({ body: 'bad post' })).body;
    expect((await api().delete(`/api/posts/${p.id}`).set(auth(b))).status).toBe(403);
    expect((await api().delete(`/api/posts/${p.id}`).set(auth(mod))).status).toBe(204);
    expect((await api().get(`/api/posts/${p.id}`)).status).toBe(404);
    const log = await pool.query(`SELECT 1 FROM audit_logs WHERE action='post.remove' AND target_id=$1 AND actor_id=$2`, [p.id, mod.id]);
    expect(log.rowCount).toBe(1);
  });

  it('hides followers-only posts from non-followers and blocked users', async () => {
    const a = await makeUser('va'), f = await makeUser('vf'), s = await makeUser('vs');
    const p = (await api().post('/api/posts').set(auth(a)).send({ body: 'friends only', visibility: 'followers' })).body;
    expect((await api().get(`/api/posts/${p.id}`).set(auth(s))).status).toBe(404);
    expect((await api().get(`/api/posts/${p.id}`)).status).toBe(404);
    await api().post(`/api/follows/user/${a.id}`).set(auth(f));
    expect((await api().get(`/api/posts/${p.id}`).set(auth(f))).status).toBe(200);
    await api().post(`/api/blocks/${f.id}`).set(auth(a));
    expect((await api().get(`/api/posts/${p.id}`).set(auth(f))).status).toBe(404);
  });

  it('blocks posts that contain banned words and holds flagged ones for review', async () => {
    const a = await makeUser('bw'), admin = await makeStaff('admin');
    await api().post('/api/admin/banned-words').set(auth(admin)).send({ term: 'zzblockword', severity: 'block' });
    await api().post('/api/admin/banned-words').set(auth(admin)).send({ term: 'zzflagword', severity: 'flag' });
    expect((await api().post('/api/posts').set(auth(a)).send({ body: 'buy ZZBlockWord now' })).status).toBe(422);
    const flagged = await api().post('/api/posts').set(auth(a)).send({ body: 'maybe zzflagword here' });
    expect(flagged.status).toBe(201);
    expect(flagged.body.status).toBe('pending');
    const feed = await api().get('/api/feed').query({ tab: 'for_you', limit: 30 });
    expect(feed.body.items.find((i: any) => i.id === flagged.body.id)).toBeUndefined();
  });

  it('accepts reports once per target and shows them to moderators', async () => {
    const a = await makeUser('ra'), b = await makeUser('rb'), mod = await makeStaff('moderator');
    const p = (await api().post('/api/posts').set(auth(a)).send({ body: 'spammy' })).body;
    expect((await api().post('/api/reports').set(auth(b)).send({ target_type: 'post', target_id: p.id, reason: 'spam' })).status).toBe(201);
    await api().post('/api/reports').set(auth(b)).send({ target_type: 'post', target_id: p.id, reason: 'spam' });
    const q = await api().get('/api/admin/reports').set(auth(mod));
    expect(q.body.items.filter((r: any) => r.target_id === p.id)).toHaveLength(1);
    expect((await api().get('/api/admin/reports').set(auth(b))).status).toBe(403);
  });
});
