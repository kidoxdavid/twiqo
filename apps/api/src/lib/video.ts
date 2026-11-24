import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { storage } from './storage.js';

const run = promisify(execFile);

export type VideoStatus = 'processing' | 'ready' | 'failed';
export interface VideoRef { id: string; provider: 'local' | 'bunny'; provider_video_id: string | null }
export interface ProviderStatus { status: VideoStatus; durationS?: number; width?: number; height?: number; error?: string }
export type UploadInstructions =
  | { type: 'direct'; method: 'PUT'; url: string }
  | { type: 'tus'; endpoint: string; headers: Record<string, string>; expires_at: number };
export interface VideoUrls { hls: string | null; mp4: string | null; poster: string | null }

/** Integration boundary: everything the app needs from a video backend. */
export interface VideoProvider {
  readonly name: 'local' | 'bunny';
  createUpload(v: { id: string; title: string }): Promise<{ providerVideoId: string; upload: UploadInstructions }>;
  refresh(v: VideoRef): Promise<ProviderStatus>;
  urls(v: VideoRef): VideoUrls;
  remove(v: VideoRef): Promise<void>;
}

// --------------------------------------------------------------------------------------------- local ffmpeg
export class LocalVideoProvider implements VideoProvider {
  readonly name = 'local' as const;
  private dir = path.join(storage.root, 'video');
  private tmp = path.join(storage.root, 'video-tmp');
  constructor() { fs.mkdirSync(this.dir, { recursive: true }); fs.mkdirSync(this.tmp, { recursive: true }); }
  async createUpload(v: { id: string }) { return { providerVideoId: v.id, upload: { type: 'direct' as const, method: 'PUT' as const, url: `/api/videos/${v.id}/upload` } }; }
  uploadPath(id: string) { return path.join(this.tmp, `${id}.upload`); }
  async refresh(v: VideoRef): Promise<ProviderStatus> {
    // local processing is driven by process(); this only reports what is on disk
    return fs.existsSync(path.join(this.dir, `${v.id}.mp4`)) ? { status: 'ready' } : { status: 'processing' };
  }
  urls(v: VideoRef): VideoUrls { return { hls: null, mp4: storage.url(`video/${v.id}.mp4`), poster: storage.url(`video/${v.id}.jpg`) }; }
  async remove(v: VideoRef) { await Promise.all([`${v.id}.mp4`, `${v.id}.jpg`].map((f) => fs.promises.rm(path.join(this.dir, f), { force: true }))); await fs.promises.rm(this.uploadPath(v.id), { force: true }); }

  /** Probe, validate, transcode to a phone-friendly H.264/AAC MP4 (max 720×1280, faststart) and cut a poster frame. */
  async process(id: string, maxSeconds: number): Promise<ProviderStatus> {
    const src = this.uploadPath(id);
    try {
      const probe = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src], { timeout: 30_000 });
      const info = JSON.parse(probe.stdout);
      const v = info.streams?.find((s: any) => s.codec_type === 'video');
      if (!v) return { status: 'failed', error: 'That file has no video track' };
      const duration = Number(info.format?.duration ?? v.duration ?? 0);
      if (!(duration > 0)) return { status: 'failed', error: 'Could not read the video length' };
      if (duration > maxSeconds + 0.5) return { status: 'failed', error: `Videos can be at most ${maxSeconds} seconds` };
      const out = path.join(this.dir, `${id}.mp4`); const poster = path.join(this.dir, `${id}.jpg`);
      await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-t', String(maxSeconds), '-vf', "scale=w=720:h=1280:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-map_metadata', '-1', out], { timeout: 10 * 60_000 });
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.min(0.5, duration / 2)), '-i', out, '-frames:v', '1', '-q:v', '4', poster], { timeout: 60_000 });
      const o = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', out])).stdout).streams.find((s: any) => s.codec_type === 'video');
      return { status: 'ready', durationS: Math.round(duration * 100) / 100, width: o.width, height: o.height };
    } catch (e) {
      return { status: 'failed', error: 'That video could not be processed. Try an MP4 or MOV from your phone.' };
    } finally { await fs.promises.rm(src, { force: true }); }
  }
}

// --------------------------------------------------------------------------------------------- Bunny Stream
/**
 * Bunny Stream adapter, written against Bunny's documented Stream API:
 *  - create:  POST https://video.bunnycdn.com/library/{libraryId}/videos        (AccessKey header)
 *  - upload:  TUS resumable upload straight from the browser, authorised by
 *             AuthorizationSignature = sha256(libraryId + apiKey + expire + videoId)
 *  - status:  GET  /library/{libraryId}/videos/{videoId}   (status 4 = finished, 5/6 = failed)
 *  - play:    https://{cdnHostname}/{videoId}/playlist.m3u8  (+ thumbnail.jpg, play_720p.mp4)
 * It has NOT been exercised against a live Bunny account from this repository: run `npm run video:check -w apps/api`
 * with your credentials before relying on it.
 */
export class BunnyVideoProvider implements VideoProvider {
  readonly name = 'bunny' as const;
  private base = 'https://video.bunnycdn.com';
  constructor(private libraryId = config.BUNNY_LIBRARY_ID!, private apiKey = config.BUNNY_API_KEY!, private host = config.BUNNY_CDN_HOSTNAME!) {}
  private async api(method: string, p: string, body?: unknown) {
    const r = await fetch(`${this.base}/library/${this.libraryId}${p}`, { method, headers: { AccessKey: this.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Bunny ${method} ${p} failed: ${r.status}`);
    return r.status === 204 ? null : r.json();
  }
  async ping() { await this.api('GET', '/videos?page=1&itemsPerPage=1'); }
  async createUpload(v: { title: string }) {
    const created = await this.api('POST', '/videos', { title: v.title.slice(0, 120) });
    const guid = created.guid as string;
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const signature = crypto.createHash('sha256').update(`${this.libraryId}${this.apiKey}${expires}${guid}`).digest('hex');
    return { providerVideoId: guid, upload: { type: 'tus' as const, endpoint: `${this.base}/tusupload`, expires_at: expires,
      headers: { AuthorizationSignature: signature, AuthorizationExpire: String(expires), VideoId: guid, LibraryId: this.libraryId } } };
  }
  async refresh(v: VideoRef): Promise<ProviderStatus> {
    const j = await this.api('GET', `/videos/${v.provider_video_id}`);
    if ([5, 6].includes(j.status)) return { status: 'failed', error: 'The video could not be processed' };
    if (j.status === 4) return { status: 'ready', durationS: Number(j.length) || undefined, width: j.width || undefined, height: j.height || undefined };
    return { status: 'processing' };
  }
  urls(v: VideoRef): VideoUrls {
    const b = `https://${this.host}/${v.provider_video_id}`;
    return { hls: `${b}/playlist.m3u8`, mp4: `${b}/play_720p.mp4`, poster: `${b}/thumbnail.jpg` };
  }
  async remove(v: VideoRef) { await this.api('DELETE', `/videos/${v.provider_video_id}`); }
}

// --------------------------------------------------------------------------------------------- registry
let local: LocalVideoProvider | undefined; let bunny: BunnyVideoProvider | undefined;
export const localProvider = () => (local ??= new LocalVideoProvider());
export function providerByName(name: 'local' | 'bunny'): VideoProvider {
  if (name === 'bunny') return (bunny ??= new BunnyVideoProvider());
  return localProvider();
}
export const defaultProvider = () => providerByName(config.VIDEO_PROVIDER);
export const videoUrls = (v: VideoRef): VideoUrls => providerByName(v.provider).urls(v);
