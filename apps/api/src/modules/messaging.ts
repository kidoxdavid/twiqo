import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import multer from 'multer';
import { setting } from '../lib/policy.js';
import { saveVoice, voicePath, removeVoice, voiceUrl, verifyVoiceLink } from '../lib/voice.js';
import { enforceVelocity, recordRisk, scanText, CHAT_WARNING_REASONS } from '../lib/risk.js';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { HttpError, badRequest, forbidden, notFound, wrap } from '../lib/errors.js';
import { requireAuth } from '../lib/auth.js';
import { checkText } from '../lib/policy.js';
import { publish, subscribe } from '../lib/realtime.js';
import { thumbUrl, mediaUrl } from '../lib/views.js';
import { assertOwnsMedia } from './content.js';
import { ensureConversation } from '../lib/conversations.js';
import { offerViews } from './offers.js';

export const messaging = Router();
const uuid = z.string().uuid();
const msgLimiter = rateLimit({ windowMs: 60_000, limit: 60, skip: () => config.RATE_LIMIT_DISABLED === 'true', keyGenerator: (r) => r.user?.id ?? ipKeyGenerator(r.ip ?? '0.0.0.0') });

const pairKey = (a: string, b: string) => [a, b].sort().join(':');

async function assertMember(conversationId: string, userId: string) {
  const { rows } = await pool.query(`SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`, [conversationId, userId]);
  if (!rows[0]) throw notFound('Conversation');
}
async function otherMember(conversationId: string, me: string) {
  const { rows } = await pool.query(`SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id<>$2 LIMIT 1`, [conversationId, me]);
  return rows[0]?.user_id as string | undefined;
}
async function assertCanMessage(from: string, to: string) {
  const blk = await pool.query(`SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)`, [from, to]);
  if (blk.rowCount) throw new HttpError(403, 'You cannot message this person', 'blocked');
  const { rows } = await pool.query(`SELECT u.status, p.privacy FROM users u JOIN user_profiles p ON p.user_id=u.id WHERE u.id=$1`, [to]);
  if (!rows[0] || rows[0].status !== 'active') throw notFound('User');
  const mode = rows[0].privacy?.allow_messages ?? 'everyone';
  if (mode === 'nobody') throw new HttpError(403, 'This person is not accepting messages', 'privacy');
  if (mode === 'followers') {
    const f = await pool.query(`SELECT 1 FROM follows WHERE follower_id=$1 AND target_type='user' AND target_id=$2`, [from, to]);
    if (!f.rowCount) throw new HttpError(403, 'This person only accepts messages from their followers', 'privacy');
  }
}

const SUBJECT_OWNER: Record<string, string> = {
  listing: 'SELECT seller_id AS o FROM listings WHERE id=$1', journey: 'SELECT driver_id AS o FROM journeys WHERE id=$1',
  service: 'SELECT provider_id AS o FROM transport_services WHERE id=$1', transport_request: 'SELECT requester_id AS o FROM transport_requests WHERE id=$1',
};
messaging.post('/conversations', requireAuth, wrap(async (req, res) => {
  const b = z.object({ recipient_id: uuid, subject_type: z.enum(['listing', 'journey', 'service', 'transport_request']).optional(), subject_id: uuid.optional(), message: z.string().trim().max(4000).optional() }).parse(req.body);
  const me = req.user!.id;
  if (b.recipient_id === me) throw badRequest('You cannot message yourself');
  if (!!b.subject_type !== !!b.subject_id) throw badRequest('Subject is incomplete');
  await assertCanMessage(me, b.recipient_id);
  await enforceVelocity(pool, me, 'conversation');
  if (b.subject_type) {
    const l = await pool.query(SUBJECT_OWNER[b.subject_type], [b.subject_id]);
    if (!l.rows[0] || l.rows[0].o !== b.recipient_id) throw badRequest('That does not belong to this person');
  }
  const id = await tx((c) => ensureConversation(c, me, b.recipient_id, b.subject_type ? { type: b.subject_type, id: b.subject_id! } : undefined));
  if (b.message) await sendMessage(id, me, { kind: 'text', body: b.message });
  res.status(201).json({ id });
}));

