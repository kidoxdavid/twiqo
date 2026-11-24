import crypto from 'node:crypto';
import { config } from '../config.js';

const key = () => crypto.createHash('sha256').update(`twiqo-field-key:${config.JWT_SECRET}`).digest();
/** AES-256-GCM for small secrets stored in the database (e.g. TOTP seeds). Rotating JWT_SECRET invalidates them, so users re-enrol 2FA. */
export function encryptField(plain: string): string {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
export function decryptField(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
