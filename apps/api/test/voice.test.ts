import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, auth, makeUser, type TestUser } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { runHousekeeping } from '../src/lib/jobs.js';
import { voicePath, voiceUrl } from '../src/lib/voice.js';

const dir = path.dirname(voicePath('00000000-0000-0000-0000-000000000000.m4a'));
const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
/** Real recordings made with ffmpeg in the formats browsers produce. */
function clip(name: string, seconds: number, codecArgs: string[]) {
  const f = `/tmp/twiqo-voice-test-${name}`; if (!fs.existsSync(f)) execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...codecArgs, f]); return fs.readFileSync(f);
}
const webm = () => clip('2s.webm', 2, ['-c:a', 'libopus']);
const safari = () => clip('2s.m4a', 2, ['-c:a', 'aac']);
async function chat() { const a = await makeUser('vca'), b = await makeUser('vcb'); const id = (await api().post('/api/conversations').set(auth(a)).send({ recipient_id: b.id })).body.id as string; return { a, b, id }; }
const send = (u: TestUser, id: string, buf: Buffer, name = 'rec.webm') => api().post(`/api/conversations/${id}/voice`).set(auth(u)).attach('file', buf, name);
const list = (u: TestUser, id: string) => api().get(`/api/conversations/${id}/messages`).set(auth(u)).then((r) => r.body.items);

describe('voice messages', () => {
  it('accepts browser recordings (WebM/Opus and MP4/AAC), re-encodes them, and plays back through a signed link', async () => {
    const { a, b, id } = await chat();
    for (const buf of [webm(), safari()]) {
      const r = await send(a, id, buf); expect(r.status).toBe(201); expect(r.body.duration_ms).toBeGreaterThan(1500); expect(r.body.duration_ms).toBeLessThan(2600);
    }
    const msgs = await list(b, id); const v = msgs.filter((m: any) => m.kind === 'voice'); expect(v).toHaveLength(2);
    expect(v[0].voice.url).toMatch(/^\/api\/voice\/[0-9a-f-]+\?u=/); expect(v[0].body).toBeNull();
    const audio = await api().get(v[0].voice.url); expect(audio.status).toBe(200); expect(audio.headers['content-type']).toBe('audio/mp4'); expect(audio.headers['accept-ranges']).toBe('bytes'); expect(audio.headers['x-content-type-options']).toBe('nosniff');
    const total = Number(audio.headers['content-length']); expect(total).toBeGreaterThan(1000);
    const part = await api().get(v[0].voice.url).set('Range', 'bytes=0-99'); expect(part.status).toBe(206); expect(part.headers['content-range']).toBe(`bytes 0-99/${total}`);
    expect((await api().get(v[0].voice.url).set('Range', 'bytes=999999999-')).status).toBe(416);
    expect((await api().get(v[0].voice.url).set('Range', `bytes=-50`)).headers['content-range']).toBe(`bytes ${total - 50}-${total - 1}/${total}`);
    const ownCopy = (await list(a, id)).find((m: any) => m.kind === 'voice'); expect((await api().get(ownCopy.voice.url)).status).toBe(200);   // the sender can play their own
  });
  it('protects recordings: bad or expired links, outsiders, and removed messages all fail', async () => {
    const { a, b, id } = await chat(); const outsider = await makeUser('vco'); const mid = (await send(a, id, webm())).body.id as string;
    const good = (await list(b, id)).find((m: any) => m.id === mid).voice.url as string;
    expect((await api().get(good.replace(/sig=[^&]+/, 'sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).status).toBe(403);
    expect((await api().get(good.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) + 99999}`))).status).toBe(403);   // can't extend a link
    expect((await api().get(voiceUrl(mid, b.id, -5))).status).toBe(403);                                                       // expired
    expect((await api().get(voiceUrl(mid, outsider.id))).status).toBe(404);                                                   // validly signed for someone who isn't in the conversation
    expect((await api().get(good.replace(b.id, outsider.id))).status).toBe(403);                                              // can't reuse another person's link
    await pool.query(`UPDATE messages SET status='removed' WHERE id=$1`, [mid]);
    expect((await api().get(good)).status).toBe(404); expect((await list(b, id)).find((m: any) => m.id === mid).voice).toBeUndefined();
    await pool.query(`UPDATE messages SET status='active' WHERE id=$1`, [mid]);
    await api().post(`/api/blocks/${a.id}`).set(auth(b)); expect((await api().get(good)).status).toBe(404);                    // blocking stops playback too
  });
  it('rejects things that are not a usable recording and leaves no file behind', async () => {
    const { a, id } = await chat(); const before = files();
    expect((await send(a, id, Buffer.from('this is definitely not audio at all, just text'), 'x.webm')).status).toBe(422);
    expect((await send(a, id, clip('0.2s.webm', 0.2, ['-c:a', 'libopus']))).status).toBe(422);
    const long = await send(a, id, clip('130s.webm', 130, ['-c:a', 'libopus', '-b:a', '8k'])); expect(long.status).toBe(422); expect(long.body.error.code).toBe('too_long');
    expect((await api().post(`/api/conversations/${id}/voice`).set(auth(a))).status).toBe(400);
    expect((await send(await makeUser('vcn'), id, webm())).status).toBe(404);                                                  // not a member
    expect((await api().post(`/api/conversations/${id}/voice`).attach('file', webm(), 'a.webm')).status).toBe(401);
    expect(files()).toBe(before);
  });
  it('does not store a recording when the message is refused (blocked), and treats voice as a normal message otherwise', async () => {
    const { a, b, id } = await chat(); await api().post(`/api/blocks/${a.id}`).set(auth(b)); const before = files();
    expect((await send(a, id, webm())).status).toBeGreaterThanOrEqual(400); expect(files()).toBe(before);
    const convs = (await api().get('/api/conversations').set(auth(a))).body.items; expect(convs.find((c: any) => c.id === id)).toBeUndefined();   // blocked threads stay hidden
  });
  it('shows voice in the conversation list, and deletes recordings after the retention window and when an account is deleted', async () => {
    const { a, b, id } = await chat(); const mid = (await send(a, id, webm())).body.id as string;
    expect((await api().get('/api/conversations').set(auth(b))).body.items.find((c: any) => c.id === id).last_message).toMatchObject({ kind: 'voice', body: null });
    const key = (await pool.query('SELECT audio_key FROM messages WHERE id=$1', [mid])).rows[0].audio_key as string; expect(fs.existsSync(voicePath(key))).toBe(true);
    await pool.query(`UPDATE messages SET created_at = now() - interval '200 days' WHERE id=$1`, [mid]); expect((await runHousekeeping()).voice_expired).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(voicePath(key))).toBe(false); const m = (await list(b, id)).find((x: any) => x.id === mid); expect(m.voice).toMatchObject({ expired: true });
    const mid2 = (await send(a, id, webm())).body.id as string; const key2 = (await pool.query('SELECT audio_key FROM messages WHERE id=$1', [mid2])).rows[0].audio_key as string;
    expect((await api().delete('/api/me').set(auth(a)).send({ password: 'password123' })).status).toBe(204);
    expect(fs.existsSync(voicePath(key2))).toBe(false); expect((await pool.query('SELECT audio_key FROM messages WHERE id=$1', [mid2])).rows[0].audio_key).toBeNull();
  });
});
