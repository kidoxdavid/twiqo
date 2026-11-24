import crypto from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { registerJob, enqueue } from './queue.js';
import { queueEmail } from './email.js';
import { describeNotification, DEFAULT_EMAIL, DEFAULT_PUSH } from './notifText.js';
import { pushSender } from './push.js';
import { setting } from './policy.js';

const webOrigin = () => config.WEB_ORIGIN.split(',')[0];
const sig = (userId: string) => crypto.createHmac('sha256', config.JWT_SECRET).update(`unsub:${userId}`).digest('base64url');
export const unsubscribeToken = (userId: string) => `${Buffer.from(userId).toString('base64url')}.${sig(userId)}`;
export function readUnsubscribeToken(t: string): string | null {
  const [a, b] = t.split('.'); if (!a || !b) return null; let id: string; try { id = Buffer.from(a, 'base64url').toString(); } catch { return null; }
  const want = Buffer.from(sig(id)); const got = Buffer.from(b); return want.length === got.length && crypto.timingSafeEqual(want, got) ? id : null;
}
export const unsubscribeUrl = (userId: string) => `${config.PUBLIC_URL}/api/email/unsubscribe?t=${unsubscribeToken(userId)}`;

/** Effective channel setting: the person's explicit choice, else the default for this type. */
export async function channelEnabled(db: Db, userId: string, type: string, channel: 'email' | 'push') {
  const r = (await db.query('SELECT enabled FROM notification_channels WHERE user_id=$1 AND type=$2 AND channel=$3', [userId, type, channel])).rows[0];
  return r ? (r.enabled as boolean) : (channel === 'email' ? DEFAULT_EMAIL : DEFAULT_PUSH).has(type);
}

registerJob('deliver_notification', async ({ id }) => {
  const n = (await pool.query(
    `SELECT n.id, n.user_id, n.type, n.target_type, n.target_id, n.data, p.display_name AS actor_name, u.email, u.locale, u.email_verified_at, u.email_notifications_off, u.status
     FROM notifications n JOIN users u ON u.id=n.user_id LEFT JOIN user_profiles p ON p.user_id=n.actor_id WHERE n.id=$1`, [id])).rows[0];
  if (!n || n.status !== 'active') return;
  const text = describeNotification(n, n.locale);
  const url = `${webOrigin()}${text.url}`;
  const sender = pushSender();
  if (sender.enabled && (await channelEnabled(pool, n.user_id, n.type, 'push'))) {
    const subs = (await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1 AND failures < 5', [n.user_id])).rows;
    for (const s of subs) {
      try { const r = await sender.send(s, { title: text.title, body: text.body, url: text.url, tag: `${n.type}:${n.target_id ?? n.id}` });
        if (r === 'gone') await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]); else await pool.query('UPDATE push_subscriptions SET last_success_at=now(), failures=0 WHERE id=$1', [s.id]);
      } catch (e) { await pool.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id=$1', [s.id]); console.error('push failed', (e as Error).message); }
    }
  }
  if (n.email_verified_at && !n.email_notifications_off && (await channelEnabled(pool, n.user_id, n.type, 'email'))) {
    const recent = await pool.query(`SELECT 1 FROM outbox_emails WHERE user_id=$1 AND template='notification' AND subject=$2 AND created_at > now() - interval '10 minutes' LIMIT 1`, [n.user_id, text.title]);
    if (!recent.rowCount) await queueEmail(pool, { userId: n.user_id, to: n.email, template: 'notification', locale: n.locale, vars: { subject: text.title, body: text.body || text.title, url }, unsubscribeUrl: unsubscribeUrl(n.user_id) });
  }
});

/** One email for people who have unread notifications and haven't opened twiqo for a while. At most one per 24 hours. */
export async function sendDigests() {
  if ((await setting('notifications.digest_enabled', true)) !== true) return 0;
  const users = (await pool.query(
    `SELECT u.id, u.email, u.locale, count(n.id)::int AS unread FROM users u JOIN notifications n ON n.user_id=u.id AND n.read_at IS NULL AND n.created_at > now() - interval '48 hours'
     WHERE u.status='active' AND u.email_verified_at IS NOT NULL AND NOT u.email_notifications_off AND coalesce(u.last_seen_at, u.created_at) < now() - interval '12 hours'
       AND NOT EXISTS (SELECT 1 FROM outbox_emails o WHERE o.user_id=u.id AND o.template='digest' AND o.created_at > now() - interval '24 hours')
     GROUP BY u.id HAVING count(n.id) >= 1 LIMIT 200`)).rows;
  for (const u of users) {
    const items = (await pool.query(`SELECT n.type, n.target_type, n.target_id, n.data, p.display_name AS actor_name FROM notifications n LEFT JOIN user_profiles p ON p.user_id=n.actor_id WHERE n.user_id=$1 AND n.read_at IS NULL ORDER BY n.created_at DESC LIMIT 5`, [u.id])).rows;
    const lines = items.map((i) => { const t = describeNotification(i, u.locale); return `• ${t.title}${t.body ? ` — ${t.body}` : ''}`; }).join('\n');
    await queueEmail(pool, { userId: u.id, to: u.email, template: 'digest', locale: u.locale, vars: { count: u.unread, lines, url: `${webOrigin()}/notifications` }, unsubscribeUrl: unsubscribeUrl(u.id) });
  }
  return users.length;
}
void enqueue;
