import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { HttpError } from './errors.js';
import { setting } from './policy.js';

export interface Scan { score: number; reasons: string[] }
const RULES: { reason: string; weight: number; re: RegExp }[] = [
  { reason: 'offplatform_payment', weight: 3, re: /(e-?transfer|interac|etransfer)\s*(first|only|upfront|up front|before)|western union|moneygram|gift ?cards?|bitcoin|crypto(currency)?|zelle|cash ?app|wire (me|transfer)|pay (me )?(first|upfront|a deposit|deposit)|deposit (first|upfront)/i },
  { reason: 'shipping_scam', weight: 3, re: /i('m| am) (currently )?(out of (town|the country)|overseas|traveling|travelling)|my (agent|courier|shipper|mover) will|(agent|courier) (will )?(pick ?up|collect)/i },
  { reason: 'phone_number', weight: 2, re: /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/ },
  { reason: 'email_address', weight: 2, re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i },
  { reason: 'external_link', weight: 2, re: /https?:\/\/|www\./i },
  { reason: 'off_app_chat', weight: 2, re: /whats ?app|telegram|signal app|text me|dm me on|snapchat|kik\b/i },
  { reason: 'pressure', weight: 1, re: /act now|urgent(ly)?|today only|limited time|must sell today|first come/i },
];
/** Cheap, explainable heuristics. Never blocks on its own: high scores hold a listing for human review and warn the other person in a chat. */
export function scanText(...parts: (string | null | undefined)[]): Scan {
  const text = parts.filter(Boolean).join('\n'); const reasons: string[] = []; let score = 0;
  for (const r of RULES) if (r.re.test(text)) { reasons.push(r.reason); score += r.weight; }
  return { score: Math.min(10, score), reasons };
}
/** Reasons that justify warning the person who *receives* a chat message. Sharing a phone number is normal when arranging a move, so it is not in this list. */
export const CHAT_WARNING_REASONS = new Set(['offplatform_payment', 'shipping_scam']);

export async function recordRisk(db: Db, e: { entityType: 'listing' | 'message' | 'journey' | 'request' | 'user'; entityId?: string | null; userId?: string | null; score: number; reasons: string[] }) {
  await db.query(`INSERT INTO risk_events(entity_type,entity_id,user_id,score,reasons) VALUES ($1,$2,$3,$4,$5)`, [e.entityType, e.entityId ?? null, e.userId ?? null, e.score, e.reasons]);
}

const isNew = async (db: Db, userId: string) => (await db.query(`SELECT created_at > now() - ($2 || ' hours')::interval AS n FROM users WHERE id=$1`, [userId, String(await setting('risk.new_account_hours', 72, db))])).rows[0]?.n === true;

/** Rate limits that are tighter for brand-new accounts. Throws 429 with a human message. */
export async function enforceVelocity(db: Db, userId: string, kind: 'listing' | 'conversation' | 'offer') {
  const fresh = await isNew(db, userId); const mult = fresh ? 1 : 5;
  const spec = { listing: { key: 'risk.new_listings_per_day', def: 5, sql: `SELECT count(*)::int n FROM listings WHERE seller_id=$1 AND created_at > now() - interval '1 day'`, what: 'listings today' },
    conversation: { key: 'risk.new_conversations_per_hour', def: 15, sql: `SELECT count(*)::int n FROM conversations WHERE created_by=$1 AND created_at > now() - interval '1 hour'`, what: 'new conversations this hour' },
    offer: { key: 'risk.new_offers_per_hour', def: 15, sql: `SELECT count(*)::int n FROM offers WHERE proposer_id=$1 AND created_at > now() - interval '1 hour'`, what: 'offers this hour' } }[kind];
  const limit = Number(await setting(spec.key, spec.def, db)) * mult;
  const n = Number((await db.query(spec.sql, [userId])).rows[0].n);
  if (n >= limit) throw new HttpError(429, `You've reached the limit of ${limit} ${spec.what}${fresh ? ' for a new account' : ''}. Please try again later.`, 'velocity_limit');
}
export const poolDb = pool;
