import { describe, expect, it } from 'vitest';
import { api, auth, makeCategory, makeListing, makeUser, PNG, startVideo, uploadVideo, waitVideo, makeVideoFile } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runHousekeeping } from '../src/lib/jobs.js';

const story = (u: any, body: Record<string, unknown>) => api().post('/api/stories').set(auth(u)).send(body);
const tray = async (u: any) => (await api().get('/api/stories/tray').set(auth(u))).body.items;

describe('stories', () => {
  it('posts text and photo stories that expire on the configured clock', async () => {
    const a = await makeUser('sa'), f = await makeUser('sf'); await api().post(`/api/follows/user/${a.id}`).set(auth(f));
    const photo = (await api().post('/api/media').set(auth(a)).attach('file', PNG, 'a.png')).body;
    const t = await story(a, { kind: 'text', text_body: 'Garage sale Saturday!', bg: '#13B9B0' }); expect(t.status).toBe(201);
    const p = await story(a, { kind: 'photo', media_id: photo.id }); expect(p.status).toBe(201); expect(p.body.image_url).toContain('/media/');
    const hours = (new Date(t.body.expires_at).getTime() - Date.now()) / 36e5; expect(hours).toBeGreaterThan(23.9); expect(hours).toBeLessThanOrEqual(24);
    expect((await api().get(`/api/stories/user/${a.username}`).set(auth(f))).body.items).toHaveLength(2);
    // admin-configurable lifetime
    await pool.query(`UPDATE platform_settings SET value='6' WHERE key='story.expiry_hours'`);
    try { const s6 = await story(a, { kind: 'text', text_body: 'short lived' }); expect((new Date(s6.body.expires_at).getTime() - Date.now()) / 36e5).toBeLessThanOrEqual(6); } finally { await pool.query(`UPDATE platform_settings SET value='24' WHERE key='story.expiry_hours'`); }
    // expiry
    await pool.query(`UPDATE stories SET expires_at = now() - interval '1 minute' WHERE id=$1`, [t.body.id]);
    expect((await api().get(`/api/stories/user/${a.username}`).set(auth(f))).body.items.map((s: any) => s.id)).not.toContain(t.body.id);
    expect((await runHousekeeping()).stories).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT status FROM stories WHERE id=$1', [t.body.id])).rows[0].status).toBe('expired');
  });

  it('validates input and ownership of media', async () => {
    const a = await makeUser('sv'), b = await makeUser('sw');
    for (const bad of [{ kind: 'text' }, { kind: 'photo' }, { kind: 'video' }, { kind: 'text', text_body: 'x'.repeat(301) }, { kind: 'text', text_body: 'x', bg: 'red' }, { kind: 'text', text_body: 'x', link_type: 'listing' }]) expect((await story(a, bad)).status, JSON.stringify(bad)).toBe(400);
    const photo = (await api().post('/api/media').set(auth(a)).attach('file', PNG, 'a.png')).body;
    expect((await story(b, { kind: 'photo', media_id: photo.id })).status).toBe(400);   // someone else's upload
    expect((await api().post('/api/stories').send({ kind: 'text', text_body: 'x' })).status).toBe(401);
  });

  it('builds a tray from people you follow, with unseen first, and marks views', async () => {
    const me = await makeUser('tm'), a = await makeUser('ta'), b = await makeUser('tb'), stranger = await makeUser('ts');
    await api().post(`/api/follows/user/${a.id}`).set(auth(me)); await api().post(`/api/follows/user/${b.id}`).set(auth(me));
    const sa = (await story(a, { kind: 'text', text_body: 'from a' })).body; await story(b, { kind: 'text', text_body: 'from b' }); await story(stranger, { kind: 'text', text_body: 'not followed' });
    let t = await tray(me); expect(t.map((x: any) => x.author.username).sort()).toEqual([a.username, b.username].sort()); expect(t.every((x: any) => !x.all_seen)).toBe(true);
    expect((await api().post(`/api/stories/${sa.id}/view`).set(auth(me))).status).toBe(204); await api().post(`/api/stories/${sa.id}/view`).set(auth(me));
    t = await tray(me); expect(t.find((x: any) => x.author.username === a.username).all_seen).toBe(true); expect(t[t.length - 1].author.username).toBe(a.username);   // seen goes last
    const own = await tray(a); expect(own[0].is_me).toBe(true);
    expect((await api().get('/api/stories/tray')).status).toBe(401);
  });

  it('shows viewers only to the author and counts each person once', async () => {
    const a = await makeUser('va'), v1 = await makeUser('v1'), v2 = await makeUser('v2'), hater = await makeUser('vh');
    const s = (await story(a, { kind: 'text', text_body: 'who is watching' })).body;
    for (const v of [v1, v1, v2, hater]) await api().post(`/api/stories/${s.id}/view`).set(auth(v)); await api().post(`/api/stories/${s.id}/view`).set(auth(a));
    await api().post(`/api/blocks/${a.id}`).set(auth(hater));   // privacy: a viewer who blocked the author is not exposed
    const viewers = await api().get(`/api/stories/${s.id}/viewers`).set(auth(a));
    expect(viewers.body.items.map((x: any) => x.username).sort()).toEqual([v1.username, v2.username].sort());
    expect((await api().get(`/api/stories/${s.id}/viewers`).set(auth(v1))).status).toBe(404);
    expect((await api().get(`/api/stories/user/${a.username}`).set(auth(a))).body.items[0].view_count).toBe(3);
    expect((await api().get(`/api/stories/user/${a.username}`).set(auth(v1))).body.items[0].view_count).toBeUndefined();
  });

  it('respects followers-only visibility and blocks', async () => {
    const a = await makeUser('fa'), fan = await makeUser('ff'), out = await makeUser('fo');
    await api().post(`/api/follows/user/${a.id}`).set(auth(fan));
    const priv = (await story(a, { kind: 'text', text_body: 'followers only', visibility: 'followers' })).body; const pub = (await story(a, { kind: 'text', text_body: 'for everyone' })).body;
    const ids = async (u: any) => (await api().get(`/api/stories/user/${a.username}`).set(auth(u))).body.items.map((s: any) => s.id);
    expect(await ids(fan)).toEqual(expect.arrayContaining([priv.id, pub.id])); expect(await ids(out)).toEqual([pub.id]);
    expect((await api().post(`/api/stories/${priv.id}/view`).set(auth(out))).status).toBe(404);
    await api().post(`/api/blocks/${fan.id}`).set(auth(a)); expect(await ids(fan)).toEqual([]);
  });

  it('links a story to a product or business page (optional)', async () => {
    const a = await makeUser('la'), cat = await makeCategory(); const l = await makeListing(a, cat, { title: 'Story product' });
    const s = await story(a, { kind: 'text', text_body: 'New in!', link_type: 'listing', link_id: l.id }); expect(s.body.link).toMatchObject({ type: 'listing', id: l.id, label: 'Story product' });
    const biz = (await api().post('/api/businesses').set(auth(a)).send({ name: 'Story Shop', slug: `story-shop-${Date.now()}` })).body;
    expect((await story(a, { kind: 'text', text_body: 'Visit us', link_type: 'business', link_id: biz.id, business_id: biz.id })).body.link.type).toBe('business');
    expect((await story(a, { kind: 'text', text_body: 'bad link', link_type: 'listing', link_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await story(await makeUser('lb'), { kind: 'text', text_body: 'not my business', business_id: biz.id })).status).toBe(403);
  });

  it('video stories wait for processing and disappear if the video is rejected', async () => {
    const a = await makeUser('ev'), f = await makeUser('ef'); await api().post(`/api/follows/user/${a.id}`).set(auth(f));
    const v = await startVideo(a); const s = (await story(a, { kind: 'video', video_id: v.id })).body;
    expect((await api().get(`/api/stories/user/${a.username}`).set(auth(f))).body.items).toHaveLength(0);   // not visible until ready
    await api().put(v.upload.url).set(auth(a)).set('Content-Type', 'video/mp4').send(makeVideoFile()); await waitVideo(a, v.id);
    const items = (await api().get(`/api/stories/user/${a.username}`).set(auth(f))).body.items; expect(items).toHaveLength(1); expect(items[0].video.urls.mp4).toBeTruthy();
    const bad = await startVideo(a); const sb = (await story(a, { kind: 'video', video_id: bad.id })).body;
    await api().put(bad.upload.url).set(auth(a)).set('Content-Type', 'video/mp4').send(Buffer.from('garbage garbage')); await waitVideo(a, bad.id);
    expect((await api().get(`/api/stories/user/${a.username}`).set(auth(f))).body.items.map((x: any) => x.id)).not.toContain(sb.id);
    void s;
  });

  it('lets authors delete, and moderators remove, stories', async () => {
    const a = await makeUser('da'), other = await makeUser('do'), mod = await makeUser('dm'); await pool.query(`INSERT INTO user_roles(user_id,role_key) VALUES ($1,'moderator')`, [mod.id]);
    const s1 = (await story(a, { kind: 'text', text_body: 'mine' })).body, s2 = (await story(a, { kind: 'text', text_body: 'bad story' })).body;
    expect((await api().delete(`/api/stories/${s1.id}`).set(auth(other))).status).toBe(403);
    expect((await api().delete(`/api/stories/${s1.id}`).set(auth(a))).status).toBe(204);
    expect((await api().delete(`/api/stories/${s2.id}`).set(auth(mod))).status).toBe(204);
    expect((await pool.query(`SELECT 1 FROM audit_logs WHERE action='story.remove' AND target_id=$1`, [s2.id])).rowCount).toBe(1);
    expect((await api().get(`/api/stories/user/${a.username}`).set(auth(other))).body.items).toHaveLength(0);
    void uploadVideo;
  });
});
