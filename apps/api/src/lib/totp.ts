import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = (buf: Buffer) => { let bits = 0, v = 0, out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; };
export const unbase32 = (s: string) => { let bits = 0, v = 0; const out: number[] = []; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
export const newTotpSecret = () => base32(crypto.randomBytes(20));

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) so it works with Google Authenticator, 1Password, Authy etc. */
export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
export const currentStep = (now = Date.now()) => Math.floor(now / 30_000);
/** Returns the matching step (within one step either side for clock drift) or null. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const s = currentStep(now);
  for (const d of [0, -1, 1]) { const a = Buffer.from(totpAt(secret, s + d)); if (crypto.timingSafeEqual(a, Buffer.from(code))) return s + d; }
  return null;
}
export const otpauthUrl = (secret: string, account: string) => `otpauth://totp/twiqo:${encodeURIComponent(account)}?secret=${secret}&issuer=twiqo&algorithm=SHA1&digits=6&period=30`;
