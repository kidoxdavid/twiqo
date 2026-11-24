import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { HttpError, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { storage } from '../lib/storage.js';
import { setting } from '../lib/policy.js';
import { mediaUrl, thumbUrl } from '../lib/views.js';

export const media = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

/** Validate by magic bytes, not by the client's claimed type. */
function sniffImage(b: Buffer): boolean {
  return (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') ||
    b.toString('ascii', 0, 3) === 'GIF' || (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP');
}

media.post('/media', requireAuth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');
  const maxMb = Number(await setting('upload.max_image_mb', 10));
  if (req.file.size > maxMb * 1024 * 1024) throw new HttpError(413, `Images must be under ${maxMb} MB`);
  if (!sniffImage(req.file.buffer)) throw new HttpError(415, 'Only JPEG, PNG, GIF or WebP images are supported right now');
  const id = crypto.randomUUID();
  let main: Buffer, thumb: Buffer, w: number | undefined, h: number | undefined;
  try {
    // Re-encode: strips metadata (incl. GPS EXIF), caps size, never serves the original.
    const img = sharp(req.file.buffer, { limitInputPixels: 60_000_000 }).rotate();
    const out = await img.clone().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    main = out.data; w = out.info.width; h = out.info.height;
    thumb = await img.clone().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
  } catch { throw new HttpError(415, 'That image could not be processed'); }
  const key = `img/${id}.webp`;
  await storage.put(key, main); await storage.put(`img/${id}_t.webp`, thumb);
  await pool.query(`INSERT INTO media_assets(id, owner_id, kind, storage_key, mime, bytes, width, height) VALUES ($1,$2,'image',$3,'image/webp',$4,$5,$6)`,
    [id, req.user!.id, key, main.length, w, h]);
  res.status(201).json({ id, url: mediaUrl(key), thumb_url: thumbUrl(key), width: w, height: h });
}));
