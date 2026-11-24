import type { Request } from 'express';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { setting } from './policy.js';

export type EventName = 'view' | 'search' | 'share' | 'contact_click' | 'signup' | 'listing_created' | 'offer_made' | 'order_created';

/** Visitors who send Do-Not-Track or Global Privacy Control are not recorded at all. */
export const optedOut = (req: Pick<Request, 'headers'>) => req.headers.dnt === '1' || req.headers['sec-gpc'] === '1';
export const anonIdOf = (req: Pick<Request, 'headers'>) => { const v = req.headers['x-anon-id']; return typeof v === 'string' && /^[a-zA-Z0-9_-]{8,40}$/.test(v) ? v : null; };

/** Record a product event. Never throws: analytics must not break a user action. Views are de-duplicated per person per target for 30 minutes. */
export async function track(db: Db, e: { name: EventName; userId?: string | null; anonId?: string | null; targetType?: string; targetId?: string; props?: Record<string, unknown> }) {
  try {
    if ((await setting('analytics.enabled', true, db)) !== true) return false;
    if (!e.userId && !e.anonId && e.name === 'view') return false;   // can't tell visitors apart, so don't count
    if (e.name === 'view' && e.targetId) {
      const dupe = await db.query(
        `SELECT 1 FROM analytics_events WHERE name='view' AND target_id=$1 AND created_at > now() - interval '30 minutes' AND ((user_id IS NOT NULL AND user_id=$2::uuid) OR (anon_id IS NOT NULL AND anon_id=$3)) LIMIT 1`,
        [e.targetId, e.userId ?? null, e.anonId ?? null]);
      if (dupe.rowCount) return false;
    }
    await db.query(`INSERT INTO analytics_events(user_id,anon_id,name,target_type,target_id,props) VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.userId ?? null, e.userId ? null : e.anonId ?? null, e.name, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.props ?? {})]);
    return true;
  } catch (err) { console.error('analytics failed', (err as Error).message); return false; }
}
export const trackPool = (e: Parameters<typeof track>[1]) => track(pool, e);
