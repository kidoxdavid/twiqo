import { storage } from './storage.js';

export const mediaUrl = (key: string) => storage.url(key);
export const thumbUrl = (key: string) => storage.url(key.replace(/\.webp$/, '_t.webp'));

export interface AuthorView { id: string; username: string; display_name: string; avatar_url: string | null; verification_level: string }

/** SQL fragment: visible-to-viewer check for rows aliased with author_id/visibility/status. $viewer is a param placeholder (uuid or null). */
export function visibleTo(alias: string, viewer: string) {
  return `(${alias}.status = 'active'
    AND (${alias}.group_id IS NULL OR EXISTS (SELECT 1 FROM groups gg WHERE gg.id = ${alias}.group_id AND gg.status = 'active'))
    AND EXISTS (SELECT 1 FROM users au WHERE au.id = ${alias}.author_id AND au.status = 'active')
    AND (${alias}.visibility = 'public'
      OR ${alias}.author_id = ${viewer}::uuid
      OR (${alias}.visibility = 'group' AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = ${alias}.group_id AND gm.user_id = ${viewer}::uuid AND gm.status = 'active'))
      OR (${alias}.visibility = 'followers' AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${viewer}::uuid AND f.target_type='user' AND f.target_id = ${alias}.author_id)))
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${viewer}::uuid AND b.blocked_id = ${alias}.author_id) OR (b.blocker_id = ${alias}.author_id AND b.blocked_id = ${viewer}::uuid)))`;
}
