import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { HttpError } from './errors.js';

/** Configurable content policy (banned_words table). Throws on 'block' terms; returns true when a 'flag' term hit. */
export async function checkText(text: string | null | undefined, db: Db = pool): Promise<boolean> {
  if (!text) return false;
  const { rows } = await db.query(
    `SELECT severity FROM banned_words WHERE position(lower(term::text) in lower($1)) > 0`, [text]);
  if (rows.some((r) => r.severity === 'block')) {
    throw new HttpError(422, 'This content breaks our community guidelines', 'policy_violation');
  }
  return rows.length > 0;
}

export async function setting<T = unknown>(key: string, fallback: T, db: Db = pool): Promise<T> {
  const { rows } = await db.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
  return rows[0] ? (rows[0].value as T) : fallback;
}
