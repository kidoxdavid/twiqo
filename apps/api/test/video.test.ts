import crypto from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api, auth, makeCategory, makeCircle, makeListing, makeUser, makeVideoFile, startVideo, until, uploadVideo, waitVideo } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { BunnyVideoProvider } from '../src/lib/video.js';

const clip = (u: any, video_id: string, over: Record<string, unknown> = {}) => api().post('/api/posts').set(auth(u)).send({ kind: 'video', body: 'My first clip', video_id, ...over });
const setSetting = (k: string, v: unknown) => pool.query('UPDATE platform_settings SET value=$2 WHERE key=$1', [k, JSON.stringify(v)]);

beforeAll(async () => { await setSetting('clips.min_account_age_hours', 0); });   // test accounts are brand new

describe('video pipeline (local FFmpeg provider)', () => {
  it('uploads, transcodes to a phone-friendly MP4 with a poster, and plays back', async () => {
    const u = await makeUser('vu');
    const { id, final } = await uploadVideo(u);
    expect(final.status).toBe('ready'); expect(final.duration_s).toBeGreaterThan(1); expect(final.duration_s).toBeLessThan(3);
    expect(final.width).toBeLessThanOrEqual(720); expect(final.height).toBeLessThanOrEqual(1280);
    expect(final.urls.mp4).toMatch(/\/media\/video\/.+\.mp4$/); expect(final.urls.poster).toMatch(/\.jpg$/);
    const get = await api().get(new URL(final.urls.mp4).pathname); expect(get.status).toBe(200); expect(get.headers['content-type']).toMatch(/video\/mp4/);
    expect((await api().get(new URL(final.urls.poster).pathname)).status).toBe(200);
    expect((await api().get(`/api/videos/${id}`).set(auth(await makeUser('vo')))).status).toBe(404);   // only the owner polls status
  });

  it('rejects clips that are too long, files that are not video, and oversized uploads', async () => {
    const u = await makeUser('vr');
    const long = await uploadVideo(u, makeVideoFile(95, 64, 64));
    expect(long.final.status).toBe('rejected'); expect(long.final.error).toMatch(/at most 90 seconds/);
    const junk = await startVideo(u);
    expect((await api().put(junk.upload.url).set(auth(u)).set('Content-Type', 'video/mp4').send(Buffer.from('this is definitely not a video file'))).status).toBe(202);
    const jf = await waitVideo(u, junk.id); expect(jf.status).toBe('rejected'); expect(jf.error).toBeTruthy();
    await setSetting('video.max_mb', 1);
    try {
      expect((await api().post('/api/videos').set(auth(u)).send({ bytes: 5 * 1024 * 1024 })).status).toBe(413);
      const big = await startVideo(u);
      expect((await api().put(big.upload.url).set(auth(u)).set('Content-Type', 'video/mp4').send(Buffer.alloc(2 * 1024 * 1024, 1))).status).toBe(413);
    } finally { await setSetting('video.max_mb', 200); }
    const other = await makeUser('vr2'); const v = await startVideo(u);
    expect((await api().put(v.upload.url).set(auth(other)).send(Buffer.from('x'))).status).toBe(404);   // someone else's upload slot
    expect((await api().post('/api/videos')).status).toBe(401);
  });

  it('keeps a clip out of the feeds until its video is ready, then publishes it (acceptance B)', async () => {
    const u = await makeUser('vp'), viewer = await makeUser('vv'); const cat = await makeCategory(); const listing = await makeListing(u, cat, { title: 'Desk from the video', price_cents: 20000 });
    const v = await startVideo(u);
    const post = await clip(u, v.id, { attachment_type: 'listing', attachment_id: listing.id }); expect(post.status).toBe(201);
    expect(post.body.video.status).toBe('uploading'); expect(post.body.video.urls).toBeNull();
    const inFeed = async () => (await api().get('/api/feed').query({ tab: 'for_you', limit: 30 }).set(auth(viewer))).body.items.some((i: any) => i.id === post.body.id);
    const inClips = async () => (await api().get('/api/clips').query({ limit: 20 }).set(auth(viewer))).body.items.some((i: any) => i.id === post.body.id);
    expect(await inFeed()).toBe(false); expect(await inClips()).toBe(false);
    await api().put(v.upload.url).set(auth(u)).set('Content-Type', 'video/mp4').send(makeVideoFile());
    await waitVideo(u, v.id);
    expect(await inFeed()).toBe(true); expect(await inClips()).toBe(true);
    const got = (await api().get('/api/clips').query({ limit: 20 }).set(auth(viewer))).body.items.find((i: any) => i.id === post.body.id);
    expect(got.video.urls.mp4).toBeTruthy(); expect(got.attachment.listing.title).toBe('Desk from the video');   // product tag stays a live record
    expect(got.attachment.listing.price_cents).toBe(20000);
  });

  it('removes the post when processing fails; one video, one post; ownership enforced', async () => {
    const u = await makeUser('vf'), x = await makeUser('vx');
    const bad = await startVideo(u); const p = (await clip(u, bad.id)).body;
    await api().put(bad.upload.url).set(auth(u)).set('Content-Type', 'video/mp4').send(Buffer.from('nope nope nope'));
    await waitVideo(u, bad.id);
    expect((await api().get(`/api/posts/${p.id}`).set(auth(u))).status).toBe(404);
    expect((await clip(u, bad.id)).status).toBe(400);                       // cannot reuse a failed video
    const ok = await uploadVideo(u); expect((await clip(u, ok.id)).status).toBe(201); expect((await clip(u, ok.id)).status).toBe(409);
    expect((await clip(x, ok.id)).status).toBe(400);                         // not yours
    expect((await api().post('/api/posts').set(auth(u)).send({ kind: 'video', body: 'no video' })).status).toBe(400);
    expect((await api().delete(`/api/videos/${ok.id}`).set(auth(u))).status).toBe(409);   // in use
  });

  it('ranks and filters clips: following, blocked creators, young accounts, nearby', async () => {
    const me = await makeUser('cl-me', 'Calgary'), a = await makeUser('cl-a', 'Calgary'), b = await makeUser('cl-b', 'Toronto'), bad = await makeUser('cl-bad', 'Calgary');
    const mk = async (u: any, body: string) => { const v = await uploadVideo(u); return (await clip(u, v.id, { body })).body; };
    const pa = await mk(a, 'from a'), pb = await mk(b, 'from b'), pbad = await mk(bad, 'from bad');
    await api().post(`/api/follows/user/${a.id}`).set(auth(me)); await api().post(`/api/blocks/${bad.id}`).set(auth(me));
    const ids = async (q: Record<string, string>) => (await api().get('/api/clips').query({ limit: 20, ...q }).set(auth(me))).body.items.map((i: any) => i.id);
    expect(await ids({ tab: 'following' })).toEqual([pa.id]);
    const all = await ids({ tab: 'for_you' }); expect(all).toEqual(expect.arrayContaining([pa.id, pb.id])); expect(all).not.toContain(pbad.id);
    expect(all.indexOf(pa.id)).toBeLessThan(all.indexOf(pb.id));            // followed creator ranks higher
    expect(await ids({ tab: 'nearby' })).toContain(pa.id); expect(await ids({ tab: 'nearby' })).not.toContain(pb.id);
    expect((await api().get('/api/clips').query({ tab: 'following' })).status).toBe(400);
    await setSetting('clips.min_account_age_hours', 24);   // spam guard: brand-new accounts only reach their followers
    try { const young = await ids({ tab: 'for_you' }); expect(young).toContain(pa.id); expect(young).not.toContain(pb.id); } finally { await setSetting('clips.min_account_age_hours', 0); }
  });

  it('counts a view once per person per day and never the creator', async () => {
    const c = await makeUser('wc'), w = await makeUser('ww'); const v = await uploadVideo(c); const p = (await clip(c, v.id)).body;
    for (let i = 0; i < 3; i++) await api().post(`/api/posts/${p.id}/view`).set(auth(w));
    await api().post(`/api/posts/${p.id}/view`).set(auth(c)); await api().post(`/api/posts/${p.id}/view`);
    expect((await api().get(`/api/posts/${p.id}`)).body.view_count).toBe(2);   // w once + one signed-out viewer
  });

  it('lets a circle member post a clip into a circle', async () => {
    const o = await makeUser('ccO'), m = await makeUser('ccM'); const c = await makeCircle(o); await api().post(`/api/circles/${c.slug}/join`).set(auth(m));
    const v = await uploadVideo(m); const p = await clip(m, v.id, { group_id: c.id });
    expect(p.status).toBe(201); expect(p.body.group.slug).toBe(c.slug);
    expect((await api().get(`/api/circles/${c.slug}/posts`).set(auth(o))).body.items.map((i: any) => i.id)).toContain(p.body.id);
  });
});

