import type { Db } from '../db/pool.js';
import { HttpError } from './errors.js';
import { publish } from './realtime.js';

const NIL = '00000000-0000-0000-0000-000000000000';
export const pairKey = (a: string, b: string) => [a, b].sort().join(':');
export type SubjectType = 'listing' | 'journey' | 'service' | 'transport_request';

export async function assertNotBlocked(db: Db, a: string, b: string) {
  const blk = await db.query(`SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`, [a, b]);
  if (blk.rowCount) throw new HttpError(403, 'You cannot interact with this person', 'blocked');
}

/** Get-or-create the single 1:1 thread for this pair and subject. */
export async function ensureConversation(db: Db, me: string, other: string, subject?: { type: SubjectType; id: string }): Promise<string> {
  const found = await db.query(
    `SELECT id FROM conversations WHERE pair_key=$1 AND coalesce(subject_type,'')=$2 AND coalesce(subject_id,'${NIL}')=$3`,
    [pairKey(me, other), subject?.type ?? '', subject?.id ?? NIL]);
  if (found.rows[0]) return found.rows[0].id;
  const kind = !subject ? 'direct' : subject.type === 'listing' ? 'listing' : 'transport';
  const r = await db.query(`INSERT INTO conversations(kind,subject_type,subject_id,pair_key,created_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT DO NOTHING RETURNING id`, [kind, subject?.type ?? null, subject?.id ?? null, pairKey(me, other), me]);
  if (!r.rows[0]) return (await db.query(`SELECT id FROM conversations WHERE pair_key=$1 AND coalesce(subject_type,'')=$2 AND coalesce(subject_id,'${NIL}')=$3`, [pairKey(me, other), subject?.type ?? '', subject?.id ?? NIL])).rows[0].id;
  await db.query(`INSERT INTO conversation_members(conversation_id,user_id) VALUES ($1,$2),($1,$3)`, [r.rows[0].id, me, other]);
  return r.rows[0].id;
}

/** Structured cards (offers, booking updates) live in message.payload and never masquerade as chat text. */
export async function postCard(db: Db, conversationId: string, senderId: string, kind: 'offer' | 'booking' | 'system', payload: Record<string, unknown>, body?: string) {
  const r = await db.query(`INSERT INTO messages(conversation_id,sender_id,kind,body,payload) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`, [conversationId, senderId, kind, body ?? null, JSON.stringify(payload)]);
  await db.query(`UPDATE conversations SET last_message_at=$2 WHERE id=$1`, [conversationId, r.rows[0].created_at]);
  await db.query(`UPDATE conversation_members SET last_read_at=$3 WHERE conversation_id=$1 AND user_id=$2`, [conversationId, senderId, r.rows[0].created_at]);
  const members = (await db.query(`SELECT user_id FROM conversation_members WHERE conversation_id=$1`, [conversationId])).rows;
  for (const m of members) publish(m.user_id, 'message', { conversation_id: conversationId, message: { id: r.rows[0].id, sender_id: senderId, kind } });
  return r.rows[0];
}
