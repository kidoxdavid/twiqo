import pg from 'pg';
import { config } from '../config.js';

// Return int8 (counts) as numbers; our counters never approach 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
export type Db = pg.Pool | pg.PoolClient;

/** Run fn in a transaction. Use for every multi-statement or money/inventory write. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