messaging.get('/conversations', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  const { rows } = await pool.query(
    `SELECT c.id, c.kind, c.subject_type, c.subject_id, c.last_message_at,
            o.user_id AS other_id, ou.username, op.display_name, (SELECT storage_key FROM media_assets WHERE id=op.avatar_media_id) AS avatar_key,
            (SELECT json_build_object('body', m.body, 'kind', m.kind, 'sender_id', m.sender_id, 'created_at', m.created_at) FROM messages m WHERE m.conversation_id=c.id AND m.status='active' ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_id<>$1 AND m.status='active' AND m.created_at > cm.last_read_at)::int AS unread,
            coalesce((SELECT title FROM listings WHERE id=c.subject_id AND c.subject_type='listing'), (SELECT title FROM transport_requests WHERE id=c.subject_id AND c.subject_type='transport_request'), (SELECT title FROM transport_services WHERE id=c.subject_id AND c.subject_type='service'), (SELECT origin_city || ' → ' || dest_city FROM journeys WHERE id=c.subject_id AND c.subject_type='journey')) AS listing_title
     FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id
     JOIN conversation_members o ON o.conversation_id=c.id AND o.user_id<>$1
     JOIN users ou ON ou.id=o.user_id JOIN user_profiles op ON op.user_id=o.user_id
     WHERE cm.user_id=$1 AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=o.user_id) OR (b.blocker_id=o.user_id AND b.blocked_id=$1))
     ORDER BY c.last_message_at DESC LIMIT 100`, [me]);
  const search = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
  const items = rows.filter((r) => !search || [r.display_name, r.username, r.listing_title, r.last_message?.body].some((x) => x?.toLowerCase().includes(search)))
    .map((r) => ({ id: r.id, kind: r.kind, subject: r.subject_type ? { type: r.subject_type, id: r.subject_id, title: r.listing_title } : null,
      other: { id: r.other_id, username: r.username, display_name: r.display_name, avatar_url: r.avatar_key ? thumbUrl(r.avatar_key) : null },
      last_message: r.last_message, unread: r.unread, last_message_at: r.last_message_at }));
  res.json({ items });
}));

messaging.get('/conversations/:id/messages', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await assertMember(id, req.user!.id);
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
  const { rows } = await pool.query(
    `SELECT m.id, m.sender_id, m.kind, CASE WHEN m.status='removed' THEN NULL ELSE m.body END AS body, m.payload, m.status, m.created_at, m.flags, m.audio_key, m.audio_ms,
            (SELECT storage_key FROM media_assets WHERE id=m.media_id) AS media_key
     FROM messages m WHERE m.conversation_id=$1 AND ($2::timestamptz IS NULL OR m.created_at < $2) ORDER BY m.created_at DESC LIMIT 50`, [id, before]);
  const other = await otherMember(id, req.user!.id);
  const readAt = other ? (await pool.query(`SELECT last_read_at FROM conversation_members WHERE conversation_id=$1 AND user_id=$2`, [id, other])).rows[0]?.last_read_at : null;
  const offerIds = [...new Set(rows.filter((m) => m.payload?.offer_id).map((m) => m.payload.offer_id as string))];
  const cards = await offerViews(offerIds, req.user!.id);
  res.json({ items: rows.reverse().map((m) => ({ id: m.id, sender_id: m.sender_id, kind: m.kind, body: m.body, payload: m.payload, offer: m.payload?.offer_id ? cards.get(m.payload.offer_id) ?? null : null, removed: m.status === 'removed',
    image_url: m.media_key ? mediaUrl(m.media_key) : null, created_at: m.created_at,
    voice: m.kind === 'voice' && m.status !== 'removed' ? (m.audio_key ? { url: voiceUrl(m.id, req.user!.id), duration_ms: m.audio_ms } : { expired: true, duration_ms: m.audio_ms }) : undefined,
    // only the person receiving a risky message is warned; the sender never learns the heuristics
    warning: m.sender_id !== req.user!.id && m.flags?.length ? 'This message asks you to pay or arrange things outside twiqo. Payments made outside twiqo are not covered by our refund and dispute review. Be careful, and report it if it feels wrong.' : undefined,
    read: m.sender_id === req.user!.id && readAt ? new Date(readAt) >= new Date(m.created_at) : undefined })) });
}));

async function sendMessage(conversationId: string, sender: string, m: { kind: 'text' | 'image' | 'voice'; body?: string; media_id?: string; audio_key?: string; audio_ms?: number }) {
  const other = await otherMember(conversationId, sender);
  if (other) await assertCanMessage(sender, other);
  if (m.kind === 'text') { const flagged = await checkText(m.body); if (flagged) throw new HttpError(422, 'This message breaks our community guidelines', 'policy_violation'); }
  const row = await tx(async (c) => {
    if (m.media_id) await assertOwnsMedia(c, sender, [m.media_id]);
    const flags = m.kind === 'text' ? scanText(m.body).reasons.filter((x) => CHAT_WARNING_REASONS.has(x)) : [];
    const r = await c.query(`INSERT INTO messages(conversation_id,sender_id,kind,body,media_id,flags,audio_key,audio_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`, [conversationId, sender, m.kind, m.body ?? null, m.media_id ?? null, flags, m.audio_key ?? null, m.audio_ms ?? null]);
    if (flags.length) await recordRisk(c, { entityType: 'message', entityId: r.rows[0].id, userId: sender, score: 3, reasons: flags });
    await c.query(`UPDATE conversations SET last_message_at = $2 WHERE id=$1`, [conversationId, r.rows[0].created_at]);
    await c.query(`UPDATE conversation_members SET last_read_at = $3 WHERE conversation_id=$1 AND user_id=$2`, [conversationId, sender, r.rows[0].created_at]);
    return r.rows[0];
  });
  const payload = { conversation_id: conversationId, message: { id: row.id, sender_id: sender, kind: m.kind, body: m.body ?? null, created_at: row.created_at, ...(m.kind === 'voice' ? { duration_ms: m.audio_ms } : {}) } };
  if (other) publish(other, 'message', payload);
  publish(sender, 'message', payload);
  return row;
}

