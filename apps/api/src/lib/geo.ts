import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

/** ~0.05° ≈ 5 km grid. Public geometry is always snapped so exact addresses can't leak. */
const GRID = 0.05;
export const snap = (v: number) => Math.round(v / GRID) * GRID;

export interface Place { city: string; province: string; lng: number; lat: number }

export async function resolvePlace(city: string, province?: string, db: Db = pool): Promise<Place | null> {
  const { rows } = await db.query(
    `SELECT city, province, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
     FROM places WHERE lower(city) = lower($1) AND ($2::text IS NULL OR province = upper($2)) ORDER BY city LIMIT 1`,
    [city, province ?? null]);
  return rows[0] ?? null;
}

/** SQL expression for a snapped geography point from two numeric params. */
export const pointSql = (lngParam: string, latParam: string) =>
  `ST_SetSRID(ST_MakePoint(round(${lngParam}::numeric/0.05)*0.05, round(${latParam}::numeric/0.05)*0.05), 4326)::geography`;