describe('polls', () => {
  it('creates a poll, takes one vote per person, shows results and closes', async () => {
    const a = await makeUser('pa'), b = await makeUser('pb'), c = await makeUser('pc');
    const p = await api().post('/api/posts').set(auth(a)).send({ kind: 'poll', body: 'Best way to move a sofa?', poll: { options: ['Pickup truck', 'Van', 'Friends'], closes_in_hours: 24 } });
    expect(p.status).toBe(201); expect(p.body.poll.options).toHaveLength(3); expect(p.body.poll.total_votes).toBe(0);
    const [o1, o2] = p.body.poll.options;
    expect((await api().post(`/api/posts/${p.body.id}/vote`).set(auth(b)).send({ option_id: o1.id })).body.poll).toMatchObject({ total_votes: 1, my_vote: o1.id });
    expect((await api().post(`/api/posts/${p.body.id}/vote`).set(auth(b)).send({ option_id: o2.id })).status).toBe(409);   // one vote each
    const r = await api().post(`/api/posts/${p.body.id}/vote`).set(auth(c)).send({ option_id: o1.id });
    expect(r.body.poll.options.find((o: any) => o.id === o1.id)).toMatchObject({ votes: 2, pct: 100 });
    expect((await api().get(`/api/posts/${p.body.id}`).set(auth(b))).body.poll.my_vote).toBe(o1.id);
    expect((await api().post(`/api/posts/${p.body.id}/vote`).set(auth(a)).send({ option_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    await pool.query(`UPDATE posts SET poll_closes_at = now() - interval '1 minute' WHERE id=$1`, [p.body.id]);
    expect((await api().post(`/api/posts/${p.body.id}/vote`).set(auth(await makeUser('pd'))).send({ option_id: o2.id })).status).toBe(409);
    expect((await api().get(`/api/posts/${p.body.id}`)).body.poll.closed).toBe(true);
  });

  it('validates polls and keeps private-circle polls private', async () => {
    const a = await makeUser('pv');
    for (const poll of [{ options: ['Only one'] }, { options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }]) expect((await api().post('/api/posts').set(auth(a)).send({ kind: 'poll', body: 'Q?', poll })).status).toBe(400);
    expect((await api().post('/api/posts').set(auth(a)).send({ kind: 'poll', poll: { options: ['a', 'b'] } })).status).toBe(400);
    expect((await api().post('/api/posts').set(auth(a)).send({ kind: 'text', body: 'x', poll: { options: ['a', 'b'] } })).status).toBe(400);
    const c = await makeCircle(a, { visibility: 'private' }); const outsider = await makeUser('po');
    const p = (await api().post('/api/posts').set(auth(a)).send({ kind: 'poll', body: 'Secret poll', poll: { options: ['yes', 'no'] }, group_id: c.id })).body;
    expect((await api().post(`/api/posts/${p.id}/vote`).set(auth(outsider)).send({ option_id: p.poll.options[0].id })).status).toBe(404);
  });
});

describe('Bunny Stream adapter (HTTP mocked; not a live-account test)', () => {
  const lib = '12345', key = 'secret-key', host = 'vz-test.b-cdn.net';
  const bunny = () => new BunnyVideoProvider(lib, key, host);
  afterEach(() => vi.unstubAllGlobals());

  it('creates a video and signs a TUS upload without exposing the API key', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ guid: 'abc-123-guid' }), { status: 200 }); }));
    const { providerVideoId, upload } = await bunny().createUpload({ title: 'My clip' });
    expect(providerVideoId).toBe('abc-123-guid');
    expect(calls[0].url).toBe(`https://video.bunnycdn.com/library/${lib}/videos`); expect(calls[0].init.headers.AccessKey).toBe(key); expect(JSON.parse(calls[0].init.body)).toEqual({ title: 'My clip' });
    if (upload.type !== 'tus') throw new Error('expected tus');
    const expected = crypto.createHash('sha256').update(`${lib}${key}${upload.expires_at}abc-123-guid`).digest('hex');
    expect(upload.headers).toMatchObject({ AuthorizationSignature: expected, VideoId: 'abc-123-guid', LibraryId: lib, AuthorizationExpire: String(upload.expires_at) });
    expect(upload.endpoint).toBe('https://video.bunnycdn.com/tusupload');
    expect(JSON.stringify(upload)).not.toContain(key);
  });

  it('maps Bunny statuses and builds playback URLs', async () => {
    const respond = (status: number, extra = {}) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status, length: 31, width: 720, height: 1280, ...extra }), { status: 200 })));
    const ref = { id: 'x', provider: 'bunny' as const, provider_video_id: 'g1' };
    respond(2); expect((await bunny().refresh(ref)).status).toBe('processing');
    respond(3); expect((await bunny().refresh(ref)).status).toBe('processing');
    respond(4); expect(await bunny().refresh(ref)).toMatchObject({ status: 'ready', durationS: 31, width: 720, height: 1280 });
    respond(5); expect((await bunny().refresh(ref)).status).toBe('failed');
    expect(bunny().urls(ref)).toEqual({ hls: `https://${host}/g1/playlist.m3u8`, mp4: `https://${host}/g1/play_720p.mp4`, poster: `https://${host}/g1/thumbnail.jpg` });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 }))); await expect(bunny().refresh(ref)).rejects.toThrow(/401/);
  });

  it('webhook needs the secret and never trusts the payload: it re-asks Bunny for the real status', async () => {
    (config as any).BUNNY_WEBHOOK_SECRET = 'hook-secret-123'; const u = await makeUser('bw');
    const vid = (await pool.query(`INSERT INTO videos(owner_id,provider,provider_video_id,status) VALUES ($1,'bunny','guid-webhook-1','processing') RETURNING id`, [u.id])).rows[0].id;
    const post = (await pool.query(`INSERT INTO posts(author_id,kind,body,video_id) VALUES ($1,'video','bunny clip',$2) RETURNING id`, [u.id, vid])).rows[0].id;
    expect((await api().post('/api/videos/webhook/bunny').send({ VideoGuid: 'guid-webhook-1', Status: 4 })).status).toBe(401);
    expect((await api().post('/api/videos/webhook/bunny').query({ secret: 'wrong-secret-xyz' }).send({ VideoGuid: 'guid-webhook-1', Status: 4 })).status).toBe(401);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 3 }), { status: 200 })));   // payload claims finished (4) but Bunny says still encoding
    config.BUNNY_API_KEY = key; config.BUNNY_LIBRARY_ID = lib;
    expect((await api().post('/api/videos/webhook/bunny').query({ secret: 'hook-secret-123' }).send({ VideoGuid: 'guid-webhook-1', Status: 4 })).status).toBe(200);
    expect((await pool.query('SELECT status FROM videos WHERE id=$1', [vid])).rows[0].status).toBe('processing');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 4, length: 20, width: 720, height: 1280 }), { status: 200 })));
    await api().post('/api/videos/webhook/bunny').query({ secret: 'hook-secret-123' }).send({ VideoGuid: 'guid-webhook-1', Status: 4 });
    expect((await pool.query('SELECT status, duration_s FROM videos WHERE id=$1', [vid])).rows[0]).toMatchObject({ status: 'ready' });
    expect((await api().get(`/api/posts/${post}`)).body.video.urls.hls).toContain('guid-webhook-1/playlist.m3u8');
    // a failure removes what was waiting on it
    const v2 = (await pool.query(`INSERT INTO videos(owner_id,provider,provider_video_id,status) VALUES ($1,'bunny','guid-webhook-2','processing') RETURNING id`, [u.id])).rows[0].id;
    const p2 = (await pool.query(`INSERT INTO posts(author_id,kind,body,video_id) VALUES ($1,'video','doomed',$2) RETURNING id`, [u.id, v2])).rows[0].id;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 5 }), { status: 200 })));
    await api().post('/api/videos/webhook/bunny').query({ secret: 'hook-secret-123' }).send({ VideoGuid: 'guid-webhook-2' });
    expect((await api().get(`/api/posts/${p2}`).set(auth(u))).status).toBe(404);
    (config as any).BUNNY_WEBHOOK_SECRET = undefined;
    await until(async () => true);
  });
});
