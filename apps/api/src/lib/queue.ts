import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

/** Small Postgres-backed job queue: durable, retried with backoff, safe with several workers (FOR UPDATE SKIP LOCKED). */
type Handler = (payload: any, job: { id: number; attempts: number }) => Promise<void>;
const handlers = new Map<string, Handler>();
export const registerJob = (kind: string, h: Handler) => { handlers.set(kind, h); };

export async function enqueue(db: Db, kind: string, payload: Record<string, unknown> = {}, o: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  const r = await db.query(`INSERT INTO jobs(kind,payload,run_at,dedupe_key,max_attempts) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND done_at IS NULL DO NOTHING RETURNING id`,
    [kind, JSON.stringify(payload), o.runAt ?? new Date(), o.dedupeKey ?? null, o.maxAttempts ?? 5]);
  return r.rows[0]?.id as number | undefined;
}

/** Claim and run due jobs. A job locked for more than 10 minutes is treated as crashed and retried. Returns how many ran. */
export async function runQueue(limit = 25, opts: { kinds?: string[] } = {}): Promise<{ ran: number; failed: number }> {
  let ran = 0; let failed = 0;
  for (let i = 0; i < limit; i++) {
    const job = (await pool.query(
      `UPDATE jobs SET locked_at = now(), attempts = attempts + 1 WHERE id = (
         SELECT id FROM jobs WHERE done_at IS NULL AND run_at <= now() AND attempts < max_attempts AND ($1::text[] IS NULL OR kind = ANY($1::text[])) AND (locked_at IS NULL OR locked_at < now() - interval '10 minutes')
         ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, kind, payload, attempts, max_attempts`, [opts.kinds ?? null])).rows[0];
    if (!job) break;
    try {
      const h = handlers.get(job.kind); if (!h) throw new Error(`no handler for job kind "${job.kind}"`);
      await h(job.payload, { id: job.id, attempts: job.attempts });
      await pool.query('UPDATE jobs SET done_at = now(), locked_at = NULL, last_error = NULL WHERE id=$1', [job.id]); ran++;
    } catch (e) {
      failed++;
      const backoff = Math.min(3600, 30 * 2 ** (job.attempts - 1));   // 30s, 1m, 2m, 4m ... capped at 1h
      await pool.query(`UPDATE jobs SET locked_at = NULL, last_error = $2, run_at = now() + ($3 || ' seconds')::interval WHERE id=$1`, [job.id, String((e as Error).message).slice(0, 500), String(backoff)]);
      console.error(`job ${job.id} (${job.kind}) failed attempt ${job.attempts}/${job.max_attempts}:`, (e as Error).message);
    }
  }
  return { ran, failed };
}
