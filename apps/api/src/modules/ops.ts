import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { requirePermission } from '../lib/auth.js';
import { wrap } from '../lib/errors.js';

export const ops = Router();          // mounted under /api
export const readyRouter = Router();  // mounted at the root for load balancers
const started = Date.now();

/** Everything a load balancer or on-call person needs: is the database reachable, is the job queue keeping up. */
export async function readiness() {
  const t0 = Date.now(); let db = false; let migrations: string | null = null;
  try { await pool.query('SELECT 1'); db = true; migrations = (await pool.query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')).rows[0]?.name ?? null; } catch { /* reported below */ }
  const q = db ? (await pool.query(`SELECT count(*) FILTER (WHERE done_at IS NULL AND run_at <= now() AND attempts < max_attempts)::int AS due, count(*) FILTER (WHERE done_at IS NULL AND attempts >= max_attempts)::int AS dead,
      coalesce(extract(epoch FROM now() - min(run_at) FILTER (WHERE done_at IS NULL AND run_at <= now() AND attempts < max_attempts))::int, 0) AS oldest_due_s FROM jobs`)).rows[0] : null;
  return { ok: db && (q?.oldest_due_s ?? 0) < 600, db, db_latency_ms: Date.now() - t0, latest_migration: migrations, jobs: q, uptime_s: Math.round((Date.now() - started) / 1000), env: config.NODE_ENV };
}
readyRouter.get('/ready', wrap(async (_req, res) => { const r = await readiness(); res.status(r.ok ? 200 : 503).json({ ok: r.ok, db: r.db, jobs_backlog_s: r.jobs?.oldest_due_s ?? null }); }));

ops.get('/admin/system', requirePermission('view.analytics'), wrap(async (_req, res) => {
  const r = await readiness();
  const x = (await pool.query(`SELECT
      (SELECT count(*) FROM outbox_emails WHERE status='queued')::int AS emails_queued, (SELECT count(*) FROM outbox_emails WHERE status='failed')::int AS emails_failed,
      (SELECT count(*) FROM webhook_events WHERE processed_at IS NULL AND received_at < now() - interval '5 minutes')::int AS webhooks_stuck,
      (SELECT count(*) FROM webhook_events WHERE received_at > now() - interval '24 hours')::int AS webhooks_24h,
      (SELECT count(*) FROM refunds WHERE status='failed')::int AS refunds_failed, (SELECT count(*) FROM risk_events WHERE status='open')::int AS risk_open,
      (SELECT count(*) FROM driver_documents WHERE status='pending')::int AS docs_pending, (SELECT count(*) FROM safety_incidents WHERE status='open')::int AS safety_open,
      (SELECT count(*) FROM card_disputes WHERE status IN ('needs_response','warning_needs_response'))::int AS chargebacks_open, (SELECT count(*) FROM disputes WHERE status='open')::int AS disputes_open,
      (SELECT count(*) FROM push_subscriptions)::int AS push_devices`)).rows[0];
  const failing = (await pool.query(`SELECT kind, count(*)::int n, max(last_error) AS last_error FROM jobs WHERE done_at IS NULL AND attempts >= max_attempts GROUP BY kind ORDER BY n DESC LIMIT 10`)).rows;
  const mem = process.memoryUsage();
  res.json({ ...r, providers: { email: config.EMAIL_PROVIDER, payments: config.PAYMENT_PROVIDER, video: config.VIDEO_PROVIDER, push: !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) }, counts: x, failing_jobs: failing, memory_mb: Math.round(mem.rss / 1048576), node: process.version });
}));

/** Blanket limit on writes from one IP, on top of the specific limits on sign-in, messages and so on. */
export const writeLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, skip: (req) => config.RATE_LIMIT_DISABLED === 'true' || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.path.startsWith('/webhooks/'),
  handler: (_req, res) => { res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests. Please slow down and try again in a minute.' } }); } });
