import type { Db } from '../db/pool.js';

export const RANK: Record<string, number> = { member: 1, moderator: 2, admin: 3, owner: 4 };

export async function membership(db: Db, groupId: string, userId: string | null) {
  if (!userId) return null;
  const r = (await db.query('SELECT role, status FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, userId])).rows[0];
  return (r ?? null) as { role: string; status: string } | null;
}
export const isActive = (m: { status: string } | null) => m?.status === 'active';
export const atLeast = (m: { role: string; status: string } | null, role: string) => isActive(m) && RANK[m!.role] >= RANK[role];
