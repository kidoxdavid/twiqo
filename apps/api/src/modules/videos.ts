import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { HttpError, badRequest, conflict, notFound, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { setting } from '../lib/policy.js';
import { defaultProvider, localProvider, providerByName, videoUrls, type ProviderStatus } from '../lib/video.js';

export const videos = Router();
const uuid = z.string().uuid();
const limiter = rateLimit({ windowMs: 60 * 60_000, limit: 30, skip: () => config.RATE_LIMIT_DISABLED === 'true', keyGenerator: (r) => r.user?.id ?? ipKeyGenerator(r.ip ?? '0.0.0.0') });

export const videoView = (v: any) => v && ({
  id: v.id, status: v.status, duration_s: v.duration_s === null ? null : Number(v.duration_s), width: v.width, height: v.height, error: v.error ?? undefined,
  ...(v.status === 'ready' ? { urls: videoUrls(v) } : { urls: null }),
});

/** Record the provider's verdict. A terminal failure takes down anything that was waiting on this video. */
export async function applyVideoStatus(db: Db, videoId: string, st: ProviderStatus) {
  if (st.status === 'ready') {
    await db.query(`UPDATE videos SET status='ready', ready_at=coalesce(ready_at, now()), duration_s=coalesce($2, duration_s), width=coalesce($3, width), height=coalesce($4, height), error=NULL WHERE id=$1 AND status IN ('uploading','processing','ready')`, [videoId, st.durationS ?? null, st.width ?? null, st.height ?? null]);
  } else if (st.status === 'failed') {
    await db.query(`UPDATE videos SET status='rejected', error=$2 WHERE id=$1 AND status IN ('uploading','processing')`, [videoId, st.error ?? 'Processing failed']);
    await db.query(`UPDATE feed_items SET status='removed' WHERE item_type='post' AND item_id IN (SELECT id FROM posts WHERE video_id=$1)`, [videoId]);
    await db.query(`UPDATE posts SET status='removed' WHERE video_id=$1`, [videoId]);
    await db.query(`UPDATE stories SET status='removed' WHERE video_id=$1`, [videoId]);
  }
}

async function processLocal(id: string) {
  const maxS = Number(await setting('video.max_seconds', 90));
  const st = await localProvider().process(id, maxS);
  const video = (await pool.query('SELECT bytes FROM videos WHERE id=$1', [id])).rows[0];
  void video;
  await applyVideoStatus(pool, id, st);
}

async function owned(id: string, me: string) {
  const v = (await pool.query('SELECT * FROM videos WHERE id=$1 AND owner_id=$2', [id, me])).rows[0];
  if (!v || v.status === 'removed') throw notFound('Video');
  return v;
}

videos.post('/videos', requireAuth, limiter, wrap(async (req, res) => {
  const b = z.object({ title: z.string().trim().max(120).optional(), bytes: z.number().int().positive().optional() }).parse(req.body ?? {});
  const maxMb = Number(await setting('video.max_mb', 200));
  if (b.bytes && b.bytes > maxMb * 1024 * 1024) throw new HttpError(413, `Videos must be under ${maxMb} MB`, 'too_large');
  const provider = defaultProvider(); const id = crypto.randomUUID();
  const { providerVideoId, upload } = await provider.createUpload({ id, title: b.title || 'twiqo video' });
  await pool.query(`INSERT INTO videos(id,owner_id,provider,provider_video_id,title,bytes) VALUES ($1,$2,$3,$4,$5,$6)`, [id, req.user!.id, provider.name, providerVideoId, b.title ?? null, b.bytes ?? null]);
  res.status(201).json({ id, status: 'uploading', upload, max_mb: maxMb, max_seconds: Number(await setting('video.max_seconds', 90)) });
}));

// local provider: the browser PUTs the file to us; we stream it to disk (never into memory) and transcode in the background
videos.put('/videos/:id/upload', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const v = await owned(id, req.user!.id);
  if (v.provider !== 'local') throw badRequest('This upload goes directly to the video provider');
  if (v.status !== 'uploading') throw conflict('This video was already uploaded');
  const maxBytes = Number(await setting('video.max_mb', 200)) * 1024 * 1024;
  const file = localProvider().uploadPath(id); let size = 0; let aborted = false;
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    req.on('data', (c: Buffer) => { size += c.length; if (size > maxBytes && !aborted) { aborted = true; req.unpipe(out); out.destroy(); fs.rm(file, { force: true }, () => {}); reject(new HttpError(413, `Videos must be under ${maxBytes / 1024 / 1024} MB`, 'too_large')); } });
    req.pipe(out); out.on('finish', () => !aborted && resolve()); out.on('error', reject); req.on('error', reject);
  });
  if (size === 0) throw badRequest('The file was empty');
  await pool.query(`UPDATE videos SET status='processing', bytes=$2 WHERE id=$1`, [id, size]);
  void processLocal(id).catch((e) => { console.error('video processing crashed', e); void applyVideoStatus(pool, id, { status: 'failed', error: 'Processing failed' }); });
  res.status(202).json({ id, status: 'processing' });
}));

// Bunny: the browser uploads straight to Bunny over TUS, then tells us it finished
videos.post('/videos/:id/uploaded', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const v = await owned(id, req.user!.id);
  if (v.status === 'uploading') await pool.query(`UPDATE videos SET status='processing' WHERE id=$1`, [id]);
  res.status(202).json({ id, status: 'processing' });
}));

videos.get('/videos/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); let v = await owned(id, req.user!.id);
  if (v.provider === 'bunny' && v.status === 'processing') {
    try { await applyVideoStatus(pool, id, await providerByName('bunny').refresh(v)); v = await owned(id, req.user!.id); } catch (e) { console.error('bunny status check failed', (e as Error).message); }
  }
  res.json(videoView(v));
}));

// Bunny calls this when encoding changes. We never trust the payload: we ask Bunny for the real status.
videos.post('/videos/webhook/bunny', wrap(async (req, res) => {
  const given = String(req.query.secret ?? ''); const want = config.BUNNY_WEBHOOK_SECRET ?? '';
  if (!want || given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) throw new HttpError(401, 'Invalid webhook secret', 'unauthorized');
  const guid = z.object({ VideoGuid: z.string().min(8) }).parse(req.body).VideoGuid;
  const v = (await pool.query(`SELECT * FROM videos WHERE provider='bunny' AND provider_video_id=$1`, [guid])).rows[0];
  if (v && v.status !== 'removed') await applyVideoStatus(pool, v.id, await providerByName('bunny').refresh(v));
  res.status(200).json({ ok: true });
}));

videos.delete('/videos/:id', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const v = await owned(id, req.user!.id);
  const used = await pool.query(`SELECT 1 FROM posts WHERE video_id=$1 AND status <> 'removed' UNION ALL SELECT 1 FROM stories WHERE video_id=$1 AND status='active'`, [id]);
  if (used.rowCount) throw conflict('This video is used by a post or story. Delete that first.');
  await pool.query(`UPDATE videos SET status='removed' WHERE id=$1`, [id]);
  await providerByName(v.provider).remove(v).catch((e) => console.error('provider delete failed', (e as Error).message));
  res.status(204).end();
}));
