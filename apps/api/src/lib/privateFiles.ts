import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { storage } from './storage.js';
import { HttpError } from './errors.js';

/** Sensitive uploads (licences, insurance). Lives next to, not inside, the public /media folder. */
const root = path.join(path.dirname(storage.root), 'private-uploads');
export async function savePrivate(buf: Buffer): Promise<{ key: string; mime: string }> {
  let out: Buffer; let mime: string; let ext: string;
  if (buf.subarray(0, 4).toString() === '%PDF') { out = buf; mime = 'application/pdf'; ext = 'pdf'; }
  else {
    try { out = await sharp(buf, { limitInputPixels: 60_000_000 }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); mime = 'image/jpeg'; ext = 'jpg'; }   // re-encoding also strips EXIF/GPS
    catch { throw new HttpError(422, 'Upload a photo (JPEG, PNG or WebP) or a PDF', 'bad_file'); }
  }
  const key = `${crypto.randomUUID()}.${ext}`; await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, key), out, { mode: 0o600 });
  return { key, mime };
}
export async function readPrivate(key: string): Promise<Buffer> { if (!/^[0-9a-f-]{36}\.(jpg|pdf)$/.test(key)) throw new HttpError(404, 'File not found', 'not_found'); return fs.readFile(path.join(root, key)); }
