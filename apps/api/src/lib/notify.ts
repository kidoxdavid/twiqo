import type { Db } from '../db/pool.js';
import { publish } from './realtime.js';

export const NOTIFICATION_TYPES: { type: string; label: string }[] = [
  { type: 'follow', label: 'New followers' },
  { type: 'comment', label: 'Comments on my posts and listings' },
  { type: 'reply', label: 'Replies to my comments' },
  { type: 'offer_received', label: 'New offers' },
  { type: 'offer_countered', label: 'Counteroffers' },
  { type: 'offer_accepted', label: 'Offer accepted' },
  { type: 'offer_rejected', label: 'Offer declined or expired' },
  { type: 'booking_update', label: 'Booking, pickup and delivery updates' },
  { type: 'match', label: 'Matching transport opportunities' },
  { type: 'journey_posted', label: 'New journeys from transporters I follow' },
  { type: 'group_invite', label: 'Circle invitations' },
  { type: 'group_activity', label: 'Circle activity (requests, approvals, roles, events)' },
  { type: 'event_reminder', label: 'Event reminders' },
  { type: 'story_reply', label: 'Story views and replies' },
  { type: 'payment_update', label: 'Payments, refunds and payouts' },
  { type: 'dispute_update', label: 'Dispute updates' },
  { type: 'boost_update', label: 'Boost and promotion updates' },
];

/** Create a notification unless the recipient turned that type off or the pair is blocked. Returns true if stored. */
export async function notify(db: Db, n: { userId: string; type: string; actorId?: string | null; targetType?: string; targetId?: string; data?: Record<string, unknown>; dedupeKey?: string }) {
  if (n.actorId && n.actorId === n.userId) return false;
  const pref = await db.query('SELECT enabled FROM notification_preferences WHERE user_id=$1 AND type=$2', [n.userId, n.type]);
  if (pref.rows[0] && pref.rows[0].enabled === false) return false;
  if (n.actorId) {
    const b = await db.query('SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [n.userId, n.actorId]);
    if (b.rowCount) return false;
  }
  const data = { ...(n.data ?? {}), ...(n.dedupeKey ? { dedupe: n.dedupeKey } : {}) };
  if (n.dedupeKey) {
    const d = await db.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND type=$2 AND data->>'dedupe'=$3`, [n.userId, n.type, n.dedupeKey]);
    if (d.rowCount) return false;
  }
  await db.query(`INSERT INTO notifications(user_id,type,actor_id,target_type,target_id,data) VALUES ($1,$2,$3,$4,$5,$6)`,
    [n.userId, n.type, n.actorId ?? null, n.targetType ?? null, n.targetId ?? null, JSON.stringify(data)]);
  publish(n.userId, 'notification', { type: n.type });
  return true;
}
