import type { Db } from '../db/pool.js';

/** Write an audit entry. Pass the transaction client so the log commits atomically with the change. */
export async function audit(db: Db, actorId: string | null, action: string, targetType: string | null, targetId: string | null,
  before: unknown = null, after: unknown = null, ip: string | null = null) {
  await db.query(
    `INSERT INTO audit_logs(actor_id, action, target_type, target_id, before, after, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actorId, action, targetType, targetId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), ip]);
}