messaging.post('/conversations/:id/messages', requireAuth, msgLimiter, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ kind: z.enum(['text', 'image']).default('text'), body: z.string().trim().min(1).max(4000).optional(), media_id: uuid.optional() })
    .refine((v) => (v.kind === 'text' ? !!v.body : !!v.media_id), 'Message is empty').parse(req.body);
  await assertMember(id, req.user!.id);
  const row = await sendMessage(id, req.user!.id, b);
  res.status(201).json({ id: row.id, created_at: row.created_at });
}));

/** Voice messages: a short recording, checked and re-encoded on the server. Played back through a signed, expiring link that is only handed to members of the conversation. */
const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });
messaging.post('/conversations/:id/voice', requireAuth, msgLimiter, voiceUpload.single('file'), wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); await assertMember(id, req.user!.id);
  if (!req.file) throw badRequest('Record a message first');
  const saved = await saveVoice(req.file.buffer, Number(await setting('voice.max_seconds', 120)));
  try { const row = await sendMessage(id, req.user!.id, { kind: 'voice', audio_key: saved.key, audio_ms: saved.ms }); res.status(201).json({ id: row.id, created_at: row.created_at, duration_ms: saved.ms }); }
  catch (e) { await removeVoice(saved.key).catch(() => undefined); throw e; }   // blocked, rate-limited or similar: don't leave the file behind
}));
messaging.get('/voice/:id', wrap(async (req, res) => {
  const id = uuid.parse(req.params.id); const u = z.object({ u: uuid, exp: z.coerce.number().int(), sig: z.string().min(20).max(80) }).safeParse(req.query);
  if (!u.success || !verifyVoiceLink(id, u.data.u, u.data.exp, u.data.sig)) throw new HttpError(403, 'This link has expired', 'forbidden');
  const m = (await pool.query(`SELECT m.audio_key FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$2 WHERE m.id=$1 AND m.kind='voice' AND m.status='active' AND m.audio_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM blocks b JOIN conversation_members o ON o.conversation_id=m.conversation_id AND o.user_id <> $2 WHERE (b.blocker_id=$2 AND b.blocked_id=o.user_id) OR (b.blocker_id=o.user_id AND b.blocked_id=$2))`, [id, u.data.u])).rows[0];
  if (!m) throw notFound('Voice message');
  const file = voicePath(m.audio_key); const size = (await fs.stat(file)).size; const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  res.set({ 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' });
  if (range && (range[1] || range[2])) {   // Safari and seeking need byte ranges
    const start = range[1] ? parseInt(range[1], 10) : Math.max(0, size - parseInt(range[2], 10)); const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), size - 1) : size - 1;
    if (start > end || start >= size) return void res.status(416).set('Content-Range', `bytes */${size}`).end();
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }); createReadStream(file, { start, end }).pipe(res); return;
  }
  res.set('Content-Length', String(size)); createReadStream(file).pipe(res);
}));

messaging.post('/conversations/:id/read', requireAuth, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await assertMember(id, req.user!.id);
  await pool.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id=$1 AND user_id=$2`, [id, req.user!.id]);
  const other = await otherMember(id, req.user!.id);
  if (other) publish(other, 'read', { conversation_id: id, by: req.user!.id });
  res.status(204).end();
}));

messaging.get('/me/unread', requireAuth, wrap(async (req, res) => {
  const me = req.user!.id;
  const m = await pool.query(
    `SELECT count(*)::int AS n FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$1
     WHERE m.sender_id<>$1 AND m.status='active' AND m.created_at > cm.last_read_at
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=m.sender_id) OR (b.blocker_id=m.sender_id AND b.blocked_id=$1))`, [me]);
  const n = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [me]);
  res.json({ messages: m.rows[0].n, notifications: n.rows[0].n });
}));

// ---- notifications ------------------------------------------------------------------------------------------
messaging.get('/notifications', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.id, n.type, n.target_type, n.target_id, n.data, n.read_at, n.created_at, u.username AS actor_username, p.display_name AS actor_name
     FROM notifications n LEFT JOIN users u ON u.id=n.actor_id LEFT JOIN user_profiles p ON p.user_id=n.actor_id
     WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 50`, [req.user!.id]);
  res.json({ items: rows });
}));
messaging.post('/notifications/read', requireAuth, wrap(async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [req.user!.id]);
  res.status(204).end();
}));

// ---- realtime stream (SSE). EventSource cannot send headers, so the short-lived access token goes in the query string. ----
messaging.get('/events', wrap(async (req, res) => {
  let uid: string;
  try { uid = (jwt.verify(String(req.query.token ?? ''), config.JWT_SECRET) as { sub: string }).sub; } catch { throw new HttpError(401, 'Sign in required', 'unauthorized'); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  subscribe(uid, res);
  const t = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => clearInterval(t));
}));
