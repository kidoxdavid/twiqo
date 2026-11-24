import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { HttpError } from './errors.js';
import { storage } from './storage.js';

const run = promisify(execFile);
const root = path.join(path.dirname(storage.root), 'private-uploads', 'voice');

/** Recognise what browsers actually record (WebM/Opus from Chrome and Firefox, MP4/AAC from Safari, Ogg, WAV, MP3) by content, not by the claimed type. */
function looksLikeAudio(b: Buffer) {
  if (b.length < 16) return false;
  return (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)            // WebM / Matroska
    || b.subarray(0, 4).toString() === 'OggS' || b.subarray(4, 8).toString() === 'ftyp' || b.subarray(0, 4).toString() === 'RIFF' || b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
}

/** Check, normalise and store a recording. Everything is re-encoded to mono AAC in an .m4a, which plays in every browser, and metadata is stripped. */
export async function saveVoice(buf: Buffer, maxSeconds: number): Promise<{ key: string; ms: number }> {
  if (!looksLikeAudio(buf)) throw new HttpError(422, 'That does not look like an audio recording', 'bad_audio');
  const tmp = path.join(os.tmpdir(), `twiqo-voice-${crypto.randomUUID()}`); const outTmp = `${tmp}.m4a`;
  await fs.writeFile(tmp, buf, { mode: 0o600 });
  try {
    let probe: { streams?: { codec_type: string }[]; format?: { duration?: string } };
    try { probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', tmp], { timeout: 15_000 })).stdout); }
    catch (e: any) { if (e?.code === 'ENOENT') throw new HttpError(503, 'Voice messages are not available on this server right now', 'unavailable'); throw new HttpError(422, 'We could not read that recording', 'bad_audio'); }
    if (!probe.streams?.some((s) => s.codec_type === 'audio')) throw new HttpError(422, 'That recording has no audio', 'bad_audio');
    const seconds = Number(probe.format?.duration ?? 0);
    if (!(seconds >= 0.5)) throw new HttpError(422, 'That recording is too short', 'too_short');
    if (seconds > maxSeconds + 1) throw new HttpError(422, `Voice messages can be up to ${maxSeconds} seconds`, 'too_long');
    try { await run('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-vn', '-map_metadata', '-1', '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-ar', '32000', '-movflags', '+faststart', outTmp], { timeout: 30_000 }); }
    catch { throw new HttpError(422, 'We could not process that recording', 'bad_audio'); }
    const key = `${crypto.randomUUID()}.m4a`; await fs.mkdir(root, { recursive: true }); await fs.copyFile(outTmp, path.join(root, key)); await fs.chmod(path.join(root, key), 0o600);
    return { key, ms: Math.min(125_000, Math.round(seconds * 1000)) };
  } finally { await fs.rm(tmp, { force: true }); await fs.rm(outTmp, { force: true }); }
}
export const voicePath = (key: string) => { if (!/^[0-9a-f-]{36}\.m4a$/.test(key)) throw new HttpError(404, 'Not found', 'not_found'); return path.join(root, key); };
export const removeVoice = (key: string) => fs.rm(voicePath(key), { force: true });

// Signed, expiring links so a plain <audio> element can play a private recording (it cannot send an Authorization header).
const sig = (messageId: string, userId: string, exp: number) => crypto.createHmac('sha256', config.JWT_SECRET).update(`voice:${messageId}:${userId}:${exp}`).digest('base64url');
export function voiceUrl(messageId: string, userId: string, ttlSeconds = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds; return `/api/voice/${messageId}?u=${userId}&exp=${exp}&sig=${sig(messageId, userId, exp)}`;
}
export function verifyVoiceLink(messageId: string, userId: string, exp: number, given: string) {
  if (!(exp > Math.floor(Date.now() / 1000))) return false; const want = Buffer.from(sig(messageId, userId, exp)); const got = Buffer.from(given); return want.length === got.length && crypto.timingSafeEqual(want, got);
}
